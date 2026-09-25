CREATE TABLE knowledge_entries (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    search_terms TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_by TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (length(id) BETWEEN 4 AND 64),
    CHECK (length(title) BETWEEN 1 AND 120),
    CHECK (length(body) BETWEEN 1 AND 12000),
    CHECK (length(search_terms) BETWEEN 1 AND 24000)
);

CREATE INDEX idx_knowledge_entries_enabled_updated
    ON knowledge_entries(enabled, updated_at DESC, id);

CREATE TABLE knowledge_entry_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 1),
    action TEXT NOT NULL CHECK (action IN ('CREATE', 'UPDATE', 'ENABLE', 'DISABLE', 'DELETE')),
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    actor_user_id TEXT NOT NULL,
    source_update_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(entry_id, version)
);

CREATE INDEX idx_knowledge_entry_history_entry
    ON knowledge_entry_history(entry_id, version DESC);

CREATE VIRTUAL TABLE knowledge_entries_fts USING fts5(
    title,
    body,
    search_terms,
    content='knowledge_entries',
    content_rowid='rowid',
    tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER trg_knowledge_entries_ai
AFTER INSERT ON knowledge_entries
BEGIN
    INSERT INTO knowledge_entries_fts(rowid, title, body, search_terms)
    VALUES (new.rowid, new.title, new.body, new.search_terms);
END;

CREATE TRIGGER trg_knowledge_entries_ad
AFTER DELETE ON knowledge_entries
BEGIN
    INSERT INTO knowledge_entries_fts(knowledge_entries_fts, rowid, title, body, search_terms)
    VALUES ('delete', old.rowid, old.title, old.body, old.search_terms);
END;

CREATE TRIGGER trg_knowledge_entries_au
AFTER UPDATE OF title, body, search_terms ON knowledge_entries
BEGIN
    INSERT INTO knowledge_entries_fts(knowledge_entries_fts, rowid, title, body, search_terms)
    VALUES ('delete', old.rowid, old.title, old.body, old.search_terms);
    INSERT INTO knowledge_entries_fts(rowid, title, body, search_terms)
    VALUES (new.rowid, new.title, new.body, new.search_terms);
END;
