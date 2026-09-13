import { Env } from '../index';
import { SupportEvent } from '../core/events';
import { Conversation } from '../core/domain';
import { getAIConfig } from '../config/ai';
import { checkAutoResume, acquireGenerationLease, verifyGenerationLease, verifyHandoffEpoch, releaseGenerationLease, getDurableAiRun, saveDurableAiRun } from '../core/ai-state';
import { buildAIContext } from '../core/ai-context';
import { generateChatCompletion } from '../adapters/ai/openai-compatible';
import { logger } from '../observability/logger';
import { executeOutboundOperation } from '../core/outbound-operations';
import { insertMessage } from '../core/conversation-service';
import { createChatwootMessage } from '../adapters/chatwoot/api';
import { sendTelegramMessage } from '../adapters/telegram/api';

export async function processAiTrigger(event: SupportEvent, env: Env): Promise<void> {
  const config = getAIConfig(env);
  if (!config.enabled) {
    logger.info('AI is disabled or unconfigured, dropping trigger', { source_event_ref: event.eventId });
    return;
  }

  const { convId, messageId, content } = event.payload;
  const stableAiJobId = event.eventId; // e.g. ai_trigger:convId:messageId

  let conv = await env.DB.prepare('SELECT * FROM conversations WHERE id = ?').bind(convId).first<any>();
  if (!conv) return;

  const resumed = await checkAutoResume(env, conv);
  if (resumed) {
    conv = await env.DB.prepare('SELECT * FROM conversations WHERE id = ?').bind(convId).first<any>();
  }

  if (conv!.ai_mode !== 'ENABLED') {
    logger.info('AI is paused, dropping trigger', { conversation_id: convId });
    return;
  }

  const existingRun = await getDurableAiRun(env, stableAiJobId);
  let aiContent: string;
  let responseId: string;
  let generationId: string;
  let handoffEpoch: number;

  if (existingRun && existingRun.status === 'SUCCESS' && existingRun.response_text) {
    logger.info('Found existing durable AI run, skipping generation', { conversation_id: convId, operation_id: stableAiJobId });
    aiContent = existingRun.response_text;
    responseId = existingRun.provider_response_ref || `ai_res_fallback_${stableAiJobId}`;
    generationId = existingRun.generation_id;
    handoffEpoch = existingRun.handoff_epoch;
  } else {
    const lease = await acquireGenerationLease(env, convId, messageId);
    if (!lease.success) {
      logger.warn('Failed to acquire AI generation lease (AI paused?)', { conversation_id: convId, source_event_ref: event.eventId });
      return; 
    }

    generationId = lease.generationId!;
    handoffEpoch = lease.handoffEpoch!;
    const startTime = Date.now();

    try {
      await saveDurableAiRun(env, stableAiJobId, convId, messageId, generationId, handoffEpoch, 'PENDING');

      const messages = await buildAIContext(env, convId, config);
      const result = await generateChatCompletion(config, messages);

      if (!result.success) {
        logger.error('AI provider failure', result.error, { conversation_id: convId, operation_id: generationId });
        await saveDurableAiRun(env, stableAiJobId, convId, messageId, generationId, handoffEpoch, 'FAILED', undefined, undefined, result.error);
        throw new Error(`AI Provider Failed: ${result.error}`);
      }

      const isValid = await verifyGenerationLease(env, convId, generationId);
      if (!isValid) {
        logger.warn('AI result discarded because generation lease was invalidated', { conversation_id: convId, operation_id: generationId });
        await saveDurableAiRun(env, stableAiJobId, convId, messageId, generationId, handoffEpoch, 'DISCARDED_STALE');
        return;
      }

      aiContent = result.content!;
      responseId = result.responseId || `ai_res_${stableAiJobId}`;

      await saveDurableAiRun(env, stableAiJobId, convId, messageId, generationId, handoffEpoch, 'SUCCESS', responseId, aiContent);

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
  await executeOutboundOperation(
    env,
    convId,
    'chatwoot',
    'SEND_MESSAGE',
    async (opId) => {
      // FINAL PREFLIGHT GUARD: Ensure AI is still ENABLED and epoch matches
      const isEpochValid = await verifyHandoffEpoch(env, convId, handoffEpoch);
      if (!isEpochValid) {
        await saveDurableAiRun(env, stableAiJobId, convId, messageId, generationId, handoffEpoch, 'CANCELLED_BY_HANDOFF');
        logger.warn('AI result permanently cancelled by human handoff before delivery', { conversation_id: convId, operation_id: generationId });
        throw new Error('CANCELLED_BY_HANDOFF'); // Expected to abort outbound immediately
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
