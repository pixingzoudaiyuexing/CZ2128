const fs = require('fs');
let code = fs.readFileSync('tests/ai-handoff.test.ts', 'utf8');

// Fix global.fetch mock to always include result for telegram
code = code.replace(
  /return Promise\.resolve\(\{ ok: true, json: async \(\) => \(\{ id: 100 \}\) \}\);/g,
  `return Promise.resolve({ ok: true, json: async () => ({ id: 100, result: { message_id: 100, message_thread_id: 100 } }) });`
);

// Fix New Message After /ai_on Works
code = code.replace(
  /env\.hooks\.beforeAiDispatchPreflight = undefined;/g,
  `env.hooks.beforeAiDispatchPreflight = undefined; env.hooks.beforeVisibleSend = undefined; fetchCalls = 0; fetchResolver = null;`
);

// Fix current customer message appears once
// add await new Promise to wait for locks
code = code.replace(
  /await handleQueueEvent\(\{ source: 'internal', type: 'ai_trigger', eventId: 'ai8'/g,
  `await new Promise(r => setTimeout(r, 10)); await handleQueueEvent({ source: 'internal', type: 'ai_trigger', eventId: 'ai8'`
);

fs.writeFileSync('tests/ai-handoff.test.ts', code);
