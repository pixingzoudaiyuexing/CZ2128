CREATE TABLE attachments_v2 (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    source_provider TEXT NOT NULL CHECK (source_provider IN ('telegram', 'chatwoot', 'crisp')),
    source_message_ref TEXT NOT NULL,
    source_attachment_ref TEXT NOT NULL,
    attachment_type TEXT NOT NULL CHECK (attachment_type IN ('photo', 'document', 'video', 'audio', 'voice')),
    original_filename TEXT NOT NULL,
    safe_filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER CHECK (size_bytes IS NULL OR (size_bytes >= 0 AND size_bytes <= 20971520)),
    storage_key TEXT NOT NULL UNIQUE,
    access_token_hash TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('PENDING', 'FETCHING', 'STORED', 'DELIVERED', 'FAILED_RETRYABLE', 'FAILED_FINAL')),
    destination_provider TEXT NOT NULL CHECK (destination_provider IN ('telegram', 'chatwoot', 'crisp')),
    destination_message_ref TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(source_provider, source_message_ref, source_attachment_ref)
);

INSERT INTO attachments_v2 (
    id, conversation_id, source_provider, source_message_ref, source_attachment_ref,
    attachment_type, original_filename, safe_filename, mime_type, size_bytes,
    storage_key, access_token_hash, status, destination_provider, destination_message_ref,
    attempt_count, expires_at, last_error, created_at, updated_at
)
SELECT
    id, conversation_id, source_provider, source_message_ref, source_attachment_ref,
    attachment_type, original_filename, safe_filename, mime_type, size_bytes,
    storage_key, access_token_hash, status, destination_provider, destination_message_ref,
    attempt_count, expires_at, last_error, created_at, updated_at
FROM attachments;

DROP TABLE attachments;
ALTER TABLE attachments_v2 RENAME TO attachments;

CREATE INDEX idx_attachments_expiry ON attachments(expires_at, id);
CREATE INDEX idx_attachments_conversation ON attachments(conversation_id, created_at, id);