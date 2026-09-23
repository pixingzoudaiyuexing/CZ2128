import { AttachmentConfig } from '../config/attachments';
import { AttachmentDescriptor, AttachmentType, isSafeInlineImageMime } from '../core/attachments';

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
      if (eligible.length === 0) descriptor.rejectionCode = 'ATTACHMENT_SOURCE_TOO_LARGE';
      descriptors.push(descriptor);
    }
  }

  for (const type of ['document', 'video', 'audio', 'voice'] as const) {
    const descriptor = telegramDescriptor(message?.[type], type);
    if (!descriptor) continue;
    if (descriptor.sizeBytes !== undefined && descriptor.sizeBytes > config.maxBytes) {
      descriptor.rejectionCode = 'ATTACHMENT_SOURCE_TOO_LARGE';
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
        ? 'ATTACHMENT_SOURCE_INVALID'
        : sizeBytes !== undefined && sizeBytes > config.maxBytes
          ? 'ATTACHMENT_SOURCE_TOO_LARGE'
          : undefined
    }];
  });
}

export function discoverCrispAttachments(payload: any, config: AttachmentConfig): AttachmentDescriptor[] {
  if (payload?.event !== 'message:send') return [];
  const data = payload?.data;
  if (!data || data.type !== 'file' || data.from !== 'user') return [];
  const content = data.content;
  if (!content || typeof content !== 'object') return [];
  if (typeof content.type !== 'string' || !isSafeInlineImageMime(content.type)) return [];
  if (typeof content.url !== 'string' || content.url.length === 0 || content.url.length > 2048) return [];
  const messageRef = data.fingerprint === undefined ? '' : String(data.fingerprint);
  if (!messageRef || messageRef.length > 256) return [];
  const descriptor: AttachmentDescriptor = {
    sourceAttachmentRef: 'file',
    attachmentType: 'photo',
    originalFilename: typeof content.name === 'string' ? content.name : undefined,
    mimeType: content.type,
    locator: { provider: 'crisp', dataUrl: content.url }
  };
  const declaredSize = finiteSize(content.size);
  if (declaredSize !== undefined) {
    descriptor.sizeBytes = declaredSize;
    if (declaredSize > config.maxBytes) descriptor.rejectionCode = 'ATTACHMENT_SOURCE_TOO_LARGE';
  }
  return [descriptor];
}
