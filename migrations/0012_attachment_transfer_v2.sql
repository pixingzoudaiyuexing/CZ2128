-- Preserve the legacy tables and their constrained fields for historical jobs.
-- Version 2 stores canonical byte counts separately, without a product byte/count cap.
ALTER TABLE attachments ADD COLUMN declared_size_bytes INTEGER CHECK (declared_size_bytes IS NULL OR declared_size_bytes >= 0);
ALTER TABLE attachments ADD COLUMN stored_size_bytes INTEGER CHECK (stored_size_bytes IS NULL OR stored_size_bytes >= 0);
ALTER TABLE attachments ADD COLUMN stored_at INTEGER;
ALTER TABLE attachments ADD COLUMN retention_class TEXT CHECK (retention_class IN ('IMAGE','FILE'));
ALTER TABLE attachments ADD COLUMN retention_expires_at INTEGER;
ALTER TABLE attachments ADD COLUMN sha256 TEXT;
ALTER TABLE attachments ADD COLUMN deleted_at INTEGER;
ALTER TABLE attachments ADD COLUMN cleanup_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE attachments ADD COLUMN cleanup_next_retry_at INTEGER;
ALTER TABLE attachments ADD COLUMN grant_expires_at INTEGER;
ALTER TABLE attachments ADD COLUMN grant_revoked_at INTEGER;
ALTER TABLE attachments ADD COLUMN transfer_version INTEGER NOT NULL DEFAULT 1 CHECK (transfer_version IN (1,2));
CREATE INDEX idx_attachments_v2_cleanup ON attachments(deleted_at, retention_expires_at, cleanup_next_retry_at);

ALTER TABLE upload_invites ADD COLUMN transfer_version INTEGER NOT NULL DEFAULT 1 CHECK (transfer_version IN (1,2));
ALTER TABLE upload_invites ADD COLUMN upload_role TEXT NOT NULL DEFAULT 'CUSTOMER' CHECK (upload_role IN ('CUSTOMER','OPERATOR'));

CREATE TABLE attachment_upload_sessions (
  id TEXT PRIMARY KEY,
  invite_id TEXT NOT NULL REFERENCES upload_invites(id),
  attachment_id TEXT NOT NULL UNIQUE REFERENCES attachments(id),
  token_hash TEXT NOT NULL UNIQUE,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  part_size INTEGER NOT NULL CHECK (part_size >= 5242880),
  part_count INTEGER NOT NULL CHECK (part_count BETWEEN 1 AND 10000),
  r2_upload_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('INITIALIZING','UPLOADING','COMPLETING','VERIFYING','STORED','QUEUED','DELIVERED','AMBIGUOUS','ABORTING','ABORTED','FAILED')),
  expected_sha256 TEXT,
  verification_json TEXT,
  expires_at INTEGER NOT NULL,
  lease_token TEXT,
  lease_until INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(invite_id,id)
);
CREATE INDEX idx_upload_sessions_recovery ON attachment_upload_sessions(status,expires_at,lease_until,updated_at);

CREATE TABLE attachment_upload_parts (
  session_id TEXT NOT NULL REFERENCES attachment_upload_sessions(id),
  part_number INTEGER NOT NULL CHECK (part_number BETWEEN 1 AND 10000),
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  sha256 TEXT NOT NULL CHECK (length(sha256)=64),
  etag TEXT,
  status TEXT NOT NULL CHECK (status IN ('WRITING','STORED')),
  lease_token TEXT NOT NULL,
  lease_until INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(session_id,part_number)
);

CREATE TABLE attachment_access_grants (
  token_hash TEXT PRIMARY KEY,
  attachment_id TEXT NOT NULL REFERENCES attachments(id),
  generation INTEGER NOT NULL CHECK (generation > 0),
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(attachment_id,generation)
);
CREATE INDEX idx_attachment_grants_file ON attachment_access_grants(attachment_id,generation);

CREATE TABLE attachment_upload_requests (
  invite_id TEXT NOT NULL REFERENCES upload_invites(id),
  minute_bucket INTEGER NOT NULL,
  requests INTEGER NOT NULL CHECK(requests >= 0),
  PRIMARY KEY(invite_id,minute_bucket)
);

-- Network blocks are independent from the (up to 5 GiB) R2 multipart part.
-- Keep cleanup identity until R2 deletion is confirmed; never store client URLs.
CREATE TABLE attachment_upload_subparts (
  session_id TEXT NOT NULL REFERENCES attachment_upload_sessions(id),
  part_number INTEGER NOT NULL CHECK (part_number BETWEEN 1 AND 10000),
  chunk_number INTEGER NOT NULL CHECK (chunk_number BETWEEN 1 AND 640),
  size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 8388608),
  sha256 TEXT NOT NULL CHECK (length(sha256)=64),
  temp_key TEXT NOT NULL UNIQUE,
  etag TEXT,
  state TEXT NOT NULL CHECK (state IN ('WRITING','STORED','DELETING','DELETED')),
  lease_token TEXT NOT NULL,
  lease_until INTEGER NOT NULL,
  cleanup_attempts INTEGER NOT NULL DEFAULT 0,
  cleanup_next_retry_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(session_id,part_number,chunk_number)
);
CREATE INDEX idx_upload_subparts_cleanup ON attachment_upload_subparts(state,cleanup_next_retry_at,session_id,part_number);
