import { AttachmentConfig } from './attachments';

export const UPLOAD_INVITE_TTL_SECONDS = 15 * 60;
export const UPLOAD_INVITE_MAX_FILES = 3;
export const UPLOAD_ITEM_LEASE_SECONDS = 120;

export interface UploadConfig {
  inviteTtlSeconds: number;
  maxFiles: number;
  maxTotalBytes: number;
  itemLeaseSeconds: number;
}

export function getUploadConfig(attachments: AttachmentConfig): UploadConfig {
  return {
    inviteTtlSeconds: UPLOAD_INVITE_TTL_SECONDS,
    maxFiles: UPLOAD_INVITE_MAX_FILES,
    maxTotalBytes: attachments.maxBytes,
    itemLeaseSeconds: UPLOAD_ITEM_LEASE_SECONDS
  };
}
