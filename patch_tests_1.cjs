const fs = require('fs');
let code = fs.readFileSync('tests/ai-handoff.test.ts', 'utf8');

// Fix operator after generation before visible send
code = code.replace(
  /env\.hooks\.beforeVisibleSend = async \(\) => \{\n\s*await pauseOperator\(env, 'c_op_2'\);\n\s*chatwootCalls\+\+;\n\s*return \{ id: 100 \};\n\s*\};/g,
  `env.hooks.beforeAiDispatchPreflight = async () => { await pauseOperator(env, 'c_op_2'); };\n    env.hooks.beforeVisibleSend = async () => { chatwootCalls++; return { id: 100 }; };`
);

// Fix operator pause -> /ai_on -> old result never revives
code = code.replace(
  /env\.hooks\.beforeVisibleSend = async \(\) => \{ \n\s*await pauseOperator\(env, 'c_revive'\); \n\s*return \{ id: 100 \}; \n\s*\};/g,
  `env.hooks.beforeAiDispatchPreflight = async () => { await pauseOperator(env, 'c_revive'); };\n    env.hooks.beforeVisibleSend = async () => { return { id: 100 }; };`
);

code = code.replace(
  /env\.hooks\.beforeVisibleSend = undefined; \/\/ clear hook/g,
  `env.hooks.beforeAiDispatchPreflight = undefined; env.hooks.beforeVisibleSend = undefined; // clear hook`
);

// Fix New Message After /ai_on Works
code = code.replace(
  /env\.hooks\.beforeVisibleSend = async \(\) => \{ \n\s*await pauseOperator\(env, 'c_new'\); \n\s*return \{ id: 100 \}; \n\s*\};/g,
  `env.hooks.beforeAiDispatchPreflight = async () => { await pauseOperator(env, 'c_new'); };\n    env.hooks.beforeVisibleSend = async () => { return { id: 100 }; };`
);

fs.writeFileSync('tests/ai-handoff.test.ts', code);
