ALTER TABLE conversations ADD COLUMN ai_pause_source TEXT
  CHECK (ai_pause_source IS NULL OR ai_pause_source IN ('CRISP_OPERATOR', 'TELEGRAM_OPERATOR', 'MANUAL', 'HELPDESK_OPERATOR'));

ALTER TABLE outbound_operations ADD COLUMN request_options_json TEXT;
ALTER TABLE attachments ADD COLUMN request_options_json TEXT;
CREATE INDEX idx_outbound_operations_provider_message_ref
  ON outbound_operations(destination_provider, provider_message_ref);

CREATE TABLE runtime_config_new (
    key TEXT PRIMARY KEY,
    value_kind TEXT NOT NULL CHECK (value_kind IN ('PLAIN', 'SECRET')),
    value_text TEXT,
    ciphertext TEXT,
    nonce TEXT,
    version INTEGER NOT NULL CHECK (version >= 1),
    updated_by TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (length(key) BETWEEN 1 AND 64),
    CHECK (value_text IS NULL OR length(value_text) <= 1000000),
    CHECK (ciphertext IS NULL OR length(ciphertext) <= 32768),
    CHECK (nonce IS NULL OR length(nonce) <= 64),
    CHECK (
        (value_kind = 'PLAIN' AND value_text IS NOT NULL AND ciphertext IS NULL AND nonce IS NULL)
        OR
        (value_kind = 'SECRET' AND value_text IS NULL AND ciphertext IS NOT NULL AND nonce IS NOT NULL)
    )
);
INSERT INTO runtime_config_new SELECT * FROM runtime_config;
DROP TABLE runtime_config;
ALTER TABLE runtime_config_new RENAME TO runtime_config;

CREATE TABLE runtime_config_history_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 1),
    value_kind TEXT NOT NULL CHECK (value_kind IN ('PLAIN', 'SECRET')),
    value_text TEXT,
    ciphertext TEXT,
    nonce TEXT,
    is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1)),
    actor_user_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('SET', 'RESTORE_ENV', 'ROLLBACK', 'BOT_ROTATE', 'GROUP_MIGRATION')),
    source_update_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(key, version),
    CHECK (length(key) BETWEEN 1 AND 64),
    CHECK (value_text IS NULL OR length(value_text) <= 1000000),
    CHECK (ciphertext IS NULL OR length(ciphertext) <= 32768),
    CHECK (nonce IS NULL OR length(nonce) <= 64),
    CHECK (
        (is_deleted = 1 AND value_text IS NULL AND ciphertext IS NULL AND nonce IS NULL)
        OR
        (is_deleted = 0 AND value_kind = 'PLAIN' AND value_text IS NOT NULL AND ciphertext IS NULL AND nonce IS NULL)
        OR
        (is_deleted = 0 AND value_kind = 'SECRET' AND value_text IS NULL AND ciphertext IS NOT NULL AND nonce IS NOT NULL)
    )
);
INSERT INTO runtime_config_history_new SELECT * FROM runtime_config_history;
DROP TABLE runtime_config_history;
ALTER TABLE runtime_config_history_new RENAME TO runtime_config_history;
CREATE INDEX idx_runtime_config_history_created ON runtime_config_history(created_at DESC, id DESC);
