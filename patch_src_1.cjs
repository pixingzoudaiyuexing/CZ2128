const fs = require('fs');
let code = fs.readFileSync('src/index.ts', 'utf8');

code = code.replace(
  /export interface Env \{[\s\S]*?hooks\?: \{ beforeVisibleSend\?:/m,
  `export interface Env {\n  hooks?: { beforeAiDispatchPreflight?: (env: Env, convId: string) => Promise<void>; beforeVisibleSend?:`
);

fs.writeFileSync('src/index.ts', code);

let aiHandler = fs.readFileSync('src/queue/ai-handler.ts', 'utf8');
aiHandler = aiHandler.replace(
  /const isEpochValid = await verifyHandoffEpoch\(env, convId, handoffEpoch\);/g,
  `if (env.hooks && env.hooks.beforeAiDispatchPreflight) await env.hooks.beforeAiDispatchPreflight(env, convId);\n      const isEpochValid = await verifyHandoffEpoch(env, convId, handoffEpoch);`
);

fs.writeFileSync('src/queue/ai-handler.ts', aiHandler);
