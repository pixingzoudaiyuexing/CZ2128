CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    helpdesk_provider TEXT NOT NULL,
    helpdesk_account_ref TEXT NOT NULL,
    helpdesk_conversation_ref TEXT NOT NULL,
    customer_ref TEXT NOT NULL,
    operator_channel TEXT NOT NULL,
    operator_thread_ref TEXT,
    last_operator_reply_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    UNIQUE(helpdesk_provider, helpdesk_account_ref, helpdesk_conversation_ref)
);

CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    provider TEXT NOT NULL,
    provider_message_ref TEXT,
    direction TEXT NOT NULL,
    actor_role TEXT NOT NULL,
    message_type TEXT NOT NULL,
    text_content TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE(provider, provider_message_ref)
);

CREATE TABLE event_receipts (
    source TEXT NOT NULL,
    source_event_ref TEXT NOT NULL,
    status TEXT NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 1,
    last_error TEXT,
    processed_at INTEGER NOT NULL,
    PRIMARY KEY(source, source_event_ref)
);

CREATE TABLE outbound_operations (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    destination_provider TEXT NOT NULL,
    operation_type TEXT NOT NULL,
    status TEXT NOT NULL,
    provider_message_ref TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    lease_until INTEGER,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
