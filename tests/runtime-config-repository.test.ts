import { describe, expect, it } from 'vitest';
import { decryptRuntimeSecret } from '../src/runtime-config/crypto';
import { RuntimeConfigConflictError } from '../src/runtime-config/repository';
import { validateRuntimeValue } from '../src/runtime-config/registry';
import {
  migrateTelegramGroup,
  restoreEnvOverride,
  rollbackOverride,
  setPlainOverride,
  setSecretOverride
} from '../src/runtime-config/service';
import { RuntimeDb, masterKey } from './helpers/runtime-db';

function env(db = new RuntimeDb()) {
  return {
    DB: db, RUNTIME_CONFIG_MASTER_KEY: masterKey(),
    AI_REQUEST_TIMEOUT_MS: '30000', AI_GENERATION_LEASE_SECONDS: '60'
  } as any;
}

describe('runtime config repository', () => {
  it('preserves frozen attachment caps and strict provider input bounds', () => {
    expect(() => validateRuntimeValue('ATTACHMENT_MAX_BYTES', String(20 * 1024 * 1024 + 1)))
      .toThrow('INVALID_ATTACHMENT_SIZE');
    expect(() => validateRuntimeValue('ATTACHMENT_MAX_COUNT_PER_MESSAGE', '11'))
      .toThrow('INVALID_ATTACHMENT_COUNT');
    expect(() => validateRuntimeValue('AI_REQUEST_TIMEOUT_MS', '10000junk'))
      .toThrow('INVALID_AI_TIMEOUT');
    expect(() => validateRuntimeValue('CHATWOOT_API_URL', 'http://chatwoot.example'))
      .toThrow('INVALID_PROVIDER_URL');
  });
  it('uses CAS versions and records immutable plain history', async () => {
    const db = new RuntimeDb();
    const testEnv = env(db);
    await expect(setPlainOverride(testEnv, 'AI_MODEL', 'first', 0, '1', '10')).resolves.toBe(1);
    await expect(setPlainOverride(testEnv, 'AI_MODEL', 'second', 1, '1', '11')).resolves.toBe(2);
    await expect(setPlainOverride(testEnv, 'AI_MODEL', 'stale', 1, '2', '12'))
      .rejects.toBeInstanceOf(RuntimeConfigConflictError);
    expect(db.runtime[0]).toMatchObject({ value_text: 'second', version: 2 });
    expect(db.history.map(row => [row.version, row.value_text])).toEqual([[1, 'first'], [2, 'second']]);
  });

  it('stores secret plaintext in neither current config nor history', async () => {
    const db = new RuntimeDb();
    const testEnv = env(db);
    await setSecretOverride(testEnv, 'AI_API_KEY', 'private-secret', 0, '1', '20');
    expect(db.runtime[0].value_text).toBeNull();
    expect(db.history[0].value_text).toBeNull();
    expect(JSON.stringify({ runtime: db.runtime, history: db.history })).not.toContain('private-secret');
    await expect(decryptRuntimeSecret(masterKey(), 'AI_API_KEY', db.runtime[0].ciphertext, db.runtime[0].nonce))
      .resolves.toBe('private-secret');
  });

  it('removes an override for env fallback and preserves monotonic history versions', async () => {
    const db = new RuntimeDb();
    const testEnv = env(db);
    await setPlainOverride(testEnv, 'AI_MODEL', 'runtime', 0, '1', '30');
    await expect(restoreEnvOverride(testEnv, 'AI_MODEL', 1, '1', '31')).resolves.toBe(2);
    expect(db.runtime).toHaveLength(0);
    expect(db.history[1]).toMatchObject({ version: 2, action: 'RESTORE_ENV', is_deleted: 1 });
    await expect(setPlainOverride(testEnv, 'AI_MODEL', 'new-runtime', 0, '1', '32')).resolves.toBe(3);
  });

  it('rejects stale Restore ENV CAS and preserves the newer runtime value', async () => {
    const db = new RuntimeDb();
    const testEnv = env(db);
    await setPlainOverride(testEnv, 'AI_MODEL', 'first', 0, '1', '33');
    await setPlainOverride(testEnv, 'AI_MODEL', 'newer', 1, '2', '34');
    await expect(restoreEnvOverride(testEnv, 'AI_MODEL', 1, '1', '35'))
      .rejects.toBeInstanceOf(RuntimeConfigConflictError);
    expect(db.runtime[0]).toMatchObject({ key: 'AI_MODEL', value_text: 'newer', version: 2 });
    expect(db.history.filter(row => row.action === 'RESTORE_ENV')).toHaveLength(0);
  });

  it('permits only the dedicated Crisp keyword workflow to use Restore ENV while other dedicated keys remain blocked', async () => {
    const db = new RuntimeDb();
    const testEnv = env(db);
    await setPlainOverride(testEnv, 'CRISP_KEYWORD_RULES', '{"version":1,"rules":[]}', 0, '1', '36');
    await expect(restoreEnvOverride(testEnv, 'CRISP_KEYWORD_RULES', 1, '1', '37')).resolves.toBe(2);
    expect(db.history.at(-1)).toMatchObject({ key: 'CRISP_KEYWORD_RULES', action: 'RESTORE_ENV', is_deleted: 1 });
    await expect(restoreEnvOverride(testEnv, 'BOT_GROUP_ID', 1, '1', '38'))
      .rejects.toThrow('DEDICATED_WORKFLOW_REQUIRED');
  });

  it('rolls plain and encrypted secret history forward as new versions', async () => {
    const db = new RuntimeDb();
    const testEnv = env(db);
    await setPlainOverride(testEnv, 'AI_MODEL', 'old', 0, '1', '40');
    const plainHistory = db.history[0].id;
    await setPlainOverride(testEnv, 'AI_MODEL', 'new', 1, '1', '41');
    await expect(rollbackOverride(testEnv, plainHistory, 2, '1', '42')).resolves.toBe(3);
    expect(db.runtime.find(row => row.key === 'AI_MODEL')).toMatchObject({ value_text: 'old', version: 3 });

    await setSecretOverride(testEnv, 'AI_API_KEY', 'old-secret', 0, '1', '43');
    const secretHistory = db.history.find(row => row.key === 'AI_API_KEY')!.id;
    await setSecretOverride(testEnv, 'AI_API_KEY', 'new-secret', 1, '1', '44');
    await expect(rollbackOverride(testEnv, secretHistory, 2, '1', '45')).resolves.toBe(3);
    const secret = db.runtime.find(row => row.key === 'AI_API_KEY');
    await expect(decryptRuntimeSecret(masterKey(), 'AI_API_KEY', secret.ciphertext, secret.nonce))
      .resolves.toBe('old-secret');
  });

  it('does not expose side-effectful Telegram keys through generic restore or rollback', async () => {
    const db = new RuntimeDb();
    const testEnv = env(db);
    await expect(restoreEnvOverride(testEnv, 'BOT_GROUP_ID', 1, '1', '50'))
      .rejects.toThrow('DEDICATED_WORKFLOW_REQUIRED');
    db.history.push({
      id: 1, key: 'BOT_GROUP_ID', version: 1, value_kind: 'PLAIN', value_text: '-1001',
      ciphertext: null, nonce: null, is_deleted: 0, actor_user_id: '1', action: 'GROUP_MIGRATION',
      source_update_id: '1', created_at: 1
    });
    await expect(rollbackOverride(testEnv, 1, 0, '1', '51')).rejects.toThrow('DEDICATED_WORKFLOW_REQUIRED');
  });

  it('atomically changes the support group and invalidates existing topic mappings', async () => {
    const db = new RuntimeDb();
    db.conversations.push(
      { id: '1', operator_channel: 'telegram', operator_thread_ref: '7', operator_thread_status: 'CLOSED', version: 1 },
      { id: '2', operator_channel: 'other', operator_thread_ref: '8', operator_thread_status: 'OPEN', version: 1 }
    );
    const testEnv = env(db);
    await migrateTelegramGroup(testEnv, '-10099', 0, '1', '60');
    expect(db.runtime[0]).toMatchObject({ key: 'BOT_GROUP_ID', value_text: '-10099', version: 1 });
    expect(db.conversations[0]).toMatchObject({ operator_thread_ref: null, operator_thread_status: 'OPEN', version: 2 });
    expect(db.conversations[1].operator_thread_ref).toBe('8');
  });

  it('rolls back the whole group migration batch on D1 failure', async () => {
    const db = new RuntimeDb();
    db.failBatch = true;
    db.conversations.push({ id: '1', operator_channel: 'telegram', operator_thread_ref: '7', operator_thread_status: 'OPEN', version: 1 });
    await expect(migrateTelegramGroup(env(db), '-10099', 0, '1', '70')).rejects.toThrow();
    expect(db.runtime).toHaveLength(0);
    expect(db.conversations[0].operator_thread_ref).toBe('7');
  });
});
