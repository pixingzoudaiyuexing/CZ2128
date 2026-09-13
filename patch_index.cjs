const fs = require('fs');
let code = fs.readFileSync('src/index.ts', 'utf8');

code = code.replace(
  /export interface Env \{\n\s*hooks\?: \{ beforeAiDispatchPreflight\?: \(env: Env, convId: string\) => Promise<void>; beforeVisibleSend\?:/g,
  `export interface Env {\n  hooks?: { beforeGenerationLeaseClaim?: (env: Env, convId: string) => Promise<void>; beforeAiDispatchPreflight?: (env: Env, convId: string) => Promise<void>; beforeVisibleSend?:`
);

fs.writeFileSync('src/index.ts', code);
