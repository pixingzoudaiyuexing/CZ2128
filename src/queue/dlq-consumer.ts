import { Env } from '../config/env';
import { EventReceipt } from '../core/domain';
import { SafeErrorCode, isSafeErrorCode } from '../core/error-taxonomy';

const DLQ_QUEUE_NAME = 'cz2128-dlq';
const MAX_IDENTITY_LENGTH = 256;
const VALID_SOURCES = new Set(['chatwoot', 'telegram', 'internal']);
const VALID_TYPES = new Set([
  'message_created',
  'conversation_status_changed',
  'ai_trigger',
  'attachment_transfer'
]);

type DlqStatus = 'OPEN' | 'RESOLVED';

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

interface SanitizedEnvelope {
  source: 'chatwoot' | 'telegram' | 'internal';
  type: 'message_created' | 'conversation_status_changed' | 'ai_trigger' | 'attachment_transfer';
  eventId: string;
  payload: Record<string, unknown>;
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
  const source = typeof body.source === 'string' && VALID_SOURCES.has(body.source) ? body.source : null;
  const type = typeof body.type === 'string' && VALID_TYPES.has(body.type) ? body.type : null;
  if (!eventId || !source || !type) return null;

  const payload = body.payload;
  if (source === 'chatwoot') {
    if (type !== 'message_created' && type !== 'conversation_status_changed') return null;
    if (!boundedIdentity(payload.accountRef) || !boundedIdentity(payload.conversationRef)) return null;
  } else if (source === 'telegram') {
    if (type !== 'message_created' || !boundedIdentity(payload.threadRef)) return null;
  } else if (type === 'ai_trigger') {
    if (!boundedIdentity(payload.convId)) return null;
  } else if (type === 'attachment_transfer') {
    if (!boundedIdentity(payload.attachmentId)) return null;
  } else {
    return null;
  }

  return { source, type, eventId, payload } as SanitizedEnvelope;
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

async function resolveConversationId(env: Pick<Env, 'DB'>, event: SanitizedEnvelope): Promise<string | null> {
  if (event.source === 'chatwoot') {
    const accountRef = boundedIdentity(event.payload.accountRef)!;
    const conversationRef = boundedIdentity(event.payload.conversationRef)!;
    const row = await env.DB.prepare(
      `SELECT id FROM conversations
       WHERE helpdesk_provider = 'chatwoot' AND helpdesk_account_ref = ? AND helpdesk_conversation_ref = ?`
    ).bind(accountRef, conversationRef).first<{ id: string }>();
    return boundedIdentity(row?.id);
  }
  if (event.source === 'telegram') {
    const threadRef = boundedIdentity(event.payload.threadRef)!;
    const row = await env.DB.prepare(
      `SELECT id FROM conversations WHERE operator_channel = 'telegram' AND operator_thread_ref = ?`
    ).bind(threadRef).first<{ id: string }>();
    return boundedIdentity(row?.id);
  }
  if (event.type === 'ai_trigger') {
    const convId = boundedIdentity(event.payload.convId)!;
    const row = await env.DB.prepare('SELECT id FROM conversations WHERE id = ?')
      .bind(convId).first<{ id: string }>();
    return boundedIdentity(row?.id);
  }
  const attachmentId = boundedIdentity(event.payload.attachmentId)!;
  const row = await env.DB.prepare('SELECT conversation_id FROM attachments WHERE id = ?')
    .bind(attachmentId).first<{ conversation_id: string }>();
  return boundedIdentity(row?.conversation_id);
}

export async function captureDlqMessage(
  env: Pick<Env, 'DB'>,
  message: Pick<Message<unknown>, 'id' | 'body'>,
  now = Math.floor(Date.now() / 1000),
  queueName = DLQ_QUEUE_NAME
): Promise<CapturedDlqReceipt> {
  if (typeof message.id !== 'string' || message.id.length === 0) {
    throw new Error('Invalid Cloudflare Queue message identity');
  }

  const event = parseEnvelope(message.body);
  const id = await receiptIdentity(queueName, event, message.id);
  let eventReceipt: Pick<EventReceipt, 'status' | 'last_error' | 'conversation_id'> | null = null;
  let conversationId: string | null = null;

  if (event) {
    eventReceipt = await env.DB.prepare(
      `SELECT status, last_error, conversation_id FROM event_receipts
       WHERE source = ? AND source_event_ref = ?`
    ).bind(event.source, event.eventId).first<Pick<EventReceipt, 'status' | 'last_error' | 'conversation_id'>>();
    conversationId = boundedIdentity(eventReceipt?.conversation_id) || await resolveConversationId(env, event);
  }

  const resolved = eventReceipt?.status === 'PROCESSED';
  const safeErrorCode = isSafeErrorCode(eventReceipt?.last_error)
    ? eventReceipt.last_error
    : 'QUEUE_RETRY_EXHAUSTED';

  const upsert = env.DB.prepare(
    `INSERT INTO dlq_receipts (
       id, queue_name, event_source, source_event_ref, event_type, conversation_id,
       operation_id, safe_error_code, status, delivery_count, first_seen_at, last_seen_at, resolved_at
     ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, 1, ?, ?, ?)
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
    id,
    queueName,
    event?.source || null,
    event?.eventId || null,
    event?.type || null,
    conversationId,
    safeErrorCode,
    resolved ? 'RESOLVED' : 'OPEN',
    now,
    now,
    resolved ? now : null
  );

  const statements: D1PreparedStatement[] = [upsert];
  if (event) {
    statements.push(env.DB.prepare(
      `UPDATE event_receipts
       SET dead_lettered_at = ?, last_attempt_at = ?,
           event_type = COALESCE(event_type, ?),
           conversation_id = COALESCE(conversation_id, ?)
       WHERE source = ? AND source_event_ref = ?`
    ).bind(now, now, event.type, conversationId, event.source, event.eventId));
  }

  await env.DB.batch(statements);
  return { id };
}
