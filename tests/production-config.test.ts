import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { validateProductionConfig } from '../scripts/validate-production-config.mjs';

const TEMPLATE_PATH = new URL('../wrangler.production.template.jsonc', import.meta.url);
const REAL_D1_ID = '12345678-1234-4123-8123-123456789abc';

async function template(): Promise<Record<string, any>> {
  return JSON.parse(await readFile(TEMPLATE_PATH, 'utf8'));
}

describe('production deployment config', () => {
  it('accepts the reviewed placeholder template', async () => {
    const config = await template();
    expect(validateProductionConfig(config, { allowPlaceholder: true })).toEqual({
      worker: 'cz2128',
      databaseId: 'REPLACE_WITH_CZ2128_PRODUCTION_D1_UUID'
    });
  });

  it('accepts only the independently verified production D1 identity', async () => {
    const config = await template();
    config.d1_databases[0].database_id = REAL_D1_ID;
    expect(validateProductionConfig(config, { expectedD1Id: REAL_D1_ID })).toEqual({
      worker: 'cz2128',
      databaseId: REAL_D1_ID
    });
    expect(() => validateProductionConfig(config, {
      expectedD1Id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })).toThrow(/D1 database identity/);
  });

  it('fails closed if production AI test scope is enabled or allowlisted', async () => {
    const enabled = await template();
    enabled.vars.AI_TEST_SCOPE_ENABLED = 'true';
    enabled.vars.AI_TEST_ALLOWED_CONVERSATION_IDS = '["00000000-0000-4000-8000-000000000001"]';
    expect(() => validateProductionConfig(enabled, { allowPlaceholder: true })).toThrow(/production AI test scope/);

    const allowlisted = await template();
    allowlisted.vars.AI_TEST_ALLOWED_CONVERSATION_IDS = '["00000000-0000-4000-8000-000000000001"]';
    expect(() => validateProductionConfig(allowlisted, { allowPlaceholder: true })).toThrow(/production AI test allowlist/);
  });

  it('requires the reviewed Phase 6 Notion production settings', async () => {
    const disabled = await template();
    disabled.vars.NOTION_LEARNING_ENABLED = 'false';
    expect(() => validateProductionConfig(disabled, { allowPlaceholder: true })).toThrow(/Notion learning production switch/);

    const wrongSource = await template();
    wrongSource.vars.NOTION_LEARNING_CANDIDATES_DATA_SOURCE_ID = 'staging-source';
    expect(() => validateProductionConfig(wrongSource, { allowPlaceholder: true })).toThrow(/Learning Candidates/);
  });

  it('rejects staging references, custom routes and plaintext credential-like keys', async () => {
    const staging = await template();
    staging.r2_buckets[0].bucket_name = 'cz2128-4c-staging-attachments';
    expect(() => validateProductionConfig(staging, { allowPlaceholder: true })).toThrow(/attachment bucket/);

    const routed = await template();
    routed.routes = [{ pattern: 'example.com/*', zone_name: 'example.com' }];
    expect(() => validateProductionConfig(routed, { allowPlaceholder: true })).toThrow(/must not declare custom routes/);

    const secret = await template();
    secret.vars.API_KEY = 'plaintext';
    expect(() => validateProductionConfig(secret, { allowPlaceholder: true })).toThrow(/unexpected field/);
  });

  it('locks Queue to DLQ topology and production resource names', async () => {
    const wrongDlq = await template();
    wrongDlq.queues.consumers[0].dead_letter_queue = 'cz2128-other-dlq';
    expect(() => validateProductionConfig(wrongDlq, { allowPlaceholder: true })).toThrow(/dead-letter target/);

    const chained = await template();
    chained.queues.consumers[1].dead_letter_queue = 'cz2128-dlq';
    expect(() => validateProductionConfig(chained, { allowPlaceholder: true })).toThrow(/DLQ consumer/);
  });
});
