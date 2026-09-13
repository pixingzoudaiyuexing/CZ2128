const fs = require('fs');
let code = fs.readFileSync('tests/ai-handoff.test.ts', 'utf8');

const targetTest1 = `  // 7. operator after generation before visible send cancels result
  it('operator after generation before visible send cancels result', async () => {
    env.DB.tables.conversations.push({ id: 'c7', ai_mode: 'ENABLED', ai_handoff_epoch: 0 });
    env.hooks.beforeAiDispatchPreflight = async () => { await pauseOperator(env, 'c7'); };

    const p = handleQueueEvent({ source: 'internal', type: 'ai_trigger', eventId: 'ai_op_2', payload: { convId: 'c7', messageId: 'm1' } }, env);
    await new Promise(r => setTimeout(r, 10));
    resolveAi('Resp');
    try { await p; } catch (e) {}
    
    expect(counts.chatwoot).toBe(0);
    expect(env.DB.tables.ai_runs[0].status).toBe('CANCELLED_BY_HANDOFF');
  });`;

const replaceTest1 = `  // 7. operator after generation before visible send cancels all delivery
  it('operator after generation before visible send cancels all delivery', async () => {
    env.DB.tables.conversations.push({ id: 'c7', ai_mode: 'ENABLED', ai_handoff_epoch: 0, operator_thread_ref: '123' });
    env.hooks.beforeAiDispatchPreflight = async () => { await pauseOperator(env, 'c7'); };

    const p = handleQueueEvent({ source: 'internal', type: 'ai_trigger', eventId: 'ai_op_2', payload: { convId: 'c7', messageId: 'm1' } }, env);
    await new Promise(r => setTimeout(r, 10));
    resolveAi('Resp');
    try { await p; } catch (e) {}
    
    expect(counts.chatwoot).toBe(0);
    expect(counts.telegram).toBe(0); // AI mirror send = 0
    expect(env.DB.tables.ai_runs[0].status).toBe('CANCELLED_BY_HANDOFF');

    const replyOp = env.DB.tables.outbound_operations.find(x => x.id === 'ai_reply:ai_op_2');
    expect(replyOp.status).toBe('FAILED_FINAL');

    const tgOp = env.DB.tables.outbound_operations.find(x => x.id === 'ai_tg_mirror:ai_op_2');
    expect(tgOp).toBeUndefined(); // operation must NOT be created/SENT
  });

  it('non-SENT Chatwoot does not mirror', async () => {
    env.DB.tables.conversations.push({ id: 'c7_non_sent', ai_mode: 'ENABLED', ai_handoff_epoch: 0, operator_thread_ref: '123' });
    
    // Force the network call for chatwoot to fail with an AMBIGUOUS timeout error
    let fetchCalled = false;
    global.fetch = vi.fn().mockImplementation((async (url: any, init: any) => {
      const s = String(url);
      if (s.includes('ai')) { 
        counts.ai++; 
        return { ok: true, json: async () => ({ choices: [{ message: { content: 'AI' } }], id: 200 }) };
      }
      if (s.includes('chatwoot')) { 
        counts.chatwoot++; 
        fetchCalled = true;
        throw new Error('Timeout or Ambiguous Network Error'); 
      }
      if (s.includes('telegram')) { counts.telegram++; return { ok: true, json: async () => ({ id: 100, result: { message_id: 100, message_thread_id: 100 } }) }; }
      return { ok: true, json: async () => ({ id: 100 }) };
    }) as any);

    try { await handleQueueEvent({ source: 'internal', type: 'ai_trigger', eventId: 'ai_non_sent', payload: { convId: 'c7_non_sent', messageId: 'm1' } }, env); } catch (e) {}
    
    expect(fetchCalled).toBe(true);
    expect(counts.telegram).toBe(0); // Telegram mirror callback count = 0
    
    const replyOp = env.DB.tables.outbound_operations.find(x => x.id === 'ai_reply:ai_non_sent');
    expect(replyOp.status).not.toBe('SENT');

    const tgOp = env.DB.tables.outbound_operations.find(x => x.id === 'ai_tg_mirror:ai_non_sent');
    expect(tgOp).toBeUndefined();
  });`;

code = code.replace(targetTest1, replaceTest1);
fs.writeFileSync('tests/ai-handoff.test.ts', code);
