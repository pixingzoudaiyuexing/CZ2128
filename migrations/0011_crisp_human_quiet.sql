-- Independent notification state. Historical AI handoff timestamps are not backfilled.
ALTER TABLE conversations ADD COLUMN last_crisp_human_reply_at INTEGER
  CHECK (last_crisp_human_reply_at IS NULL OR last_crisp_human_reply_at >= 1);

-- Freeze the original time once per genuine human message, including media-only replies.
-- This prevents a duplicate with changed delivery metadata from extending the window.
CREATE TABLE crisp_human_reply_receipts (
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  provider_message_ref TEXT NOT NULL CHECK (length(provider_message_ref) BETWEEN 1 AND 256),
  reply_at INTEGER CHECK (reply_at IS NULL OR reply_at >= 1),
  PRIMARY KEY (conversation_id, provider_message_ref)
);
