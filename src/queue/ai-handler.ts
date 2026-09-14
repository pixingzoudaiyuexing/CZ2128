import { Env } from '../config/env';
import { AiTriggerEvent } from '../core/events';
import { Conversation } from '../core/domain';
import { getAIConfig } from '../config/ai';
import { checkAutoResume, acquireGenerationLease, verifyGenerationLease, verifyHandoffEpoch, releaseGenerationLease, getDurableAiRun, saveDurableAiRun, saveGeneratedAiResult } from '../core/ai-state';
import { buildAIContext } from '../core/ai-context';
import { generateChatCompletion } from '../adapters/ai/openai-compatible';
import { logger } from '../observability/logger';
import { executeOutboundOperation } from '../core/outbound-operations';
import { insertMessage } from '../core/conversation-service';
import { createChatwootMessage } from '../adapters/chatwoot/api';
import { sendTelegramMessage } from '../adapters/telegram/api';
import { CancelledBeforeDeliveryError, RetryableProcessingError, SafeError } from '../core/errors';

export async function processAiTrigger(event: AiTriggerEvent, env: Env): Promise<void> {
  const config = getAIConfig(env);
  if (!config.enabled) {
    logger.info('AI is disabled or unconfigured, dropping trigger', { source_event_ref: event.eventId });
    return;
  }

  const { convId, messageId } = event.payload;
  const stableAiJobId = event.eventId; // e.g. ai_trigger:convId:messageId

  let conv = await env.DB.prepare('SELECT * FROM conversations WHERE id = ?').bind(convId).first<any>();
  if (!conv) return;

  const resumed = await checkAutoResume(env, conv);
  if (resumed) {
    conv = await env.DB.prepare('SELECT * FROM conversations WHERE id = ?').bind(convId).first<any>();
  }

  const existingRun = await getDurableAiRun(env, stableAiJobId);
  if (
    existingRun &&
    (existingRun.conversation_id !== convId || existingRun.trigger_message_ref !== messageId)
  ) {
    throw new Error('AI run identity collision');
  }
  const cancelRun = async (handoffEpoch: number) => {
    await saveDurableAiRun(
      env,
      stableAiJobId,
      convId,
      messageId,
      existingRun?.generation_id || `cancelled:${stableAiJobId}`,
      existingRun?.handoff_epoch ?? handoffEpoch,
      'CANCELLED_BY_HANDOFF'
    );
  };

  if (conv!.ai_mode !== 'ENABLED') {
    await cancelRun(Number(conv!.ai_handoff_epoch || 0));
    logger.info('AI trigger cancelled because AI is paused', { conversation_id: convId });
    return;
  }

  let aiContent: string;
  let responseId: string;
  let generationId: string;
  let handoffEpoch: number;

  if (existingRun) {
    if (existingRun.status === 'SUCCESS' && existingRun.response_text) {
      logger.info('Found existing durable AI run, skipping generation', { conversation_id: convId, operation_id: stableAiJobId });
      aiContent = existingRun.response_text;
      responseId = existingRun.provider_response_ref || `ai_res_fallback_${stableAiJobId}`;
      generationId = existingRun.generation_id;
      handoffEpoch = existingRun.handoff_epoch;
    } else if (existingRun.status === 'CANCELLED_BY_HANDOFF' || existingRun.status === 'DISCARDED_STALE') {
      logger.info('AI run is permanently cancelled by previous handoff, stopping', { conversation_id: convId, operation_id: stableAiJobId });
      return;
    } else {
      // For FAILED or PENDING (expired), allow generating again.
      const lease = await acquireGenerationLease(env, convId, messageId);
      if (!lease.success) {
        await cancelRun(lease.handoffEpoch);
        return;
      }
      generationId = lease.generationId!;
      handoffEpoch = lease.handoffEpoch!;
      await performGeneration();
    }
  } else {
    const lease = await acquireGenerationLease(env, convId, messageId);
    if (!lease.success) {
      await cancelRun(lease.handoffEpoch);
      return;
    }
    generationId = lease.generationId!;
    handoffEpoch = lease.handoffEpoch!;
    await performGeneration();
  }

  async function performGeneration() {
    const startTime = Date.now();
    try {
      const runClaimed = await saveDurableAiRun(
        env, stableAiJobId, convId, messageId, generationId, handoffEpoch, 'PENDING'
      );
      if (!runClaimed) return;

      const messages = await buildAIContext(env, convId, config);
      const result = await generateChatCompletion(config, messages);

      if (!result.success) {
        const providerError = new SafeError(result.error, {
          provider: 'AI_PROVIDER',
          httpStatus: result.httpStatus,
          retryAfterSeconds: result.retryAfterSeconds
        });
        logger.error('AI provider failure', providerError, { conversation_id: convId, operation_id: generationId });
        await saveDurableAiRun(env, stableAiJobId, convId, messageId, generationId, handoffEpoch, 'FAILED', undefined, undefined, result.error);
        if (result.retryable) {
          throw new RetryableProcessingError(result.error, result.retryAfterSeconds ?? 5, {
            provider: 'AI_PROVIDER',
            httpStatus: result.httpStatus
          });
        }
        return;
      }

      const isValid = await verifyGenerationLease(env, convId, generationId);
      if (!isValid) {
        logger.warn('AI result discarded because generation lease was invalidated', { conversation_id: convId, operation_id: generationId });
        await saveDurableAiRun(env, stableAiJobId, convId, messageId, generationId, handoffEpoch, 'DISCARDED_STALE');
        throw new Error('DISCARDED_STALE'); 
      }

      aiContent = result.content!;
      responseId = result.responseId || `ai_res_${stableAiJobId}`;

      if (env.hooks?.beforeAiRunSuccessPersist) {
        await env.hooks.beforeAiRunSuccessPersist(env, convId);
      }
      const resultSaved = await saveGeneratedAiResult(
        env, stableAiJobId, convId, generationId, handoffEpoch, responseId, aiContent
      );
      if (!resultSaved) {
        await saveDurableAiRun(
          env, stableAiJobId, convId, messageId, generationId, handoffEpoch, 'DISCARDED_STALE'
        );
        throw new Error('DISCARDED_STALE');
      }

      logger.info('AI generation successful, starting outbound delivery', {
        conversation_id: convId,
        operation_id: generationId,
        duration_ms: Date.now() - startTime
      });
    } finally {
      await releaseGenerationLease(env, convId, generationId);
    }
  }

  // Delivery Phase
  // Check if generation returned successfully, or if it was thrown above (e.g. DISCARDED_STALE or FAILED)
  if (!aiContent!) return;

  const chatwootDelivery = await executeOutboundOperation(
    env,
    convId,
    'chatwoot',
    'SEND_MESSAGE',
    async (opId) => {
      // FINAL PREFLIGHT GUARD: Ensure epoch matches
      if (env.hooks && env.hooks.beforeAiDispatchPreflight) await env.hooks.beforeAiDispatchPreflight(env, convId);
      const isEpochValid = await verifyHandoffEpoch(env, convId, handoffEpoch);
      if (!isEpochValid) {
        await saveDurableAiRun(env, stableAiJobId, convId, messageId, generationId, handoffEpoch, 'CANCELLED_BY_HANDOFF');
        logger.warn('AI result permanently cancelled by human handoff before delivery', { conversation_id: convId, operation_id: generationId });
        throw new CancelledBeforeDeliveryError();
      }

      let res;
      if (env.hooks && env.hooks.beforeVisibleSend) {
         res = await env.hooks.beforeVisibleSend(env, conv!.helpdesk_account_ref, conv!.helpdesk_conversation_ref, aiContent, String(opId));
      } else {
         res = await createChatwootMessage(env, conv!.helpdesk_account_ref, conv!.helpdesk_conversation_ref, aiContent, String(opId));
      }
      
      await insertMessage(env, convId, 'ai', responseId, 'OUTBOUND', 'AI', 'TEXT', aiContent);

      return { providerMessageRef: String((res as any).messageId || (res as any).message_id || (res as any).id) };
    },
    `ai_reply:${stableAiJobId}`
  );

  if (conv!.operator_thread_ref) {
    if (chatwootDelivery.status !== 'SENT') {
      logger.info(
        'Skipping Telegram AI mirror because Chatwoot delivery is not confirmed SENT',
        {
          conversation_id: convId,
          operation_id: stableAiJobId,
          result: chatwootDelivery.status
        }
      );
      return;
    }

    await executeOutboundOperation(
      env,
      convId,
      'telegram',
      'SEND_MESSAGE',
      async () => {
        const res = await sendTelegramMessage(env, env.BOT_GROUP_ID, conv!.operator_thread_ref!, `🤖 AI\n\n${aiContent}`);
        return { providerMessageRef: String((res as any).messageId || (res as any).message_id) };
      },
      `ai_tg_mirror:${stableAiJobId}`
    );
  }
}
