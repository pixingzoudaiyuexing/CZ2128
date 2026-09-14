ALTER TABLE conversations ADD COLUMN last_telegram_operator_profile_version INTEGER NOT NULL DEFAULT 0
    CHECK (last_telegram_operator_profile_version >= 0);

CREATE TABLE runtime_config (
    key TEXT PRIMARY KEY,
    value_kind TEXT NOT NULL CHECK (value_kind IN ('PLAIN', 'SECRET')),
    value_text TEXT,
    ciphertext TEXT,
    nonce TEXT,
    version INTEGER NOT NULL CHECK (version >= 1),
    updated_by TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (length(key) BETWEEN 1 AND 64),
    CHECK (value_text IS NULL OR length(value_text) <= 20000),
    CHECK (ciphertext IS NULL OR length(ciphertext) <= 32768),
    CHECK (nonce IS NULL OR length(nonce) <= 64),
    CHECK (
        (value_kind = 'PLAIN' AND value_text IS NOT NULL AND ciphertext IS NULL AND nonce IS NULL)
        OR
        (value_kind = 'SECRET' AND value_text IS NULL AND ciphertext IS NOT NULL AND nonce IS NOT NULL)
    )
);

CREATE TABLE runtime_config_history (
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
    CHECK (value_text IS NULL OR length(value_text) <= 20000),
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

CREATE INDEX idx_runtime_config_history_created ON runtime_config_history(created_at DESC, id DESC);

CREATE TABLE admin_sessions (
    admin_user_id TEXT PRIMARY KEY,
    action TEXT NOT NULL,
    target TEXT NOT NULL,
    expected_version INTEGER NOT NULL CHECK (expected_version >= 0),
    candidate_value_text TEXT,
    candidate_ciphertext TEXT,
    candidate_nonce TEXT,
    context_json TEXT,
    expires_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (length(action) <= 64 AND length(target) <= 128),
    CHECK (candidate_value_text IS NULL OR length(candidate_value_text) <= 20000),
    CHECK (context_json IS NULL OR length(context_json) <= 4096)
);

CREATE INDEX idx_admin_sessions_expiry ON admin_sessions(expires_at);

CREATE TABLE admin_update_receipts (
    update_id TEXT PRIMARY KEY,
    admin_user_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('PROCESSING', 'PROCESSED', 'FAILED')),
    action TEXT,
    error_code TEXT,
    created_at INTEGER NOT NULL,
    processed_at INTEGER
);
