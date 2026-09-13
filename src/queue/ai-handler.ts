import { Env } from '../index';
import { SupportEvent } from '../core/events';
import { Conversation } from '../core/domain';
import { getAIConfig } from '../config/ai';
import { checkAutoResume, acquireGenerationLease, verifyGenerationLease, releaseGenerationLease } from '../core/ai-state';
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

  let conv = await env.DB.prepare('SELECT * FROM conversations WHERE id = ?').bind(convId).first<Conversation>();
  if (!conv) return;

  // Check auto resume before acquiring lease
  const resumed = await checkAutoResume(env, conv);
  if (resumed) {
    conv = await env.DB.prepare('SELECT * FROM conversations WHERE id = ?').bind(convId).first<Conversation>();
  }

  if (conv!.ai_mode !== 'ENABLED') {
    logger.info('AI is paused, dropping trigger', { conversation_id: convId });
    return;
  }

  // Acquire generation lease
  const lease = await acquireGenerationLease(env, convId, messageId);
  if (!lease.success) {
    logger.warn('Failed to acquire AI generation lease (active generation running?)', { conversation_id: convId, source_event_ref: event.eventId });
    // Important: we throw here so that the queue retries the trigger in case it's a rapid message
    // However, we only retry if it's bounded. Queue consumer automatically handles bounded retries.
    throw new Error('AI Generation Lease locked');
  }

  const generationId = lease.generationId!;
  const startTime = Date.now();

  try {
    const messages = await buildAIContext(env, convId, config);
    const result = await generateChatCompletion(config, messages);

    if (!result.success) {
      logger.error('AI provider failure', result.error, { conversation_id: convId, generation_id: generationId });
      throw new Error(`AI Provider Failed: ${result.error}`);
    }

    // Verify lease has not been invalidated (e.g. by operator reply)
    const isValid = await verifyGenerationLease(env, convId, generationId);
    if (!isValid) {
      logger.warn('AI result discarded because generation lease was invalidated', { conversation_id: convId, generation_id: generationId });
      return;
    }

    const aiContent = result.content!;
    const responseId = result.responseId!;

    // Save AI message to context
    await insertMessage(env, convId, 'ai', responseId, 'OUTBOUND', 'AI', 'TEXT', aiContent);

    // Reply to Chatwoot
    await executeOutboundOperation(
      env,
      convId,
      'chatwoot',
      'SEND_MESSAGE',
      async () => {
        const res = await createChatwootMessage(env, conv!.helpdesk_account_ref, conv!.helpdesk_conversation_ref, aiContent, `ai:${generationId}`);
        return { providerMessageRef: String(res.messageId) };
      },
      `ai_reply:${generationId}`
    );

    // Mirror to Telegram
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
        `ai_tg_mirror:${generationId}`
      );
    }

    logger.info('AI generation and outbound successful', {
      conversation_id: convId,
      generation_id: generationId,
      duration_ms: Date.now() - startTime
    });

  } finally {
    // Release the lease in all paths
    await releaseGenerationLease(env, convId, generationId);
  }
}
