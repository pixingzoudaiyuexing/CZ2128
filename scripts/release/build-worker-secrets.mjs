import { chmod, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const REQUIRED_WORKER_SECRET_NAMES = Object.freeze([
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_WEBHOOK_SECRET',
  'TELEGRAM_SECRET_PATH',
  'BOT_GROUP_ID',
  'ADMIN_TELEGRAM_USER_IDS',
  'RUNTIME_CONFIG_MASTER_KEY',
  'UPLOAD_CAPABILITY_SECRET',
  'CRISP_WEBHOOK_SECRET',
  'CRISP_API_IDENTIFIER',
  'CRISP_API_KEY',
  'CRISP_WEBSITE_ID',
  'AI_BASE_URL',
  'AI_API_KEY',
  'AI_MODEL',
  'NOTION_API_TOKEN'
]);

function requiredValue(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Missing required GitHub/Worker secret: ${name}`);
  }
  if (value === 'REPLACE_LOCALLY') {
    throw new Error(`Placeholder value is forbidden for ${name}`);
  }
  return value;
}

export function collectWorkerSecrets(env = process.env) {
  const secrets = Object.fromEntries(
    REQUIRED_WORKER_SECRET_NAMES.map(name => [name, requiredValue(env, name)])
  );
  if (typeof env.AI_SYSTEM_PROMPT === 'string' && env.AI_SYSTEM_PROMPT.trim()) {
    secrets.AI_SYSTEM_PROMPT = env.AI_SYSTEM_PROMPT;
  }
  return secrets;
}

export async function writeWorkerSecrets(path, env = process.env) {
  const target = resolve(path);
  const secrets = collectWorkerSecrets(env);
  await writeFile(target, JSON.stringify(secrets) + '\n', { mode: 0o600 });
  await chmod(target, 0o600);
  return { path: target, names: Object.keys(secrets).sort() };
}

function parseArguments(argv) {
  const options = { checkOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--output' && argv[i + 1]) options.output = argv[++i];
    else if (arg === '--check-only') options.checkOnly = true;
    else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const secrets = collectWorkerSecrets(process.env);
  if (options.checkOnly) {
    process.stdout.write(`Validated ${Object.keys(secrets).length} Worker secret names\n`);
    return;
  }
  if (!options.output) throw new Error('--output is required unless --check-only is used');
  const result = await writeWorkerSecrets(options.output, process.env);
  process.stdout.write(`Wrote ${result.names.length} Worker secrets to a protected temporary file\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main().catch(error => {
    process.stderr.write(`Worker secret preparation failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = 1;
  });
}