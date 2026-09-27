CREATE TABLE learning_candidates (
    id TEXT PRIMARY KEY,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    source_conversation_id TEXT NOT NULL REFERENCES conversations(id),
    source_human_message_id TEXT NOT NULL UNIQUE REFERENCES messages(id),
    source_question_message_id TEXT REFERENCES messages(id),
    source_provider TEXT NOT NULL,
    review_status TEXT NOT NULL DEFAULT 'CAPTURED'
        CHECK (review_status IN ('CAPTURED', 'NEEDS_REVIEW', 'APPROVED', 'REJECTED', 'PUBLISHED')),
    sanitized_question TEXT,
    sanitized_answer TEXT NOT NULL,
    extracted_title TEXT,
    extracted_question TEXT,
    extracted_answer TEXT,
    extraction_reason TEXT,
    review_notes TEXT,
    risk_level TEXT NOT NULL DEFAULT 'LOW' CHECK (risk_level IN ('LOW', 'MEDIUM', 'HIGH')),
    risk_flags_json TEXT NOT NULL DEFAULT '[]',
    extraction_status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK (extraction_status IN ('PENDING', 'SUCCEEDED', 'REJECTED', 'FAILED')),
    extraction_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (extraction_attempt_count BETWEEN 0 AND 3),
    extraction_error_code TEXT,
    notion_page_id TEXT UNIQUE,
    notion_sync_status TEXT NOT NULL DEFAULT 'DISABLED'
        CHECK (notion_sync_status IN ('DISABLED', 'PENDING', 'SYNCED', 'ERROR', 'DUPLICATE')),
    notion_sync_lease_token TEXT,
    notion_sync_lease_until INTEGER,
    last_synced_candidate_version INTEGER
        CHECK (last_synced_candidate_version IS NULL OR last_synced_candidate_version >= 1),
    notion_last_edited_time TEXT,
    notion_error_code TEXT,
    reviewed_at INTEGER,
    published_knowledge_id TEXT UNIQUE REFERENCES knowledge_entries(id),
    published_knowledge_version INTEGER
        CHECK (published_knowledge_version IS NULL OR published_knowledge_version >= 1),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (length(id) BETWEEN 8 AND 64),
    CHECK (length(source_provider) BETWEEN 1 AND 32),
    CHECK (sanitized_question IS NULL OR length(sanitized_question) <= 12000),
    CHECK (length(sanitized_answer) BETWEEN 1 AND 12000),
    CHECK (extracted_title IS NULL OR length(extracted_title) <= 120),
    CHECK (extracted_question IS NULL OR length(extracted_question) <= 12000),
    CHECK (extracted_answer IS NULL OR length(extracted_answer) <= 12000),
    CHECK (extraction_reason IS NULL OR length(extraction_reason) <= 2000),
    CHECK (review_notes IS NULL OR length(review_notes) <= 4000),
    CHECK (length(risk_flags_json) <= 4000),
    CHECK (extraction_error_code IS NULL OR length(extraction_error_code) <= 128),
    CHECK (notion_page_id IS NULL OR length(notion_page_id) <= 128),
    CHECK (notion_last_edited_time IS NULL OR length(notion_last_edited_time) <= 64),
    CHECK (notion_error_code IS NULL OR length(notion_error_code) <= 128),
    CHECK (notion_sync_lease_token IS NULL OR length(notion_sync_lease_token) <= 64),
    CHECK (
        (notion_sync_lease_token IS NULL AND notion_sync_lease_until IS NULL)
        OR
        (notion_sync_lease_token IS NOT NULL AND notion_sync_lease_until IS NOT NULL)
    ),
    CHECK (last_synced_candidate_version IS NULL OR last_synced_candidate_version <= version),
    CHECK (
        (review_status = 'PUBLISHED' AND published_knowledge_id IS NOT NULL AND published_knowledge_version IS NOT NULL)
        OR
        (review_status <> 'PUBLISHED' AND published_knowledge_id IS NULL AND published_knowledge_version IS NULL)
    ),
    CHECK (
        review_status NOT IN ('APPROVED', 'REJECTED', 'PUBLISHED')
        OR (notion_page_id IS NOT NULL AND last_synced_candidate_version IS NOT NULL)
    )
);

CREATE INDEX idx_learning_candidates_review
    ON learning_candidates(review_status, updated_at, id);

CREATE INDEX idx_learning_candidates_extraction
    ON learning_candidates(extraction_status, extraction_attempt_count, updated_at, id);

CREATE INDEX idx_learning_candidates_notion
    ON learning_candidates(notion_sync_status, updated_at, id);

CREATE INDEX idx_learning_candidates_source_conversation
    ON learning_candidates(source_conversation_id, created_at, id);

CREATE TABLE learning_candidate_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id TEXT NOT NULL REFERENCES learning_candidates(id),
    candidate_version INTEGER NOT NULL CHECK (candidate_version >= 1),
    action TEXT NOT NULL CHECK (action IN ('CAPTURE', 'EXTRACT', 'SYNC', 'REVIEW', 'REJECT', 'PUBLISH', 'ERROR')),
    review_status TEXT NOT NULL
        CHECK (review_status IN ('CAPTURED', 'NEEDS_REVIEW', 'APPROVED', 'REJECTED', 'PUBLISHED')),
    extraction_status TEXT NOT NULL
        CHECK (extraction_status IN ('PENDING', 'SUCCEEDED', 'REJECTED', 'FAILED')),
    risk_level TEXT NOT NULL CHECK (risk_level IN ('LOW', 'MEDIUM', 'HIGH')),
    actor_type TEXT NOT NULL,
    actor_ref TEXT NOT NULL,
    detail_code TEXT,
    created_at INTEGER NOT NULL,
    CHECK (length(actor_type) BETWEEN 1 AND 32),
    CHECK (length(actor_ref) BETWEEN 1 AND 128),
    CHECK (detail_code IS NULL OR length(detail_code) <= 128)
);

CREATE INDEX idx_learning_candidate_history_candidate
    ON learning_candidate_history(candidate_id, id DESC);

