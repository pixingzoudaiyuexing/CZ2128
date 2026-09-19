import { generateChatCompletion } from '../adapters/ai/openai-compatible';
import { createChatwootMessage } from '../adapters/chatwoot/api';
import { sendTelegramMessage } from '../adapters/telegram/api';
import { getAIConfig } from '../config/ai';
import { Env } from '../config/env';
import { buildAIContext } from '../core/ai-context';
import {
  acquireGenerationLease,
  aiRunRetryDelay,
  cancelDurableAiRunForHandoff,
  cancelOwnedAiRunAfterHandoff,
  checkAutoResume,
  claimDurableAiRun,
  discardOwnedStaleAiRun,
  discardRetryableAiRunAsStale,
  ensureAiRunProviderResponseRef,
  exhaustAiRunWithoutAttempt,
  getDurableAiRun,
  isAiRunTerminal,
  isLatestCustomerTextMessage,
  MAX_AI_GENERATION_ATTEMPTS,
  normalizeLegacyAiRun,
  releaseGenerationLease,
  saveAiGenerationFailure,
  saveGeneratedAiResult,
  saveGeneratedAiResultForLatestTrigger,
  startAiGenerationAttempt,
  verifyHandoffEpoch
} from '../core/ai-state';
import { AiRun, Conversation } from '../core/domain';
import {
  CancelledBeforeDeliveryError,
  RetryableProcessingError,
  SafeError,
  StaleAiTriggerBeforeDeliveryError
} from '../core/errors';
import { AiTriggerEvent } from '../core/events';
import { resolveOutboundDomainState } from '../core/outbound-domain-resolution';
import { buildChatwootTargetEvidence, buildTelegramTargetEvidence } from '../core/outbound-evidence';
import {
  executeOutboundOperation,
  getOutboundOperation,
  prepareOutboundOperation
} from '../core/outbound-operations';
import { isOpenDlqAiRecoveryEvent } from '../core/dlq-ai-redrive';
import { logger } from '../observability/logger';

async function loadConversation(env: Env, convId: string): Promise<Conversation | null> {
  return env.DB.prepare('SELECT * FROM conversations WHERE id = ?').bind(convId).first<Conversation>();
}

function activeGenerationDelay(
  conv: Conversation,
  run: AiRun,
  leaseSeconds: number,
  now: number
): number | null {
  if (
    run.status !== 'PENDING' || !run.generation_id || conv.ai_mode !== 'ENABLED' ||
    conv.ai_generation_id !== run.generation_id || conv.ai_handoff_epoch !== run.handoff_epoch ||
    conv.ai_generation_started_at === null
  ) {
    return null;
  }
  const expiresAt = conv.ai_generation_started_at + leaseSeconds;
  return expiresAt > now ? Math.max(expiresAt - now + 2, 2) : null;
}

async function retireLateGeneration(
  env: Env,
  triggerEventRef: string,
  convId: string,
  generationId: string,
  handoffEpoch: number
): Promise<void> {
  const [run, conv] = await Promise.all([
    getDurableAiRun(env, triggerEventRef),
    loadConversation(env, convId)
  ]);
  if (!run || run.generation_id !== generationId) return;
  if (!conv || conv.ai_mode !== 'ENABLED' || conv.ai_handoff_epoch !== handoffEpoch) {
    await cancelOwnedAiRunAfterHandoff(env, triggerEventRef, generationId);
    return;
  }
  await discardOwnedStaleAiRun(env, triggerEventRef, generationId);
}

async function cancelAttemptStartAfterHandoff(
  env: Env,
  triggerEventRef: string,
  convId: string,
  generationId: string,
  handoffEpoch: number
): Promise<void> {
  const [run, conv] = await Promise.all([
    getDurableAiRun(env, triggerEventRef),
    loadConversation(env, convId)
  ]);
  if (
    run?.generation_id === generationId &&
    (!conv || conv.ai_mode !== 'ENABLED' || conv.ai_handoff_epoch !== handoffEpoch)
  ) {
    await cancelOwnedAiRunAfterHandoff(env, triggerEventRef, generationId);
  }
}

export async function processAiTrigger(event: AiTriggerEvent, env: Env): Promise<void> {
  const config = getAIConfig(env);
  if (env.runtimeConfigSnapshot?.errors.RUNTIME_CONFIG) {
    logger.info('AI runtime configuration is unavailable, dropping trigger', {
      source_event_ref: event.eventId
    });
    return;
  }
  const { convId, messageId } = event.payload;
  const stableAiJobId = event.eventId;
  const isDlqRecovery = await isOpenDlqAiRecoveryEvent(env, event);

  let conv = await loadConversation(env, convId);
  if (!conv) return;

  let existingRun = await getDurableAiRun(env, stableAiJobId);
  if (existingRun) existingRun = await normalizeLegacyAiRun(env, existingRun);
  if (
    existingRun &&
    (existingRun.conversation_id !== convId || existingRun.trigger_message_ref !== messageId)
  ) {
    throw new Error('AI run identity collision');
  }

  if (isDlqRecovery && !await isLatestCustomerTextMessage(env, convId, messageId)) {
    if (existingRun?.status === 'FAILED_RETRYABLE') {
      await discardRetryableAiRunAsStale(env, stableAiJobId);
    } else if (existingRun?.status === 'SUCCESS') {
      const delivered = await getOutboundOperation(env, `ai_reply:${stableAiJobId}`);
      if (delivered?.status === 'SENT') {
        await resolveOutboundDomainState(env, delivered.id);
      }
    }
    logger.info('Historical AI trigger fenced by newer customer text', {
      conversation_id: convId,
      operation_id: stableAiJobId,
      result: existingRun?.status || 'MISSING'
    });
    return;
  }

  if (existingRun && Number(existingRun.handoff_epoch) !== Number(conv.ai_handoff_epoch)) {
    if (existingRun.status === 'PENDING' || existingRun.status === 'FAILED_RETRYABLE') {
      await cancelDurableAiRunForHandoff(
        env,
        stableAiJobId,
        convId,
        messageId,
        existingRun.handoff_epoch
      );
    }
    logger.info('Historical AI trigger fenced by newer handoff epoch', {
      conversation_id: convId,
      operation_id: stableAiJobId,
      result: existingRun.status
    });
    return;
  }

  let aiContent: string | undefined;
  let responseId: string | undefined;
  let generationId: string | null = existingRun?.generation_id || null;
  let handoffEpoch = Number(existingRun?.handoff_epoch ?? conv.ai_handoff_epoch ?? 0);
  const reusedDurableSuccess = existingRun?.status === 'SUCCESS' && existingRun.response_text !== null;

  if (existingRun?.status === 'SUCCESS' && existingRun.response_text !== null) {
    existingRun = await ensureAiRunProviderResponseRef(env, existingRun);
    logger.info('Found existing durable AI run, skipping generation', {
      conversation_id: convId,
      operation_id: stableAiJobId
    });
    aiContent = existingRun.response_text ?? undefined;
    responseId = existingRun.provider_response_ref || `ai_res_${stableAiJobId}`;
  } else {
    if (existingRun && isAiRunTerminal(existingRun.status)) {
      logger.info('AI run is terminal, stopping automatic generation', {
        conversation_id: convId,
        operation_id: stableAiJobId,
        result: existingRun.status
      });
      return;
    }
    if (!config.enabled) {
      logger.info('AI is disabled or unconfigured, dropping trigger', { source_event_ref: event.eventId });
      return;
    }

    const resumed = await checkAutoResume(env, conv);
    if (resumed) conv = await loadConversation(env, convId);
    if (!conv) return;
    if (conv.ai_mode !== 'ENABLED') {
      await cancelDurableAiRunForHandoff(
        env,
        stableAiJobId,
        convId,
        messageId,
        Number(conv.ai_handoff_epoch || 0)
      );
      logger.info('AI trigger cancelled because AI is paused', { conversation_id: convId });
      return;
    }

    if (existingRun) {
      const now = Math.floor(Date.now() / 1000);
      const retryDelay = aiRunRetryDelay(existingRun, now);
      if (retryDelay !== null) {
        throw new RetryableProcessingError(
          existingRun.last_error as any,
          retryDelay,
          { provider: 'AI_PROVIDER' }
        );
      }
      const activeDelay = activeGenerationDelay(conv, existingRun, config.generationLeaseSeconds, now);
      if (activeDelay !== null) {
        throw new RetryableProcessingError('CONCURRENCY_LEASE_HELD', activeDelay);
      }
      if (existingRun.attempt_count >= MAX_AI_GENERATION_ATTEMPTS) {
        await exhaustAiRunWithoutAttempt(env, stableAiJobId);
        return;
      }
    }

    if (env.hooks?.beforeAiLeaseAcquire) {
      await env.hooks.beforeAiLeaseAcquire(env, convId);
    }
    const lease = await acquireGenerationLease(env, convId, messageId);
    if (!lease.success) {
      await cancelDurableAiRunForHandoff(env, stableAiJobId, convId, messageId, lease.handoffEpoch);
      return;
    }
    generationId = lease.generationId;
    handoffEpoch = lease.handoffEpoch;

    try {
      const runClaimed = await claimDurableAiRun(
        env,
        stableAiJobId,
        convId,
        messageId,
        generationId,
        handoffEpoch
      );
      if (!runClaimed) {
        const current = await getDurableAiRun(env, stableAiJobId);
        const currentConversation = await loadConversation(env, convId);
        if (
          current && currentConversation &&
          (current.status === 'PENDING' || current.status === 'FAILED_RETRYABLE') &&
          Number(current.handoff_epoch) !== Number(currentConversation.ai_handoff_epoch)
        ) {
          await cancelDurableAiRunForHandoff(
            env,
            stableAiJobId,
            convId,
            messageId,
            current.handoff_epoch
          );
          return;
        }
        if (current && isAiRunTerminal(current.status)) return;
        const retryDelay = current ? aiRunRetryDelay(current) : null;
        throw new RetryableProcessingError(
          retryDelay === null ? 'CONCURRENCY_CAS_CONFLICT' : current!.last_error as any,
          retryDelay ?? 2,
          retryDelay === null ? {} : { provider: 'AI_PROVIDER' }
        );
      }

      const currentConv = await loadConversation(env, convId);
      if (!currentConv) throw new SafeError('OUTBOUND_PRECONDITION_FAILED');
      const chatwootOperationId = `ai_reply:${stableAiJobId}`;
      const preparedChatwoot = await prepareOutboundOperation(
        env,
        convId,
        'chatwoot',
        'SEND_MESSAGE',
        chatwootOperationId,
        {
          allowCreate: !isDlqRecovery,
          subject: { type: 'AI_RUN', ref: stableAiJobId },
          targetEvidence: await buildChatwootTargetEvidence(
            env,
            currentConv.helpdesk_account_ref,
            currentConv.helpdesk_conversation_ref,
            chatwootOperationId
          )
        }
      );
      if (!preparedChatwoot || preparedChatwoot.status !== 'PENDING') {
        throw new SafeError('OUTBOUND_PRECONDITION_FAILED');
      }

      const messages = await buildAIContext(env, convId, config);
      const attemptCount = await startAiGenerationAttempt(
        env,
        stableAiJobId,
        convId,
        generationId,
        handoffEpoch
      );
      if (attemptCount === null) {
        await cancelAttemptStartAfterHandoff(env, stableAiJobId, convId, generationId, handoffEpoch);
        const current = await getDurableAiRun(env, stableAiJobId);
        if (current && isAiRunTerminal(current.status)) return;
        throw new RetryableProcessingError('CONCURRENCY_CAS_CONFLICT', 2);
      }

      const startTime = Date.now();
      const result = await generateChatCompletion(config, messages);
      if (!result.success) {
        const providerError = new SafeError(result.error, {
          provider: 'AI_PROVIDER',
          httpStatus: result.httpStatus,
          retryAfterSeconds: result.retryAfterSeconds
        });
        logger.error('AI provider failure', providerError, {
          conversation_id: convId,
          operation_id: generationId,
          retry_count: attemptCount
        });
        const failedRun = await saveAiGenerationFailure(
          env,
          stableAiJobId,
          convId,
          generationId,
          handoffEpoch,
          result.error,
          result.retryable,
          result.retryAfterSeconds
        );
        if (!failedRun) {
          await retireLateGeneration(env, stableAiJobId, convId, generationId, handoffEpoch);
          return;
        }
        if (failedRun.status === 'FAILED_RETRYABLE') {
          throw new RetryableProcessingError(
            result.error,
            Math.max(Number(failedRun.next_retry_at) - Math.floor(Date.now() / 1000), 1),
            { provider: 'AI_PROVIDER', httpStatus: result.httpStatus }
          );
        }
        return;
      }

      aiContent = result.content!;
      responseId = result.responseId || `ai_res_${stableAiJobId}`;
      if (env.hooks?.beforeAiRunSuccessPersist) {
        await env.hooks.beforeAiRunSuccessPersist(env, convId);
      }
      const resultSaved = isDlqRecovery
        ? await saveGeneratedAiResultForLatestTrigger(
          env,
          stableAiJobId,
          convId,
          messageId,
          generationId,
          handoffEpoch,
          responseId,
          aiContent
        )
        : await saveGeneratedAiResult(
          env,
          stableAiJobId,
          convId,
          generationId,
          handoffEpoch,
          responseId,
          aiContent
        );
      if (!resultSaved) {
        await retireLateGeneration(env, stableAiJobId, convId, generationId, handoffEpoch);
        aiContent = undefined;
        responseId = undefined;
        return;
      }

      logger.info('AI generation successful, starting outbound delivery', {
        conversation_id: convId,
        operation_id: generationId,
        retry_count: attemptCount,
        duration_ms: Date.now() - startTime
      });
    } finally {
      await releaseGenerationLease(env, convId, generationId);
    }
  }

  if (aiContent === undefined || !responseId) return;

  if (reusedDurableSuccess && !await verifyHandoffEpoch(env, convId, handoffEpoch)) {
    logger.info('Historical durable AI success fenced before outbound recovery', {
      conversation_id: convId,
      operation_id: stableAiJobId
    });
    return;
  }

  const chatwootOperationId = `ai_reply:${stableAiJobId}`;
  const chatwootDelivery = await executeOutboundOperation(
    env,
    convId,
    'chatwoot',
    'SEND_MESSAGE',
    async (opId, lifecycle) => {
      if (env.hooks?.beforeAiDispatchPreflight) {
        await env.hooks.beforeAiDispatchPreflight(env, convId);
      }
      const isEpochValid = await verifyHandoffEpoch(env, convId, handoffEpoch);
      if (!isEpochValid) {
        if (!reusedDurableSuccess) {
          await cancelOwnedAiRunAfterHandoff(env, stableAiJobId, generationId);
        }
        logger.warn('AI result cancelled by human handoff before delivery', {
          conversation_id: convId,
          operation_id: generationId || stableAiJobId
        });
        throw new CancelledBeforeDeliveryError();
      }
      if (isDlqRecovery && !await isLatestCustomerTextMessage(env, convId, messageId)) {
        throw new StaleAiTriggerBeforeDeliveryError();
      }

      const currentConv = await loadConversation(env, convId);
      if (!currentConv) throw new CancelledBeforeDeliveryError();
      const res = env.hooks?.beforeVisibleSend
        ? await env.hooks.beforeVisibleSend(
          env,
          currentConv.helpdesk_account_ref,
          currentConv.helpdesk_conversation_ref,
          aiContent,
          String(opId),
          lifecycle
        )
        : await createChatwootMessage(
          env,
          currentConv.helpdesk_account_ref,
          currentConv.helpdesk_conversation_ref,
          aiContent,
          String(opId),
          lifecycle
        );
      return { providerMessageRef: String((res as any).messageId || (res as any).message_id || (res as any).id) };
    },
    chatwootOperationId,
    {
      allowCreate: !isDlqRecovery,
      subject: { type: 'AI_RUN', ref: stableAiJobId },
      targetEvidence: await buildChatwootTargetEvidence(
        env,
        conv.helpdesk_account_ref,
        conv.helpdesk_conversation_ref,
        chatwootOperationId
      )
    }
  );

  if (chatwootDelivery.status !== 'SENT') {
    logger.info('Skipping Telegram AI mirror because Chatwoot delivery is not confirmed SENT', {
      conversation_id: convId,
      operation_id: stableAiJobId,
      result: chatwootDelivery.status
    });
    if (isDlqRecovery) {
      const currentOperation = await getOutboundOperation(env, chatwootOperationId);
      if (currentOperation?.last_error === 'DISCARDED_STALE') return;
      throw new SafeError('OUTBOUND_PRECONDITION_FAILED');
    }
    return;
  }
  await resolveOutboundDomainState(env, chatwootOperationId);

  conv = await loadConversation(env, convId);
  if (!conv?.operator_thread_ref) return;
  const telegramOperationId = `ai_tg_mirror:${stableAiJobId}`;
  if (isDlqRecovery) {
    const historicalMirror = await getOutboundOperation(env, telegramOperationId);
    if (!historicalMirror) {
      logger.info('Skipping missing historical Telegram AI mirror without target evidence', {
        conversation_id: convId,
        operation_id: stableAiJobId
      });
      return;
    }
    if (['SENDING', 'AMBIGUOUS', 'FAILED_FINAL'].includes(historicalMirror.status)) {
      throw new SafeError('OUTBOUND_PRECONDITION_FAILED');
    }
  }
  const telegramDelivery = await executeOutboundOperation(
    env,
    convId,
    'telegram',
    'SEND_MESSAGE',
    async (_opId, lifecycle) => {
      if (isDlqRecovery && !await isLatestCustomerTextMessage(env, convId, messageId)) {
        throw new StaleAiTriggerBeforeDeliveryError();
      }
      const res = await sendTelegramMessage(
        env,
        env.BOT_GROUP_ID,
        conv!.operator_thread_ref!,
        `🤖 AI\n\n${aiContent}`,
        lifecycle
      );
      return { providerMessageRef: String((res as any).messageId || (res as any).message_id) };
    },
    telegramOperationId,
    {
      allowCreate: !isDlqRecovery,
      subject: { type: 'AI_RUN', ref: stableAiJobId },
      targetEvidence: buildTelegramTargetEvidence(
        env,
        env.BOT_GROUP_ID,
        conv.operator_thread_ref,
        'sendMessage'
      )
    }
  );
  if (isDlqRecovery && telegramDelivery.status !== 'SENT') {
    const currentOperation = await getOutboundOperation(env, telegramOperationId);
    if (
      currentOperation?.last_error === 'DISCARDED_STALE' ||
      currentOperation?.last_error === 'TARGET_IDENTITY_CHANGED'
    ) return;
    throw new SafeError('OUTBOUND_PRECONDITION_FAILED');
  }
}
