CREATE TABLE attachments_v3 (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    source_provider TEXT NOT NULL CHECK (source_provider IN ('telegram', 'chatwoot', 'crisp', 'upload')),
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

INSERT INTO attachments_v3 (
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
ALTER TABLE attachments_v3 RENAME TO attachments;

CREATE INDEX idx_attachments_expiry ON attachments(expires_at, id);
CREATE INDEX idx_attachments_conversation ON attachments(conversation_id, created_at, id);

CREATE TABLE upload_invites (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    crisp_website_ref TEXT NOT NULL,
    crisp_session_ref TEXT NOT NULL,
    telegram_group_ref TEXT NOT NULL,
    telegram_thread_ref TEXT NOT NULL,
    support_profile_version INTEGER NOT NULL CHECK (support_profile_version >= 0),
    created_by_operator_ref TEXT NOT NULL,
    created_from_update_ref TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED', 'EXHAUSTED', 'EXPIRED')),
    expires_at INTEGER NOT NULL,
    max_files INTEGER NOT NULL CHECK (max_files >= 1 AND max_files <= 10),
    max_total_bytes INTEGER NOT NULL CHECK (max_total_bytes >= 1 AND max_total_bytes <= 20971520),
    consumed_files INTEGER NOT NULL DEFAULT 0 CHECK (consumed_files >= 0),
    consumed_bytes INTEGER NOT NULL DEFAULT 0 CHECK (consumed_bytes >= 0),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    revoked_at INTEGER,
    exhausted_at INTEGER,
    UNIQUE(support_profile_version, created_from_update_ref)
);

CREATE INDEX idx_upload_invites_conversation
    ON upload_invites(conversation_id, status, expires_at, created_at);
CREATE INDEX idx_upload_invites_expiry
    ON upload_invites(status, expires_at, id);

CREATE TABLE upload_invite_items (
    invite_id TEXT NOT NULL REFERENCES upload_invites(id),
    upload_id TEXT NOT NULL,
    attachment_id TEXT NOT NULL UNIQUE REFERENCES attachments(id),
    status TEXT NOT NULL CHECK (status IN ('UPLOADING', 'ACCEPTED', 'REJECTED')),
    size_bytes INTEGER CHECK (size_bytes IS NULL OR (size_bytes >= 0 AND size_bytes <= 20971520)),
    lease_token TEXT,
    lease_until INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(invite_id, upload_id)
);

CREATE INDEX idx_upload_invite_items_attachment ON upload_invite_items(attachment_id);

CREATE TRIGGER trg_upload_invite_item_accept
BEFORE UPDATE OF status ON upload_invite_items
WHEN OLD.status != 'ACCEPTED' AND NEW.status = 'ACCEPTED'
BEGIN
    SELECT CASE
        WHEN NEW.size_bytes IS NULL OR NEW.size_bytes < 1 THEN RAISE(ABORT, 'UPLOAD_INVITE_INVALID_SIZE')
        WHEN NOT EXISTS (
            SELECT 1
            FROM upload_invites ui
            WHERE ui.id = NEW.invite_id
              AND ui.status = 'ACTIVE'
              AND ui.expires_at > CAST(strftime('%s', 'now') AS INTEGER)
              AND ui.consumed_files + 1 <= ui.max_files
              AND ui.consumed_bytes + NEW.size_bytes <= ui.max_total_bytes
        ) THEN RAISE(ABORT, 'UPLOAD_INVITE_LIMIT')
    END;

    UPDATE upload_invites
    SET consumed_files = consumed_files + 1,
        consumed_bytes = consumed_bytes + NEW.size_bytes,
        status = CASE
            WHEN consumed_files + 1 >= max_files
              OR consumed_bytes + NEW.size_bytes >= max_total_bytes
            THEN 'EXHAUSTED'
            ELSE 'ACTIVE'
        END,
        exhausted_at = CASE
            WHEN consumed_files + 1 >= max_files
              OR consumed_bytes + NEW.size_bytes >= max_total_bytes
            THEN NEW.updated_at
            ELSE exhausted_at
        END,
        version = version + 1,
        updated_at = NEW.updated_at
    WHERE id = NEW.invite_id;
END;
