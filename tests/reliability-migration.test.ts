import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL('../migrations/0005_reliability.sql', import.meta.url), 'utf8');

describe('reliability migration contract', () => {
  it('adds bounded operational telemetry fields to outbound_operations', () => {
    expect(migration).toContain('ALTER TABLE outbound_operations ADD COLUMN request_started_at INTEGER;');
    expect(migration).toContain('ALTER TABLE outbound_operations ADD COLUMN reconciliation_status TEXT NOT NULL DEFAULT \'NOT_REQUIRED\'');
    expect(migration).toContain('ALTER TABLE outbound_operations ADD COLUMN target_evidence_json TEXT;');
    expect(migration).toContain('ALTER TABLE outbound_operations ADD COLUMN parent_operation_id TEXT REFERENCES outbound_operations(id);');
  });

  it('adds bounded operational fields to event_receipts', () => {
    expect(migration).toContain('ALTER TABLE event_receipts ADD COLUMN dead_lettered_at INTEGER;');
    expect(migration).toContain('ALTER TABLE event_receipts ADD COLUMN conversation_id TEXT;');
  });

  it('rebuilds ai_runs with expanded status CHECK including FAILED_FINAL and FAILED_RETRYABLE', () => {
    expect(migration).toContain('CREATE TABLE ai_runs_new (');
    expect(migration).toContain("'FAILED_FINAL'");
    expect(migration).toContain("'FAILED_RETRYABLE'");
    expect(migration).toContain('WHEN status = \'FAILED\' THEN \'FAILED_FINAL\'');
    expect(migration).toContain('ALTER TABLE ai_runs_new RENAME TO ai_runs;');
  });

  it('creates reliability_audit and dlq_receipts tables with indexing', () => {
    expect(migration).toContain('CREATE TABLE reliability_audit (');
    expect(migration).toContain('CREATE TABLE dlq_receipts (');
    expect(migration).toContain('CREATE INDEX idx_reliability_audit_entity ON reliability_audit(entity_type, entity_id, created_at);');
    expect(migration).toContain('CREATE INDEX idx_dlq_receipts_status_last_seen_at ON dlq_receipts(status, last_seen_at);');
  });

  it('does not store raw payload in dlq_receipts', () => {
    expect(migration).not.toContain('raw_payload');
    expect(migration).not.toContain('request_body');
    expect(migration).not.toContain('response_body');
    expect(migration).not.toContain('provider_body');
  });
});
