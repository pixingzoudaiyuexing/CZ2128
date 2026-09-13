ALTER TABLE conversations ADD COLUMN ai_mode TEXT NOT NULL DEFAULT 'ENABLED' CHECK (ai_mode IN ('ENABLED', 'PAUSED_OPERATOR', 'PAUSED_MANUAL'));
ALTER TABLE conversations ADD COLUMN ai_generation_id TEXT;
ALTER TABLE conversations ADD COLUMN ai_generation_started_at INTEGER;
ALTER TABLE conversations ADD COLUMN ai_generation_message_id TEXT;
ALTER TABLE conversations ADD COLUMN ai_handoff_epoch INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_messages_conversation_id_created_at ON messages(conversation_id, created_at, id);

CREATE TABLE ai_runs (
    trigger_event_ref TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    trigger_message_ref TEXT NOT NULL,
    generation_id TEXT,
    handoff_epoch INTEGER NOT NULL,
    provider_response_ref TEXT,
    response_text TEXT,
    status TEXT NOT NULL,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
