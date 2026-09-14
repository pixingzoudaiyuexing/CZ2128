import { AttachmentConfig } from '../config/attachments';
import { AttachmentDescriptor, AttachmentType } from '../core/attachments';

function finiteSize(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function telegramDescriptor(value: any, type: AttachmentType): AttachmentDescriptor | null {
  if (!value || typeof value.file_id !== 'string' || typeof value.file_unique_id !== 'string') return null;
  if (value.file_id.length > 512 || value.file_unique_id.length > 512) return null;
  const sizeBytes = finiteSize(value.file_size);
  return {
    sourceAttachmentRef: value.file_unique_id,
    attachmentType: type,
    originalFilename: value.file_name,
    mimeType: value.mime_type,
    sizeBytes,
    locator: { provider: 'telegram', fileId: value.file_id }
  };
}

export function discoverTelegramAttachments(message: any, config: AttachmentConfig): AttachmentDescriptor[] {
  const descriptors: AttachmentDescriptor[] = [];
  if (Array.isArray(message?.photo) && message.photo.length > 0) {
    const variants = message.photo.filter((value: any) =>
      value && typeof value.file_id === 'string' && typeof value.file_unique_id === 'string');
    const eligible = variants.filter((value: any) => finiteSize(value.file_size) === undefined || value.file_size <= config.maxBytes);
    const candidates = eligible.length > 0 ? eligible : variants;
    const selected = candidates.sort((left: any, right: any) =>
      (finiteSize(right.file_size) || (right.width || 0) * (right.height || 0)) -
      (finiteSize(left.file_size) || (left.width || 0) * (left.height || 0))
    )[0];
    const descriptor = telegramDescriptor(selected, 'photo');
    if (descriptor) {
      descriptor.originalFilename = 'photo.jpg';
      descriptor.mimeType = descriptor.mimeType || 'image/jpeg';
      if (eligible.length === 0) descriptor.rejectionCode = 'SOURCE_TOO_LARGE';
      descriptors.push(descriptor);
    }
  }

  for (const type of ['document', 'video', 'audio', 'voice'] as const) {
    const descriptor = telegramDescriptor(message?.[type], type);
    if (!descriptor) continue;
    if (descriptor.sizeBytes !== undefined && descriptor.sizeBytes > config.maxBytes) {
      descriptor.rejectionCode = 'SOURCE_TOO_LARGE';
    }
    descriptors.push(descriptor);
  }
  return descriptors;
}

export function discoverChatwootAttachments(payload: any, config: AttachmentConfig): AttachmentDescriptor[] {
  if (!Array.isArray(payload?.attachments)) return [];
  return payload.attachments.flatMap((value: any): AttachmentDescriptor[] => {
    if (value?.id === undefined || String(value.id).length > 128 || typeof value?.data_url !== 'string') return [];
    const type: AttachmentType = ['image', 'photo'].includes(value.file_type)
      ? 'photo'
      : ['video', 'audio', 'voice'].includes(value.file_type)
        ? value.file_type
        : 'document';
    const sizeBytes = finiteSize(value.file_size);
    return [{
      sourceAttachmentRef: String(value.id),
      attachmentType: type,
      originalFilename: value.file_name,
      mimeType: value.content_type,
      sizeBytes,
      locator: { provider: 'chatwoot', dataUrl: value.data_url.slice(0, 2048) },
      rejectionCode: value.data_url.length > 2048
        ? 'INVALID_METADATA'
        : sizeBytes !== undefined && sizeBytes > config.maxBytes
          ? 'SOURCE_TOO_LARGE'
          : undefined
    }];
  });
}
