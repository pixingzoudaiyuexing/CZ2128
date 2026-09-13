const fs = require('fs');
let code = fs.readFileSync('src/queue/ai-handler.ts', 'utf8');

const targetStr = `  await executeOutboundOperation(
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
        throw new Error('CANCELLED_BY_HANDOFF'); // abort outbound immediately
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
    \`ai_reply:\${stableAiJobId}\`
  );

  if (conv!.operator_thread_ref) {
    await executeOutboundOperation(
      env,
      convId,
      'telegram',
      'SEND_MESSAGE',
      async () => {
        const res = await sendTelegramMessage(env, env.BOT_GROUP_ID, conv!.operator_thread_ref!, \`🤖 AI\\n\\n\${aiContent}\`);
        return { providerMessageRef: String((res as any).messageId || (res as any).message_id) };
      },
      \`ai_tg_mirror:\${stableAiJobId}\`
    );
  }`;

const replaceStr = `  const chatwootDelivery = await executeOutboundOperation(
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
        throw new Error('CANCELLED_BY_HANDOFF'); // abort outbound immediately
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
    \`ai_reply:\${stableAiJobId}\`
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
        const res = await sendTelegramMessage(env, env.BOT_GROUP_ID, conv!.operator_thread_ref!, \`🤖 AI\\n\\n\${aiContent}\`);
        return { providerMessageRef: String((res as any).messageId || (res as any).message_id) };
      },
      \`ai_tg_mirror:\${stableAiJobId}\`
    );
  }`;

code = code.replace(targetStr, replaceStr);
fs.writeFileSync('src/queue/ai-handler.ts', code);
