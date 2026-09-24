import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SqliteD1 } from './helpers/sqlite-d1';

const PREVIOUS_MIGRATIONS = [
  '0001_initial_schema.sql',
  '0002_ai_handoff.sql',
  '0003_attachments.sql',
  '0004_runtime_config.sql',
  '0005_reliability.sql',
  '0006_crisp_attachment_provider.sql',
  '0007_crisp_upload_invites.sql'
];

describe('Crisp-12 migration compatibility', () => {
  it('preserves existing conversations, runtime config and history while adding bounded UX evidence', async () => {
    const db = new SqliteD1();
    try {
      for (const migration of PREVIOUS_MIGRATIONS) {
        db.exec(readFileSync(`migrations/${migration}`, 'utf8'));
      }

      db.exec(`
        INSERT INTO conversations (
          id, helpdesk_provider, helpdesk_account_ref, helpdesk_conversation_ref,
          customer_ref, operator_channel, operator_thread_ref, ai_mode,
          created_at, updated_at
        ) VALUES (
          'legacy-conv', 'crisp', 'site', 'session', 'customer',
          'telegram', '44', 'PAUSED_OPERATOR', 1, 1
        );

        INSERT INTO runtime_config (
          key, value_kind, value_text, ciphertext, nonce, version, updated_by, updated_at
        ) VALUES (
          'CRISP_KEYWORD_RULES', 'PLAIN',
          '{"version":1,"rules":[{"id":"kw_0000000000000001","keyword":"legacy","reply":"legacy reply","enabled":true}]}',
          NULL, NULL, 3, 'admin:1001', 10
        );

        INSERT INTO runtime_config_history (
          key, version, value_kind, value_text, ciphertext, nonce,
          is_deleted, actor_user_id, action, source_update_id, created_at
        ) VALUES (
          'CRISP_KEYWORD_RULES', 3, 'PLAIN',
          '{"version":1,"rules":[{"id":"kw_0000000000000001","keyword":"legacy","reply":"legacy reply","enabled":true}]}',
          NULL, NULL, 0, '1001', 'SET', '9', 10
        )
      `);

      db.exec(readFileSync('migrations/0008_crisp_legacy_ux.sql', 'utf8'));

      const conversation = await db.prepare(
        'SELECT ai_mode, ai_pause_source, operator_thread_ref FROM conversations WHERE id = ?'
      ).bind('legacy-conv').first<any>();
      expect(conversation).toEqual({
        ai_mode: 'PAUSED_OPERATOR',
        ai_pause_source: null,
        operator_thread_ref: '44'
      });

      const config = await db.prepare(
        'SELECT value_text, version FROM runtime_config WHERE key = ?'
      ).bind('CRISP_KEYWORD_RULES').first<any>();
      expect(config.version).toBe(3);
      expect(config.value_text).toContain('"keyword":"legacy"');

      const history = await db.prepare(
        'SELECT value_text, version FROM runtime_config_history WHERE key = ?'
      ).bind('CRISP_KEYWORD_RULES').first<any>();
      expect(history.version).toBe(3);
      expect(history.value_text).toContain('"reply":"legacy reply"');

      const longValue = 'x'.repeat(500_000);
      await db.prepare(
        `INSERT INTO runtime_config
         (key, value_kind, value_text, ciphertext, nonce, version, updated_by, updated_at)
         VALUES (?, 'PLAIN', ?, NULL, NULL, 1, 'test', 11)`
      ).bind('CRISP_WELCOME_CONFIG', longValue).run();
      const stored = await db.prepare(
        'SELECT length(value_text) AS size FROM runtime_config WHERE key = ?'
      ).bind('CRISP_WELCOME_CONFIG').first<any>();
      expect(stored.size).toBe(500_000);
    } finally {
      db.close();
    }
  });
});
