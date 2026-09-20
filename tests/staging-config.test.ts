import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const validator = resolve('scripts/validate-staging-config.mjs');
const template = JSON.parse(readFileSync('wrangler.staging.template.jsonc', 'utf8'));
const testUuid = '11111111-1111-4111-8111-111111111111';
const temporaryDirectories: string[] = [];

function writeConfig(mutator: (config: any) => void = () => undefined): string {
  const directory = mkdtempSync(join(tmpdir(), 'cz2128-staging-config-'));
  temporaryDirectories.push(directory);
  const config = structuredClone(template);
  mutator(config);
  const path = join(directory, 'wrangler.staging.jsonc');
  writeFileSync(path, JSON.stringify(config, null, 2));
  return path;
}

function validate(path: string, extra: string[] = []): string {
  return execFileSync(process.execPath, [validator, '--config', path, ...extra], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function validationError(path: string, extra: string[] = []): string {
  try {
    validate(path, extra);
    throw new Error('validator unexpectedly passed');
  } catch (error: any) {
    return String(error.stderr || error.message);
  }
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe('isolated staging configuration', () => {
  it('accepts the committed non-deployable template only in template mode', () => {
    expect(validate('wrangler.staging.template.jsonc', ['--allow-placeholder']))
      .toContain('Validated isolated staging config for cz2128-4c-staging');
    expect(validationError('wrangler.staging.template.jsonc'))
      .toContain('D1 database ID must be a real UUID');
  });

  it('accepts a finalized config only when its D1 ID matches independent evidence', () => {
    const path = writeConfig(config => { config.d1_databases[0].database_id = testUuid; });
    expect(validate(path, ['--expected-d1-id', testUuid]))
      .toContain('Validated isolated staging config for cz2128-4c-staging');
    expect(validationError(path, ['--expected-d1-id', '22222222-2222-4222-8222-222222222222']))
      .toContain('D1 database identity');
  });

  it.each([
    ['local D1 ID', (config: any) => { config.d1_databases[0].database_id = 'local-dev-only'; }, 'D1 database ID is unsafe'],
    ['legacy Worker', (config: any) => { config.name = 'cz2128-staging'; }, 'Worker name'],
    ['old main Queue', (config: any) => { config.queues.producers[0].queue = 'cz2128-queue'; }, 'main Queue producer'],
    ['missing quarantine binding', (config: any) => { config.r2_buckets.pop(); }, 'exactly two R2 bindings'],
    ['wrong DLQ target', (config: any) => { config.queues.consumers[0].dead_letter_queue = 'cz2128-staging-dlq'; }, 'dead-letter target'],
    ['missing DLQ consumer', (config: any) => { config.queues.consumers.pop(); }, 'both required'],
    ['wrong cron', (config: any) => { config.triggers.crons = ['*/5 * * * *']; }, 'hourly cron'],
    ['missing main Queue identity', (config: any) => { delete config.vars.EXPECTED_MAIN_QUEUE_NAME; }, 'both approved Queue identity keys'],
    ['missing DLQ identity', (config: any) => { delete config.vars.EXPECTED_DLQ_QUEUE_NAME; }, 'both approved Queue identity keys'],
    ['empty main Queue identity', (config: any) => { config.vars.EXPECTED_MAIN_QUEUE_NAME = ''; }, 'expected main Queue identity'],
    ['wrong main Queue identity', (config: any) => { config.vars.EXPECTED_MAIN_QUEUE_NAME = 'cz2128-staging-queue'; }, 'expected main Queue identity'],
    ['wrong DLQ identity', (config: any) => { config.vars.EXPECTED_DLQ_QUEUE_NAME = 'cz2128-dlq'; }, 'expected DLQ identity'],
    ['same Queue identities', (config: any) => { config.vars.EXPECTED_MAIN_QUEUE_NAME = config.vars.EXPECTED_DLQ_QUEUE_NAME; }, 'expected main Queue identity'],
    ['unapproved variable', (config: any) => { config.vars.FEATURE_FLAG = 'true'; }, 'vars contains unexpected field'],
    ['custom route', (config: any) => { config.routes = [{ pattern: 'staging.example/*' }]; }, 'must not declare production/custom routes'],
    ['nested plaintext secret', (config: any) => { config.r2_buckets[0].api_token = 'synthetic-secret'; }, 'R2 binding contains unexpected field'],
    ['extra D1 field', (config: any) => { config.d1_databases[0].preview_database_id = testUuid; }, 'D1 binding contains unexpected field'],
    ['extra Queue consumer field', (config: any) => { config.queues.consumers[0].retry_delay = 10; }, 'main Queue consumer contains unexpected field'],
    ['unreviewed extra binding', (config: any) => { config.kv_namespaces = [{ binding: 'EXTRA', id: testUuid }]; }, 'unexpected top-level staging config key']
  ])('rejects %s before any deployment command', (_label, mutate, expected) => {
    const path = writeConfig(config => {
      config.d1_databases[0].database_id = testUuid;
      mutate(config);
    });
    expect(validationError(path, ['--expected-d1-id', testUuid])).toContain(expected);
  });
});
