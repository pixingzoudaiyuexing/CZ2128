import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL('../migrations/0003_attachments.sql', import.meta.url), 'utf8');

describe('attachment migration contract', () => {
  it('defines the canonical attachment state and conversation FK', () => {
    expect(migration).toContain('conversation_id TEXT NOT NULL REFERENCES conversations(id)');
    for (const status of ['PENDING', 'FETCHING', 'STORED', 'DELIVERED', 'FAILED_RETRYABLE', 'FAILED_FINAL']) {
      expect(migration).toContain(`'${status}'`);
    }
    expect(migration).toContain("CHECK (source_provider IN ('telegram', 'chatwoot'))");
    expect(migration).toContain('size_bytes <= 20971520');
  });

  it('enforces source identity, storage key and token hash uniqueness', () => {
    expect(migration).toContain('UNIQUE(source_provider, source_message_ref, source_attachment_ref)');
    expect(migration).toMatch(/storage_key TEXT NOT NULL UNIQUE/);
    expect(migration).toMatch(/access_token_hash TEXT NOT NULL UNIQUE/);
  });

  it('indexes expiry cleanup and conversation history', () => {
    expect(migration).toContain('CREATE INDEX idx_attachments_expiry ON attachments(expires_at, id)');
    expect(migration).toContain('CREATE INDEX idx_attachments_conversation ON attachments(conversation_id, created_at, id)');
  });
});
