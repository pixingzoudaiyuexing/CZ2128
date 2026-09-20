import { Env } from '../config/env';
import { EventReceipt } from '../core/domain';
import { SafeErrorCode, isSafeErrorCode } from '../core/error-taxonomy';
import { LEGACY_DLQ_QUEUE_NAME } from '../config/queue-identities';

const MAX_IDENTITY_LENGTH = 256;
const VALID_SOURCES = new Set(['chatwoot', 'telegram', 'internal']);
const VALID_TYPES = new Set([
  'message_created',
  'conversation_status_changed',
  'ai_trigger',
  'attachment_transfer'
]);

type DlqStatus = 'OPEN' | 'RESOLVED';
export type DlqEventSource = 'chatwoot' | 'telegram' | 'internal';
export type DlqEventType = 'message_created' | 'conversation_status_changed' | 'ai_trigger' | 'attachment_transfer';

export interface DlqQueueMessage {
  readonly id: string;
  readonly body: unknown;
  readonly attempts?: number;
  readonly timestamp?: Date;
}

export interface DlqReceipt {
  id: string;
  queue_name: string;
  event_source: string | null;
  source_event_ref: string | null;
  event_type: string | null;
  conversation_id: string | null;
  operation_id: string | null;
  safe_error_code: SafeErrorCode;
  status: DlqStatus;
  delivery_count: number;
  first_seen_at: number;
  last_seen_at: number;
  resolved_at: number | null;
}

export interface CapturedDlqReceipt {
  id: string;
}

type DlqLookup =
  | { kind: 'chatwoot'; accountRef: string; conversationRef: string }
  | { kind: 'telegram'; threadRef: string }
  | { kind: 'ai'; conversationId: string }
  | { kind: 'attachment'; attachmentId: string };

interface SanitizedEnvelope {
  source: DlqEventSource;
  type: DlqEventType;
  eventId: string;
  lookup: DlqLookup;
}

export interface SanitizedDlqMessage {
  receiptId: string;
  queueName: string;
  eventSource: DlqEventSource | null;
  sourceEventRef: string | null;
  eventType: DlqEventType | null;
}

interface ParsedDlqMessage {
  sanitized: SanitizedDlqMessage;
  lookup: DlqLookup | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedIdentity(value: unknown): string | null {
  if (
    typeof value !== 'string' || value.length === 0 ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    new TextEncoder().encode(value).length > MAX_IDENTITY_LENGTH
  ) return null;
  return value;
}

function parseEnvelope(body: unknown): SanitizedEnvelope | null {
  if (!isRecord(body) || body.version !== 1 || !isRecord(body.payload)) return null;
  const eventId = boundedIdentity(body.eventId);
  const source = typeof body.source === 'string' && VALID_SOURCES.has(body.source)
    ? body.source as DlqEventSource
    : null;
  const type = typeof body.type === 'string' && VALID_TYPES.has(body.type)
    ? body.type as DlqEventType
    : null;
  if (!eventId || !source || !type) return null;

  const payload = body.payload;
  if (source === 'chatwoot') {
    if (type !== 'message_created' && type !== 'conversation_status_changed') return null;
    const accountRef = boundedIdentity(payload.accountRef);
    const conversationRef = boundedIdentity(payload.conversationRef);
    if (!accountRef || !conversationRef) return null;
    return { source, type, eventId, lookup: { kind: 'chatwoot', accountRef, conversationRef } };
  } else if (source === 'telegram') {
    const threadRef = boundedIdentity(payload.threadRef);
    if (type !== 'message_created' || !threadRef) return null;
    return { source, type, eventId, lookup: { kind: 'telegram', threadRef } };
  } else if (type === 'ai_trigger') {
    const conversationId = boundedIdentity(payload.convId);
    if (!conversationId) return null;
    return { source, type, eventId, lookup: { kind: 'ai', conversationId } };
  } else if (type === 'attachment_transfer') {
    const attachmentId = boundedIdentity(payload.attachmentId);
    if (!attachmentId) return null;
    return { source, type, eventId, lookup: { kind: 'attachment', attachmentId } };
  } else {
    return null;
  }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function receiptIdentity(queueName: string, event: SanitizedEnvelope | null, messageId: string): Promise<string> {
  const canonical = event
    ? `cz2128-dlq-receipt:v1\nqueue=${queueName}\nsource=${event.source}\nevent=${event.eventId}`
    : `cz2128-dlq-receipt:v1\nqueue=${queueName}\nmessage=${messageId}`;
  return `dlq:v1:${await sha256Hex(canonical)}`;
}

async function parseDlqMessage(
  message: DlqQueueMessage,
  queueName = LEGACY_DLQ_QUEUE_NAME
): Promise<ParsedDlqMessage> {
  if (typeof message.id !== 'string' || message.id.length === 0) {
    throw new Error('Invalid Cloudflare Queue message identity');
  }
  const event = parseEnvelope(message.body);
  return {
    sanitized: {
      receiptId: await receiptIdentity(queueName, event, message.id),
      queueName,
      eventSource: event?.source || null,
      sourceEventRef: event?.eventId || null,
      eventType: event?.type || null
    },
    lookup: event?.lookup || null
  };
}

export async function sanitizeDlqMessage(
  message: DlqQueueMessage,
  queueName = LEGACY_DLQ_QUEUE_NAME
): Promise<SanitizedDlqMessage> {
  return (await parseDlqMessage(message, queueName)).sanitized;
}

async function resolveConversationId(env: Pick<Env, 'DB'>, lookup: DlqLookup): Promise<string | null> {
  if (lookup.kind === 'chatwoot') {
    const row = await env.DB.prepare(
      `SELECT id FROM conversations
       WHERE helpdesk_provider = 'chatwoot' AND helpdesk_account_ref = ? AND helpdesk_conversation_ref = ?`
    ).bind(lookup.accountRef, lookup.conversationRef).first<{ id: string }>();
    return boundedIdentity(row?.id);
  }
  if (lookup.kind === 'telegram') {
    const row = await env.DB.prepare(
      `SELECT id FROM conversations WHERE operator_channel = 'telegram' AND operator_thread_ref = ?`
    ).bind(lookup.threadRef).first<{ id: string }>();
    return boundedIdentity(row?.id);
  }
  if (lookup.kind === 'ai') {
    const row = await env.DB.prepare('SELECT id FROM conversations WHERE id = ?')
      .bind(lookup.conversationId).first<{ id: string }>();
    return boundedIdentity(row?.id);
  }
  const row = await env.DB.prepare('SELECT conversation_id FROM attachments WHERE id = ?')
    .bind(lookup.attachmentId).first<{ conversation_id: string }>();
  return boundedIdentity(row?.conversation_id);
}

export async function captureDlqMessage(
  env: Pick<Env, 'DB'>,
  message: DlqQueueMessage,
  now = Math.floor(Date.now() / 1000),
  queueName = LEGACY_DLQ_QUEUE_NAME
): Promise<CapturedDlqReceipt> {
  const parsed = await parseDlqMessage(message, queueName);
  const sanitized = parsed.sanitized;
  let eventReceipt: Pick<EventReceipt, 'status' | 'last_error' | 'conversation_id'> | null = null;
  let conversationId: string | null = null;

  if (sanitized.eventSource && sanitized.sourceEventRef) {
    eventReceipt = await env.DB.prepare(
      `SELECT status, last_error, conversation_id FROM event_receipts
       WHERE source = ? AND source_event_ref = ?`
    ).bind(sanitized.eventSource, sanitized.sourceEventRef)
      .first<Pick<EventReceipt, 'status' | 'last_error' | 'conversation_id'>>();
    conversationId = boundedIdentity(eventReceipt?.conversation_id) || (
      parsed.lookup ? await resolveConversationId(env, parsed.lookup) : null
    );
  }

  const safeErrorCode = isSafeErrorCode(eventReceipt?.last_error)
    ? eventReceipt.last_error
    : 'QUEUE_RETRY_EXHAUSTED';

  const upsert = env.DB.prepare(
    `INSERT INTO dlq_receipts (
       id, queue_name, event_source, source_event_ref, event_type, conversation_id,
       operation_id, safe_error_code, status, delivery_count, first_seen_at, last_seen_at, resolved_at
     )
     SELECT ?, ?, ?, ?, ?, ?, NULL, ?,
            CASE WHEN canonical.processed = 1 THEN 'RESOLVED' ELSE 'OPEN' END,
            1, ?, ?, CASE WHEN canonical.processed = 1 THEN ? ELSE NULL END
     FROM (
       SELECT CASE
         WHEN ? IS NOT NULL AND EXISTS (
           SELECT 1 FROM event_receipts
           WHERE source = ? AND source_event_ref = ? AND status = 'PROCESSED'
         ) THEN 1 ELSE 0
       END AS processed
     ) AS canonical
     WHERE 1
     ON CONFLICT (id) DO UPDATE SET
       event_source = COALESCE(dlq_receipts.event_source, excluded.event_source),
       source_event_ref = COALESCE(dlq_receipts.source_event_ref, excluded.source_event_ref),
       event_type = COALESCE(dlq_receipts.event_type, excluded.event_type),
       conversation_id = COALESCE(dlq_receipts.conversation_id, excluded.conversation_id),
       safe_error_code = excluded.safe_error_code,
       status = CASE
         WHEN dlq_receipts.status = 'RESOLVED' OR excluded.status = 'RESOLVED' THEN 'RESOLVED'
         ELSE 'OPEN'
       END,
       delivery_count = dlq_receipts.delivery_count + 1,
       last_seen_at = MAX(dlq_receipts.last_seen_at, excluded.last_seen_at),
       resolved_at = COALESCE(dlq_receipts.resolved_at, excluded.resolved_at)`
  ).bind(
    sanitized.receiptId,
    sanitized.queueName,
    sanitized.eventSource,
    sanitized.sourceEventRef,
    sanitized.eventType,
    conversationId,
    safeErrorCode,
    now,
    now,
    now,
    sanitized.eventSource,
    sanitized.eventSource,
    sanitized.sourceEventRef
  );

  const statements: D1PreparedStatement[] = [upsert];
  if (sanitized.eventSource && sanitized.sourceEventRef && sanitized.eventType) {
    statements.push(env.DB.prepare(
      `UPDATE event_receipts
       SET dead_lettered_at = ?, last_attempt_at = ?,
           event_type = COALESCE(event_type, ?),
           conversation_id = COALESCE(conversation_id, ?)
       WHERE source = ? AND source_event_ref = ?`
    ).bind(
      now,
      now,
      sanitized.eventType,
      conversationId,
      sanitized.eventSource,
      sanitized.sourceEventRef
    ));
  }

  await env.DB.batch(statements);
  return { id: sanitized.receiptId };
}
