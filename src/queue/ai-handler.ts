import { Env } from '../index';
import { SupportEvent } from '../core/events';
import { Conversation } from '../core/domain';
import { getAIConfig } from '../config/ai';
import { checkAutoResume, acquireGenerationLease, verifyGenerationLease, releaseGenerationLease, getDurableAiRun, saveDurableAiRun } from '../core/ai-state';
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

  let conv = await env.DB.prepare('SELECT * FROM conversations WHERE id = ?').bind(convId).first<Conversation>();
  if (!conv) return;

  const resumed = await checkAutoResume(env, conv);
  if (resumed) {
    conv = await env.DB.prepare('SELECT * FROM conversations WHERE id = ?').bind(convId).first<Conversation>();
  }

  if (conv!.ai_mode !== 'ENABLED') {
    logger.info('AI is paused, dropping trigger', { conversation_id: convId });
    return;
  }

  // Check if we already have a durable successful run
  const existingRun = await getDurableAiRun(env, stableAiJobId);
  let aiContent: string;
  let responseId: string;
  let generationId: string;

  if (existingRun && existingRun.status === 'SUCCESS' && existingRun.response_text) {
    logger.info('Found existing durable AI run, skipping generation', { conversation_id: convId, operation_id: stableAiJobId });
    aiContent = existingRun.response_text;
    responseId = existingRun.provider_response_ref || `ai_res_fallback_${stableAiJobId}`;
    generationId = existingRun.generation_id;
  } else {
    // Need to generate. Acquire lease.
    // acquireGenerationLease will throw RetryLaterError if locked by another active attempt
    const lease = await acquireGenerationLease(env, convId, messageId);
    if (!lease.success) {
      // Lease not acquired (but didn't throw), might be due to ai_mode change between select and update
      logger.warn('Failed to acquire AI generation lease (AI paused?)', { conversation_id: convId, source_event_ref: event.eventId });
      return; 
    }

    generationId = lease.generationId!;
    const startTime = Date.now();

    try {
      // Mark run as pending
      await saveDurableAiRun(env, stableAiJobId, convId, messageId, generationId, 'PENDING');

      const messages = await buildAIContext(env, convId, config);
      const result = await generateChatCompletion(config, messages);

      if (!result.success) {
        logger.error('AI provider failure', result.error, { conversation_id: convId, operation_id: generationId });
        await saveDurableAiRun(env, stableAiJobId, convId, messageId, generationId, 'FAILED', undefined, undefined, result.error);
        throw new Error(`AI Provider Failed: ${result.error}`);
      }

      // Verify lease before saving result
      const isValid = await verifyGenerationLease(env, convId, generationId);
      if (!isValid) {
        logger.warn('AI result discarded because generation lease was invalidated', { conversation_id: convId, operation_id: generationId });
        await saveDurableAiRun(env, stableAiJobId, convId, messageId, generationId, 'DISCARDED_STALE');
        return;
      }

      aiContent = result.content!;
      responseId = result.responseId || `ai_res_${stableAiJobId}`;

      // Save success durable state BEFORE delivery
      await saveDurableAiRun(env, stableAiJobId, convId, messageId, generationId, 'SUCCESS', responseId, aiContent);

      logger.info('AI generation successful, starting outbound delivery', {
        conversation_id: convId,
        operation_id: generationId,
        duration_ms: Date.now() - startTime
      });
    } finally {
      await releaseGenerationLease(env, convId, generationId);
    }
  }

  // Delivery Phase (Idempotent across retries)
  // 1. Reply to Chatwoot
  await executeOutboundOperation(
    env,
    convId,
    'chatwoot',
    'SEND_MESSAGE',
    async (opId) => {
      // FINAL PREFLIGHT GUARD: Ensure AI is still ENABLED before making external HTTP call
      // Because once we call Chatwoot, the user sees it.
      const currentConv = await env.DB.prepare('SELECT ai_mode FROM conversations WHERE id = ?').bind(convId).first<Conversation>();
      if (!currentConv || currentConv.ai_mode !== 'ENABLED') {
        throw new Error('AI paused right before Chatwoot dispatch. Cancelling outbound.');
      }

      const res = await createChatwootMessage(env, conv!.helpdesk_account_ref, conv!.helpdesk_conversation_ref, aiContent, String(opId));
      
      // Now that it's sent, insert into DB messages context (idempotent due to provider_message_ref constraint)
      await insertMessage(env, convId, 'ai', responseId, 'OUTBOUND', 'AI', 'TEXT', aiContent);

      return { providerMessageRef: String((res as any).messageId || (res as any).message_id || (res as any).id) };
    },
    `ai_reply:${stableAiJobId}`
  );

  // 2. Mirror to Telegram
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
