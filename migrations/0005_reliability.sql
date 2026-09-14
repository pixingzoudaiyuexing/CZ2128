-- 1. outbound_operations
ALTER TABLE outbound_operations ADD COLUMN request_started_at INTEGER;
ALTER TABLE outbound_operations ADD COLUMN response_observed_at INTEGER;
ALTER TABLE outbound_operations ADD COLUMN response_http_status INTEGER;
ALTER TABLE outbound_operations ADD COLUMN next_retry_at INTEGER;
ALTER TABLE outbound_operations ADD COLUMN retry_after_seconds INTEGER;
ALTER TABLE outbound_operations ADD COLUMN reconciliation_status TEXT NOT NULL DEFAULT 'NOT_REQUIRED' CHECK (
    reconciliation_status IN (
        'NOT_REQUIRED',
        'PENDING',
        'CONFIRMED_SENT',
        'CONFIRMED_NOT_SENT',
        'STILL_AMBIGUOUS',
        'MANUAL_MARK_DELIVERED',
        'MANUAL_CANCELLED',
        'MANUAL_RETRY_CREATED'
    )
);
ALTER TABLE outbound_operations ADD COLUMN resolved_by TEXT;
ALTER TABLE outbound_operations ADD COLUMN resolved_at INTEGER;
ALTER TABLE outbound_operations ADD COLUMN resolution_reason TEXT;
ALTER TABLE outbound_operations ADD COLUMN parent_operation_id TEXT REFERENCES outbound_operations(id);
ALTER TABLE outbound_operations ADD COLUMN subject_type TEXT;
ALTER TABLE outbound_operations ADD COLUMN subject_ref TEXT;
ALTER TABLE outbound_operations ADD COLUMN target_evidence_json TEXT;

UPDATE outbound_operations SET reconciliation_status = 'PENDING' WHERE status = 'AMBIGUOUS';

CREATE INDEX idx_outbound_operations_status_reconciliation_status_updated_at ON outbound_operations(status, reconciliation_status, updated_at);
CREATE INDEX idx_outbound_operations_status_next_retry_at ON outbound_operations(status, next_retry_at);
CREATE INDEX idx_outbound_operations_subject ON outbound_operations(subject_type, subject_ref);
CREATE INDEX idx_outbound_operations_parent_operation_id ON outbound_operations(parent_operation_id);

-- 2. event_receipts
ALTER TABLE event_receipts ADD COLUMN event_type TEXT;
ALTER TABLE event_receipts ADD COLUMN conversation_id TEXT;
ALTER TABLE event_receipts ADD COLUMN last_attempt_at INTEGER;
ALTER TABLE event_receipts ADD COLUMN dead_lettered_at INTEGER;

CREATE INDEX idx_event_receipts_status_last_attempt_at ON event_receipts(status, last_attempt_at);
CREATE INDEX idx_event_receipts_dead_lettered_at ON event_receipts(dead_lettered_at);

-- 3. ai_runs (Rebuild table to update CHECK constraint)
CREATE TABLE ai_runs_new (
    trigger_event_ref TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    trigger_message_ref TEXT NOT NULL,
    generation_id TEXT,
    handoff_epoch INTEGER NOT NULL,
    provider_response_ref TEXT,
    response_text TEXT,
    status TEXT NOT NULL CHECK (status IN (
        'PENDING',
        'SUCCESS',
        'FAILED',
        'FAILED_RETRYABLE',
        'RETRY_EXHAUSTED',
        'FAILED_FINAL',
        'CANCELLED_BY_HANDOFF',
        'DISCARDED_STALE'
    )),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_retry_at INTEGER,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

INSERT INTO ai_runs_new (
    trigger_event_ref,
    conversation_id,
    trigger_message_ref,
    generation_id,
    handoff_epoch,
    provider_response_ref,
    response_text,
    status,
    attempt_count,
    next_retry_at,
    last_error,
    created_at,
    updated_at
)
SELECT
    trigger_event_ref,
    conversation_id,
    trigger_message_ref,
    generation_id,
    handoff_epoch,
    provider_response_ref,
    response_text,
    CASE 
        WHEN status = 'FAILED' THEN 'FAILED_FINAL' 
        ELSE status 
    END AS status,
    0 AS attempt_count,
    NULL AS next_retry_at,
    last_error,
    created_at,
    updated_at
FROM ai_runs;

DROP TABLE ai_runs;

ALTER TABLE ai_runs_new RENAME TO ai_runs;

CREATE INDEX idx_ai_runs_status_next_retry_at ON ai_runs(status, next_retry_at);

-- 4. reliability_audit
CREATE TABLE reliability_audit (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    action TEXT NOT NULL,
    actor_type TEXT NOT NULL,
    actor_ref TEXT,
    old_state TEXT,
    new_state TEXT,
    reason_code TEXT,
    created_at INTEGER NOT NULL
);

CREATE INDEX idx_reliability_audit_entity ON reliability_audit(entity_type, entity_id, created_at);

-- 5. dlq_receipts
CREATE TABLE dlq_receipts (
    id TEXT PRIMARY KEY,
    queue_name TEXT NOT NULL,
    event_source TEXT,
    source_event_ref TEXT,
    event_type TEXT,
    conversation_id TEXT,
    operation_id TEXT,
    safe_error_code TEXT,
    status TEXT NOT NULL,
    delivery_count INTEGER NOT NULL DEFAULT 1,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    resolved_at INTEGER
);

CREATE INDEX idx_dlq_receipts_status_last_seen_at ON dlq_receipts(status, last_seen_at);
