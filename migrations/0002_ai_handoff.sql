ALTER TABLE conversations ADD COLUMN ai_mode TEXT NOT NULL DEFAULT 'ENABLED';
ALTER TABLE conversations ADD COLUMN ai_generation_id TEXT;
ALTER TABLE conversations ADD COLUMN ai_generation_started_at INTEGER;
ALTER TABLE conversations ADD COLUMN ai_generation_message_id TEXT;

CREATE INDEX idx_messages_conversation_id_created_at ON messages(conversation_id, created_at);
