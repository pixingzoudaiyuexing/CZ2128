-- Existing v2 sessions retain their original synchronous protocol.
-- New clients negotiate CPU-bounded HTTP transport and durable Queue work.
ALTER TABLE attachment_upload_sessions ADD COLUMN async_mode INTEGER NOT NULL DEFAULT 0 CHECK (async_mode IN (0,1));
ALTER TABLE attachment_upload_sessions ADD COLUMN work_enqueue_after INTEGER NOT NULL DEFAULT 0;
