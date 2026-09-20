import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const PLACEHOLDER_D1_ID = 'REPLACE_WITH_CZ2128_4C_STAGING_D1_UUID';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const EXPECTED = Object.freeze({
  worker: 'cz2128-4c-staging',
  d1: 'cz2128-4c-staging-db',
  mainQueue: 'cz2128-4c-staging-queue',
  dlq: 'cz2128-4c-staging-dlq',
  attachments: 'cz2128-4c-staging-attachments',
  quarantine: 'cz2128-4c-staging-dlq-quarantine'
});

const FORBIDDEN_RESOURCE_NAMES = new Set([
  'cz2128',
  'cz2128-db',
  'cz2128-queue',
  'cz2128-dlq',
  'cz2128-attachments',
  'cz2128-dlq-quarantine',
  'cz2128-staging',
  'cz2128-staging-db',
  'cz2128-staging-queue',
  'cz2128-staging-dlq',
  'cz2128-staging-attachments',
  'cz2128-staging-dlq-quarantine'
]);

const ALLOWED_ROOT_KEYS = new Set([
  '$schema',
  'name',
  'main',
  'compatibility_date',
  'compatibility_flags',
  'workers_dev',
  'preview_urls',
  'vars',
  'triggers',
  'd1_databases',
  'queues',
  'r2_buckets'
]);

function fail(message) {
  throw new Error(message);
}

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function array(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value;
}

function exactly(value, expected, label) {
  if (value !== expected) fail(`${label} must equal ${expected}`);
}

function onlyKeys(value, allowed, label) {
  const unexpected = Object.keys(value).filter(key => !allowed.includes(key));
  if (unexpected.length > 0) fail(`${label} contains unexpected field ${unexpected[0]}`);
}

function stringValues(value, values = []) {
  if (typeof value === 'string') values.push(value);
  else if (Array.isArray(value)) value.forEach(item => stringValues(item, values));
  else if (value && typeof value === 'object') Object.values(value).forEach(item => stringValues(item, values));
  return values;
}

function secretKeyPaths(value, path = '', results = []) {
  if (!value || typeof value !== 'object') return results;
  if (Array.isArray(value)) {
    value.forEach((child, index) => secretKeyPaths(child, `${path}[${index}]`, results));
    return results;
  }
  for (const [key, child] of Object.entries(value)) {
    const next = path ? `${path}.${key}` : key;
    if (/(secret|token|password|api[_-]?key|webhook)/i.test(key)) results.push(next);
    secretKeyPaths(child, next, results);
  }
  return results;
}

function keyedRows(rows, key, label) {
  const map = new Map();
  for (const rowValue of rows) {
    const row = record(rowValue, `${label} entry`);
    if (typeof row[key] !== 'string' || !row[key]) fail(`${label} entry has invalid ${key}`);
    if (map.has(row[key])) fail(`${label} contains duplicate ${key} ${row[key]}`);
    map.set(row[key], row);
  }
  return map;
}

export function validateStagingConfig(config, options = {}) {
  const root = record(config, 'config');
  const allowPlaceholder = options.allowPlaceholder === true;
  const expectedD1Id = options.expectedD1Id;

  if ('routes' in root || 'route' in root) fail('staging config must not declare production/custom routes');
  const unexpectedRootKeys = Object.keys(root).filter(key => !ALLOWED_ROOT_KEYS.has(key));
  if (unexpectedRootKeys.length > 0) fail(`unexpected top-level staging config key: ${unexpectedRootKeys[0]}`);

  exactly(root.name, EXPECTED.worker, 'Worker name');
  exactly(root.main, 'src/index.ts', 'Worker entry');
  exactly(root.compatibility_date, '2024-03-20', 'compatibility_date');
  const compatibilityFlags = array(root.compatibility_flags, 'compatibility_flags');
  if (compatibilityFlags.length !== 1 || compatibilityFlags[0] !== 'nodejs_compat') {
    fail('compatibility_flags must contain only nodejs_compat');
  }
  exactly(root.workers_dev, true, 'workers_dev');
  exactly(root.preview_urls, false, 'preview_urls');

  const vars = record(root.vars, 'vars');
  onlyKeys(vars, ['EXPECTED_MAIN_QUEUE_NAME', 'EXPECTED_DLQ_QUEUE_NAME'], 'vars');
  if (Object.keys(vars).length !== 2) fail('vars must contain both approved Queue identity keys');
  exactly(vars.EXPECTED_MAIN_QUEUE_NAME, EXPECTED.mainQueue, 'expected main Queue identity');
  exactly(vars.EXPECTED_DLQ_QUEUE_NAME, EXPECTED.dlq, 'expected DLQ identity');
  if (vars.EXPECTED_MAIN_QUEUE_NAME === vars.EXPECTED_DLQ_QUEUE_NAME) {
    fail('main Queue and DLQ identities must differ');
  }

  const triggers = record(root.triggers, 'triggers');
  onlyKeys(triggers, ['crons'], 'triggers');
  const crons = array(triggers.crons, 'triggers.crons');
  if (crons.length !== 1 || crons[0] !== '0 * * * *') fail('hourly cron must be exactly 0 * * * *');

  const databases = array(root.d1_databases, 'd1_databases');
  if (databases.length !== 1) fail('exactly one D1 binding is required');
  const database = record(databases[0], 'D1 binding');
  onlyKeys(database, ['binding', 'database_name', 'database_id', 'migrations_dir'], 'D1 binding');
  exactly(database.binding, 'DB', 'D1 binding name');
  exactly(database.database_name, EXPECTED.d1, 'D1 database name');
  exactly(database.migrations_dir, 'migrations', 'D1 migrations directory');
  if (database.database_id === 'local-dev-only' || database.database_id === '') fail('D1 database ID is unsafe');
  if (allowPlaceholder) {
    exactly(database.database_id, PLACEHOLDER_D1_ID, 'template D1 database ID');
  } else {
    if (!UUID_PATTERN.test(database.database_id)) fail('D1 database ID must be a real UUID');
    if (!expectedD1Id || !UUID_PATTERN.test(expectedD1Id)) fail('an independently verified expected D1 UUID is required');
    exactly(database.database_id, expectedD1Id, 'D1 database identity');
  }

  const r2Rows = array(root.r2_buckets, 'r2_buckets');
  r2Rows.forEach(value => onlyKeys(record(value, 'R2 binding'), ['binding', 'bucket_name'], 'R2 binding'));
  const r2 = keyedRows(r2Rows, 'binding', 'r2_buckets');
  if (r2.size !== 2) fail('exactly two R2 bindings are required');
  exactly(r2.get('ATTACHMENTS_BUCKET')?.bucket_name, EXPECTED.attachments, 'attachment bucket');
  exactly(r2.get('DLQ_QUARANTINE')?.bucket_name, EXPECTED.quarantine, 'quarantine bucket');

  const queues = record(root.queues, 'queues');
  onlyKeys(queues, ['producers', 'consumers'], 'queues');
  const producerRows = array(queues.producers, 'queues.producers');
  producerRows.forEach(value => onlyKeys(record(value, 'Queue producer'), ['binding', 'queue'], 'Queue producer'));
  const producers = keyedRows(producerRows, 'binding', 'queue producers');
  if (producers.size !== 1) fail('exactly one Queue producer is required');
  exactly(producers.get('QUEUE')?.queue, EXPECTED.mainQueue, 'main Queue producer');

  const consumerRows = array(queues.consumers, 'queues.consumers');
  const consumers = keyedRows(consumerRows, 'queue', 'queue consumers');
  if (consumers.size !== 2) fail('main Queue and DLQ consumers are both required');
  const main = consumers.get(EXPECTED.mainQueue);
  const dlq = consumers.get(EXPECTED.dlq);
  if (!main || !dlq) fail('approved main Queue and DLQ consumers are required');
  onlyKeys(
    main,
    ['queue', 'max_batch_size', 'max_batch_timeout', 'max_retries', 'dead_letter_queue'],
    'main Queue consumer'
  );
  onlyKeys(dlq, ['queue', 'max_batch_size', 'max_batch_timeout'], 'DLQ consumer');
  exactly(main.max_batch_size, 10, 'main Queue max_batch_size');
  exactly(main.max_batch_timeout, 1, 'main Queue max_batch_timeout');
  exactly(main.max_retries, 3, 'main Queue max_retries');
  exactly(main.dead_letter_queue, EXPECTED.dlq, 'main Queue dead-letter target');
  exactly(dlq.max_batch_size, 10, 'DLQ max_batch_size');
  exactly(dlq.max_batch_timeout, 1, 'DLQ max_batch_timeout');
  if ('dead_letter_queue' in dlq) fail('DLQ consumer must not chain to another dead-letter queue');

  const forbiddenReferences = stringValues(root).filter(value => FORBIDDEN_RESOURCE_NAMES.has(value));
  if (forbiddenReferences.length > 0) fail(`forbidden legacy or production resource reference: ${forbiddenReferences[0]}`);
  const secretPaths = secretKeyPaths(root);
  if (secretPaths.length > 0) fail(`plaintext credential-like config key is forbidden: ${secretPaths[0]}`);

  return { worker: EXPECTED.worker, databaseId: database.database_id };
}

function argumentsFrom(argv) {
  const options = { config: 'wrangler.staging.jsonc', allowPlaceholder: false, expectedD1Id: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--allow-placeholder') options.allowPlaceholder = true;
    else if (argument === '--config' && argv[index + 1]) options.config = argv[++index];
    else if (argument === '--expected-d1-id' && argv[index + 1]) options.expectedD1Id = argv[++index];
    else fail(`unknown or incomplete argument: ${argument}`);
  }
  return options;
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2));
  const configPath = resolve(options.config);
  const source = await readFile(configPath, 'utf8');
  const config = JSON.parse(source);
  const result = validateStagingConfig(config, options);
  process.stdout.write(`Validated isolated staging config for ${result.worker}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main().catch(error => {
    process.stderr.write(`Staging config validation failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = 1;
  });
}
