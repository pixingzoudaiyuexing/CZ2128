import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL('../migrations/0004_runtime_config.sql', import.meta.url), 'utf8');

describe('runtime config migration contract', () => {
  it('creates the four bounded control-plane tables', () => {
    for (const table of ['runtime_config', 'runtime_config_history', 'admin_sessions', 'admin_update_receipts']) {
      expect(migration).toContain(`CREATE TABLE ${table}`);
    }
    expect(migration).toContain('last_telegram_operator_profile_version INTEGER NOT NULL DEFAULT 0');
  });

  it('enforces mutually exclusive plain and encrypted secret storage', () => {
    expect(migration).toContain("value_kind = 'PLAIN' AND value_text IS NOT NULL AND ciphertext IS NULL AND nonce IS NULL");
    expect(migration).toContain("value_kind = 'SECRET' AND value_text IS NULL AND ciphertext IS NOT NULL AND nonce IS NOT NULL");
  });

  it('enforces history versions, update replay identity and session expiry indexing', () => {
    expect(migration).toContain('UNIQUE(key, version)');
    expect(migration).toContain('update_id TEXT PRIMARY KEY');
    expect(migration).toContain('CREATE INDEX idx_admin_sessions_expiry ON admin_sessions(expires_at)');
  });
});
