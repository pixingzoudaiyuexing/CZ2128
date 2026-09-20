import {
  DlqEventSource,
  DlqEventType,
  DlqQueueMessage,
  sanitizeDlqMessage
} from './dlq-consumer';
import { LEGACY_DLQ_QUEUE_NAME } from '../config/queue-identities';

const QUARANTINE_PREFIX = 'terminal-dlq/v1/';
const QUARANTINE_SCHEMA_VERSION = 1;
const QUARANTINE_REASON = 'D1_DLQ_RECEIPT_PERSIST_FAILED';
const QUARANTINE_STATE = 'QUARANTINED';
const MAX_LIST_OBJECTS = 1000;

export interface DlqQuarantineReceipt {
  schemaVersion: 1;
  quarantineId: string;
  canonicalReceiptId: string;
  queueName: string;
  eventSource: DlqEventSource | null;
  eventType: DlqEventType | null;
  queueAttempts: number | null;
  messageTimestamp: number | null;
  reason: typeof QUARANTINE_REASON;
  state: typeof QUARANTINE_STATE;
}

export interface DlqQuarantineEntry extends DlqQuarantineReceipt {
  uploadedAt: number;
}

export interface DlqQuarantineList {
  entries: DlqQuarantineEntry[];
  visibleCount: number;
  truncated: boolean;
  invalidMetadataCount: number;
}

function boundedAttempts(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 1000
    ? Number(value)
    : null;
}

function safeTimestamp(value: unknown): number | null {
  if (!(value instanceof Date)) return null;
  const seconds = Math.floor(value.getTime() / 1000);
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : null;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function quarantineIdentity(queueName: string, messageId: string): Promise<string> {
  const digest = await sha256Hex(`cz2128-dlq-quarantine:v1\nqueue=${queueName}\nmessage=${messageId}`);
  return `dlq-quarantine:v1:${digest}`;
}

function objectKey(quarantineId: string): string {
  return `${QUARANTINE_PREFIX}${quarantineId.slice('dlq-quarantine:v1:'.length)}.json`;
}

function metadata(receipt: DlqQuarantineReceipt): Record<string, string> {
  return {
    schemaVersion: String(receipt.schemaVersion),
    quarantineId: receipt.quarantineId,
    canonicalReceiptId: receipt.canonicalReceiptId,
    queueName: receipt.queueName,
    eventSource: receipt.eventSource || '',
    eventType: receipt.eventType || '',
    queueAttempts: receipt.queueAttempts === null ? '' : String(receipt.queueAttempts),
    messageTimestamp: receipt.messageTimestamp === null ? '' : String(receipt.messageTimestamp),
    reason: receipt.reason,
    state: receipt.state
  };
}

function validHashIdentity(value: unknown, prefix: string): value is string {
  return typeof value === 'string' && new RegExp(`^${prefix}[0-9a-f]{64}$`).test(value);
}

function parseOptionalEnum<T extends string>(value: unknown, allowed: ReadonlySet<string>): T | null | undefined {
  if (value === '') return null;
  return typeof value === 'string' && allowed.has(value) ? value as T : undefined;
}

function parseOptionalInteger(value: unknown): number | null | undefined {
  if (value === '') return null;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseMetadata(object: R2Object, expectedQueueName: string): DlqQuarantineEntry | null {
  const meta = object.customMetadata;
  if (!meta || meta.schemaVersion !== '1') return null;
  if (!validHashIdentity(meta.quarantineId, 'dlq-quarantine:v1:')) return null;
  if (!validHashIdentity(meta.canonicalReceiptId, 'dlq:v1:')) return null;
  if (meta.queueName !== expectedQueueName) return null;
  if (meta.reason !== QUARANTINE_REASON || meta.state !== QUARANTINE_STATE) return null;
  const sources = new Set(['chatwoot', 'telegram', 'internal']);
  const types = new Set(['message_created', 'conversation_status_changed', 'ai_trigger', 'attachment_transfer']);
  const eventSource = parseOptionalEnum<DlqEventSource>(meta.eventSource, sources);
  const eventType = parseOptionalEnum<DlqEventType>(meta.eventType, types);
  const queueAttempts = parseOptionalInteger(meta.queueAttempts);
  const messageTimestamp = parseOptionalInteger(meta.messageTimestamp);
  if (eventSource === undefined || eventType === undefined || queueAttempts === undefined || messageTimestamp === undefined) {
    return null;
  }
  return {
    schemaVersion: 1,
    quarantineId: meta.quarantineId,
    canonicalReceiptId: meta.canonicalReceiptId,
    queueName: meta.queueName,
    eventSource,
    eventType,
    queueAttempts,
    messageTimestamp,
    reason: QUARANTINE_REASON,
    state: QUARANTINE_STATE,
    uploadedAt: Math.floor(object.uploaded.getTime() / 1000)
  };
}

export async function persistDlqQuarantine(
  bucket: R2Bucket,
  message: DlqQueueMessage,
  queueName = LEGACY_DLQ_QUEUE_NAME
): Promise<DlqQuarantineReceipt> {
  if (typeof message.id !== 'string' || message.id.length === 0) {
    throw new Error('Invalid Cloudflare Queue message identity');
  }
  const sanitized = await sanitizeDlqMessage(message, queueName);
  const receipt: DlqQuarantineReceipt = {
    schemaVersion: QUARANTINE_SCHEMA_VERSION,
    quarantineId: await quarantineIdentity(queueName, message.id),
    canonicalReceiptId: sanitized.receiptId,
    queueName,
    eventSource: sanitized.eventSource,
    eventType: sanitized.eventType,
    queueAttempts: boundedAttempts(message.attempts),
    messageTimestamp: safeTimestamp(message.timestamp),
    reason: QUARANTINE_REASON,
    state: QUARANTINE_STATE
  };
  await bucket.put(objectKey(receipt.quarantineId), JSON.stringify(receipt), {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: metadata(receipt)
  });
  return receipt;
}

export async function listDlqQuarantine(
  bucket: R2Bucket,
  limit = 10,
  expectedQueueName = LEGACY_DLQ_QUEUE_NAME
): Promise<DlqQuarantineList> {
  const boundedLimit = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), 10) : 10;
  const result = await bucket.list({
    prefix: QUARANTINE_PREFIX,
    limit: MAX_LIST_OBJECTS,
    include: ['customMetadata']
  });
  const parsed = result.objects.map(object => parseMetadata(object, expectedQueueName));
  const entries = parsed
    .filter((entry): entry is DlqQuarantineEntry => entry !== null)
    .sort((left, right) => right.uploadedAt - left.uploadedAt || left.quarantineId.localeCompare(right.quarantineId))
    .slice(0, boundedLimit);
  return {
    entries,
    visibleCount: result.objects.length,
    truncated: result.truncated,
    invalidMetadataCount: parsed.filter(entry => entry === null).length
  };
}
