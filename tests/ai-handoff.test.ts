import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleQueueEvent } from '../src/queue/consumer';
import { pauseOperator, pauseManual, resumeManual } from '../src/core/ai-state';
import { SupportEvent } from '../src/core/events';
import { executeOutboundOperation } from '../src/core/outbound-operations';
import { CancelledBeforeDeliveryError, RetryableProcessingError } from '../src/core/errors';

class MockPreparedStatement {
  constructor(private db: MockD1, private query: string) {}
  private boundParams: any[] = [];
  bind(...params: any[]) { this.boundParams = params; return this; }
  async first<T = any>(): Promise<T | null> {
    const conversation = (row: any) => row ? {
      helpdesk_provider: 'chatwoot',
      helpdesk_account_ref: 'account',
      helpdesk_conversation_ref: row.id,
      ...row
    } : null;
    if (this.query.includes('FROM event_receipts')) {
      const row = this.db.tables.event_receipts.find(item => item.source === this.boundParams[0] && item.source_event_ref === this.boundParams[1]);
      return row ? { ...row } : null;
    }
    if (this.query.includes('FROM outbound_operations')) {
      const row = this.db.tables.outbound_operations.find(item => item.id === this.boundParams[0]);
      return row ? { ...row } : null;
    }
    if (this.query.includes('FROM ai_runs')) {
      const row = this.db.tables.ai_runs.find(item => item.trigger_event_ref === this.boundParams[0]);
      return row ? { ...row } : null;
    }
    if (this.query.includes("FROM messages WHERE provider = 'ai'")) {
      const row = this.db.tables.messages.find(item =>
        item.provider === 'ai' && item.provider_message_ref === this.boundParams[0]);
      return row ? { ...row } : null;
    }
    if (this.query.includes('FROM conversations')) {
      if (this.query.includes('helpdesk_provider = ?')) {
        const row = this.db.tables.conversations.find(row =>
          String(row.helpdesk_account_ref) === String(this.boundParams[1]) &&
          String(row.helpdesk_conversation_ref) === String(this.boundParams[2]));
        return conversation(row);
      }
      if (this.query.includes('operator_channel = ?')) {
        const row = this.db.tables.conversations.find(row =>
          row.operator_channel === this.boundParams[0] && row.operator_thread_ref === this.boundParams[1]);
        return conversation(row);
      }
      const row = this.db.tables.conversations.find(row => row.id === this.boundParams[0]);
      return conversation(row);
    }
    return null;
  }
  async all() {
    if (this.query.includes('FROM outbound_operations') && this.query.includes('id IN')) {
      return {
        results: this.db.tables.outbound_operations
          .filter(item => item.id === this.boundParams[0] || item.id === this.boundParams[1])
          .map(item => ({ ...item }))
      };
    }
    if (this.query.includes('FROM messages')) {
      const msgs = [...this.db.tables.messages].filter(m => m.conversation_id === this.boundParams[0]);
      // TASK 8: Context Same-Second Ordering Mock. 
      // Emulate: ORDER BY created_at DESC, _rowid DESC
      msgs.sort((a, b) => {
        if (b.created_at !== a.created_at) return b.created_at - a.created_at;
        return (b._rowid || 0) - (a._rowid || 0);
      });
      return { results: msgs.slice(0, this.boundParams[1]) };
    }
    return { results: [] };
  }
  async run() {
    const meta = { changes: 0 };

    if (this.query.includes("status = 'SENDING'") && this.query.includes("lease_until = ?")) {
      const [lu, leaseToken, now, id] = this.boundParams;
      const o = this.db.tables.outbound_operations.find(x => x.id === id);
      if (o && (o.status === 'PENDING' || o.status === 'FAILED_RETRYABLE')) {
        o.status = 'SENDING'; o.lease_until = lu; o.lease_token = leaseToken; o.request_started_at = null; o.response_observed_at = null; o.response_http_status = null;
        return { meta: { changes: 1 } };
      }
    }
    if (this.query.includes("request_started_at = ?, attempt_count = attempt_count + 1")) {
      const [ts, , id, leaseToken] = this.boundParams;
      const o = this.db.tables.outbound_operations.find(x => x.id === id);
      if (o && o.status === 'SENDING' && o.lease_token === leaseToken && o.request_started_at == null) {
        o.request_started_at = ts;
        o.attempt_count++;
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }
    if (this.query.includes("response_observed_at = ?")) {
      const [ts, hs, , id, leaseToken] = this.boundParams;
      const o = this.db.tables.outbound_operations.find(x => x.id === id);
      if (o && o.status === 'SENDING' && o.lease_token === leaseToken && o.request_started_at != null) {
        o.response_observed_at = ts;
        o.response_http_status = hs;
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }
    if (this.query.includes("status = 'PENDING', lease_until = NULL, lease_token = NULL,") && this.query.includes("request_started_at IS NULL")) {
      const [uat, id, lut, leaseToken] = this.boundParams;
      const o = this.db.tables.outbound_operations.find(x => x.id === id);
      if (o && o.status === 'SENDING' && (o.lease_until || 0) <= lut && o.lease_token === leaseToken && o.request_started_at === null) {
        o.status = 'PENDING';
        o.lease_until = null;
        o.lease_token = null;
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }
    if (this.query.includes("status = 'AMBIGUOUS', reconciliation_status = 'PENDING'") && this.query.includes("lease_until <=")) {
      const [uat, id, lut, leaseToken] = this.boundParams;
      const o = this.db.tables.outbound_operations.find(x => x.id === id);
      if (o && o.status === 'SENDING' && (o.lease_until === null || (o.lease_until || 0) <= lut) && (!o.lease_token || o.lease_token === leaseToken)) {
        o.status = 'AMBIGUOUS';
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }
    if (this.query.includes("status = 'FAILED_FINAL', last_error = 'OUTBOUND_RETRY_EXHAUSTED'")) {
      const [now, id] = this.boundParams;
      const o = this.db.tables.outbound_operations.find(x => x.id === id);
      if (o && (o.status === 'PENDING' || o.status === 'FAILED_RETRYABLE')) {
        o.status = 'FAILED_FINAL';
        o.last_error = 'OUTBOUND_RETRY_EXHAUSTED';
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }
    if (this.query.includes("status = 'SENT'") && this.query.includes("provider_message_ref = ?")) {
      const [pmr, now, id, leaseToken] = this.boundParams;
      const o = this.db.tables.outbound_operations.find(x => x.id === id);
      if (o?.status === 'SENDING' && o.lease_token === leaseToken) {
        o.status = 'SENT'; o.provider_message_ref = pmr; o.lease_until = null; o.lease_token = null; 
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }
    if (this.query.includes("status = ?, last_error = ?, lease_until = NULL")) {
      const [status, err, rec, rSec, nAt, now, id, leaseToken] = this.boundParams;
      const o = this.db.tables.outbound_operations.find(x => x.id === id);
      if (o?.status === 'SENDING' && o.lease_token === leaseToken) {
        o.status = status; o.last_error = err; o.lease_until = null; o.lease_token = null; 
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }
    if (this.query.includes("status = 'AMBIGUOUS', last_error = 'OUTBOUND_MANUAL_RECONCILIATION_REQUIRED'")) {
      const [now, id, leaseToken] = this.boundParams;
      const o = this.db.tables.outbound_operations.find(x => x.id === id);
      if (o?.status === 'SENDING' && o.lease_token === leaseToken) {
        o.status = 'AMBIGUOUS'; o.lease_until = null; o.lease_token = null; 
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }
    if (this.query.includes("status = 'FAILED_FINAL', last_error = ?")) {
      const [err, now, id] = this.boundParams;
      const o = this.db.tables.outbound_operations.find(x => x.id === id);
      if (o && (o.status === 'PENDING' || o.status === 'FAILED_RETRYABLE')) {
        o.status = 'FAILED_FINAL'; o.last_error = err; 
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }
  
if (this.query.includes('INSERT INTO conversations')) {
      const [id, provider, accountRef, conversationRef, customerRef, operatorChannel, createdAt, updatedAt, version] = this.boundParams;
      const existing = this.db.tables.conversations.find(row =>
        String(row.helpdesk_account_ref) === String(accountRef) &&
        String(row.helpdesk_conversation_ref) === String(conversationRef));
      if (!existing) {
        this.db.tables.conversations.push({
          id, helpdesk_provider: provider, helpdesk_account_ref: accountRef,
          helpdesk_conversation_ref: conversationRef, customer_ref: customerRef,
          operator_channel: operatorChannel, operator_thread_ref: null,
          operator_thread_status: 'OPEN', ai_mode: 'ENABLED', ai_handoff_epoch: 0,
          created_at: createdAt, updated_at: updatedAt, version
        });
        meta.changes = 1;
      }
    } else if (this.query.includes('UPDATE conversations SET operator_thread_ref')) {
      const [threadRef, updatedAt, id] = this.boundParams;
      const row = this.db.tables.conversations.find(item => item.id === id);
      if (row && !row.operator_thread_ref) {
        row.operator_thread_ref = threadRef;
        row.updated_at = updatedAt;
        row.version = (row.version || 1) + 1;
        meta.changes = 1;
      }
    } else if (this.query.includes('last_telegram_operator_update_id = ?')) {
      const isHumanReply = this.query.includes('last_operator_reply_at = ?');
      const isModeTransition = this.query.includes('AND ai_mode != ?');
      let operatorReplyAt: any;
      let profileVersion: any;
      let updateId: any;
      let updatedAt: any;
      let id: any;
      let expectedProfileVersion: any;
      let expectedUpdateId: any;
      let desiredMode: any;
      if (isHumanReply) {
        [operatorReplyAt, profileVersion, updateId, updatedAt, id, expectedProfileVersion, , expectedUpdateId] = this.boundParams;
      } else if (isModeTransition) {
        [profileVersion, updateId, updatedAt, id, desiredMode, expectedProfileVersion, , expectedUpdateId] = this.boundParams;
      } else {
        [profileVersion, updateId, updatedAt, id, expectedProfileVersion, , expectedUpdateId] = this.boundParams;
      }
      const row = this.db.tables.conversations.find(item => item.id === id);
      const storedProfileVersion = Number(row?.last_telegram_operator_profile_version || 0);
      const ordered = row && (
        storedProfileVersion < Number(expectedProfileVersion) ||
        (storedProfileVersion === Number(expectedProfileVersion) &&
          (row.last_telegram_operator_update_id === undefined || row.last_telegram_operator_update_id === null ||
            Number(row.last_telegram_operator_update_id) < Number(expectedUpdateId)))
      );
      if (ordered && (!isModeTransition || row.ai_mode !== desiredMode)) {
        if (isHumanReply) {
          if (row.ai_mode !== 'PAUSED_MANUAL') {
            row.ai_mode = 'PAUSED_OPERATOR';
            row.ai_pause_source = 'TELEGRAM_OPERATOR';
          }
          row.last_operator_reply_at = operatorReplyAt;
          row.ai_handoff_epoch = (row.ai_handoff_epoch || 0) + 1;
        } else if (isModeTransition && this.query.includes("SET ai_mode = 'PAUSED_MANUAL'")) {
          row.ai_mode = 'PAUSED_MANUAL';
          row.ai_pause_source = 'MANUAL';
          row.ai_handoff_epoch = (row.ai_handoff_epoch || 0) + 1;
        } else if (isModeTransition) {
          row.ai_mode = 'ENABLED';
          row.ai_pause_source = null;
        }
        if (isHumanReply || isModeTransition) {
          row.ai_generation_id = null;
          row.ai_generation_started_at = null;
          row.ai_generation_message_id = null;
        }
        row.last_telegram_operator_profile_version = profileVersion;
        row.last_telegram_operator_update_id = updateId;
        row.updated_at = updatedAt;
        meta.changes = 1;
      } else if (ordered && !isHumanReply && !isModeTransition) {
        row.last_telegram_operator_profile_version = profileVersion;
        row.last_telegram_operator_update_id = updateId;
        row.updated_at = updatedAt;
        meta.changes = 1;
      }
    } else if (this.query.includes('last_operator_reply_at = ?') && this.query.includes('ai_handoff_epoch = ai_handoff_epoch + 1')) {
      const hasParameterizedPauseSource = this.query.includes('ai_pause_source = CASE') && this.query.includes('ELSE ? END');
      const id = hasParameterizedPauseSource ? this.boundParams[3] : this.boundParams[2];
      const lastOperatorReplyAt = hasParameterizedPauseSource ? this.boundParams[1] : this.boundParams[0];
      const row = this.db.tables.conversations.find(item => item.id === id);
      if (row) {
        if (row.ai_mode !== 'PAUSED_MANUAL') {
          row.ai_mode = 'PAUSED_OPERATOR';
          row.ai_pause_source = hasParameterizedPauseSource ? this.boundParams[0] : 'CRISP_OPERATOR';
        }
        row.last_operator_reply_at = lastOperatorReplyAt;
        row.ai_generation_id = null;
        row.ai_generation_started_at = null;
        row.ai_generation_message_id = null;
        row.ai_handoff_epoch = (row.ai_handoff_epoch || 0) + 1;
        meta.changes = 1;
      }
    } else if (this.query.includes("SET ai_mode = 'PAUSED_MANUAL'")) {
      const row = this.db.tables.conversations.find(item => item.id === this.boundParams[1]);
      if (row) {
        row.ai_mode = 'PAUSED_MANUAL';
        row.ai_generation_id = null;
        row.ai_handoff_epoch = (row.ai_handoff_epoch || 0) + 1;
        meta.changes = 1;
      }
    } else if (this.query.includes("SET ai_mode = 'ENABLED'") && this.query.includes("last_operator_reply_at = ?")) {
      const row = this.db.tables.conversations.find(item =>
        item.id === this.boundParams[1] && item.ai_mode === 'PAUSED_OPERATOR' && item.last_operator_reply_at === this.boundParams[2]);
      if (row) { row.ai_mode = 'ENABLED'; meta.changes = 1; }
    } else if (this.query.includes("SET ai_mode = 'ENABLED'") && this.query.includes("ai_generation_id = NULL")) {
      const row = this.db.tables.conversations.find(item => item.id === this.boundParams[1]);
      if (row) { row.ai_mode = 'ENABLED'; row.ai_generation_id = null; meta.changes = 1; }
    } else if (this.query.includes("SET ai_generation_id = ?") && this.query.includes("ai_mode = 'ENABLED'")) {
      const row = this.db.tables.conversations.find(item =>
        item.id === this.boundParams[4] && item.ai_mode === 'ENABLED' && Number(item.ai_handoff_epoch) === Number(this.boundParams[5]));
      if (row && (!row.ai_generation_id || row.ai_generation_started_at < this.boundParams[6])) {
        row.ai_generation_id = this.boundParams[0];
        row.ai_generation_started_at = this.boundParams[1];
        row.ai_generation_message_id = this.boundParams[2];
        meta.changes = 1;
      }
    } else if (this.query.includes("ai_generation_id = NULL") && this.query.includes("AND ai_generation_id = ?")) {
      const row = this.db.tables.conversations.find(item => item.id === this.boundParams[1] && item.ai_generation_id === this.boundParams[2]);
      if (row) { row.ai_generation_id = null; meta.changes = 1; }
    } else if (this.query.includes("INSERT INTO messages") && this.query.includes("VALUES (?, ?, 'ai', ?")) {
      this.db.messageSeq = (this.db.messageSeq || 0) + 1;
      const [id, conversationId, providerRef, textContent, createdAt] = this.boundParams;
      if (!this.db.tables.messages.some(row => row.provider === 'ai' && row.provider_message_ref === providerRef)) {
        this.db.tables.messages.push({
          id, conversation_id: conversationId, provider: 'ai', provider_message_ref: providerRef,
          direction: 'OUTBOUND', actor_role: 'AI', message_type: 'TEXT', text_content: textContent,
          created_at: createdAt, _rowid: this.db.messageSeq
        });
        meta.changes = 1;
      }
    } else if (this.query.includes('INSERT INTO messages')) {
      this.db.messageSeq = (this.db.messageSeq || 0) + 1;
      const provider = this.boundParams[2];
      const providerRef = this.boundParams[3];
      if (!this.db.tables.messages.some(row => row.provider === provider && row.provider_message_ref === providerRef)) {
        this.db.tables.messages.push({
          id: this.boundParams[0], conversation_id: this.boundParams[1], provider,
          provider_message_ref: providerRef, direction: this.boundParams[4], actor_role: this.boundParams[5],
          message_type: this.boundParams[6], text_content: this.boundParams[7], created_at: this.boundParams[8],
          _rowid: this.db.messageSeq
        });
        meta.changes = 1;
      }
    } else if (this.query.includes('INSERT INTO event_receipts')) {
      const existing = this.db.tables.event_receipts.find(row => row.source === this.boundParams[0] && row.source_event_ref === this.boundParams[1]);
      if (!existing) {
        this.db.tables.event_receipts.push({
          source: this.boundParams[0], source_event_ref: this.boundParams[1], status: 'PROCESSING',
          attempt_count: 1, lease_until: this.boundParams[2], claim_token: this.boundParams[3]
        });
        meta.changes = 1;
      }
    } else if (this.query.includes("SET status = 'PROCESSING', attempt_count = attempt_count + 1")) {
      const [leaseUntil, claimToken, source, eventRef, now] = this.boundParams;
      const row = this.db.tables.event_receipts.find(item => item.source === source && item.source_event_ref === eventRef);
      if (row && (row.status === 'FAILED' || (row.status === 'PROCESSING' && row.lease_until <= now))) {
        row.status = 'PROCESSING'; row.attempt_count += 1; row.lease_until = leaseUntil; row.claim_token = claimToken; meta.changes = 1;
      }
    } else if (this.query.includes("UPDATE event_receipts SET status = 'PROCESSED'")) {
      const [processedAt, source, eventRef, claimToken] = this.boundParams;
      const row = this.db.tables.event_receipts.find(item => item.source === source && item.source_event_ref === eventRef);
      if (row?.status === 'PROCESSING' && row.claim_token === claimToken) {
        row.status = 'PROCESSED'; row.processed_at = processedAt; row.lease_until = null; row.claim_token = null; meta.changes = 1;
      }
    } else if (this.query.includes("UPDATE event_receipts SET status = 'FAILED'")) {
      const [lastError, source, eventRef, claimToken] = this.boundParams;
      const row = this.db.tables.event_receipts.find(item => item.source === source && item.source_event_ref === eventRef);
      if (row?.status === 'PROCESSING' && row.claim_token === claimToken) {
        row.status = 'FAILED'; row.last_error = lastError; row.lease_until = null; row.claim_token = null; meta.changes = 1;
      }
    } else if (this.query.includes('INSERT INTO outbound_operations')) {
      if (!this.db.tables.outbound_operations.some(row => row.id === this.boundParams[0])) {
        this.db.tables.outbound_operations.push({
          id: this.boundParams[0], conversation_id: this.boundParams[1], destination_provider: this.boundParams[2],
          operation_type: this.boundParams[3], status: this.boundParams[4], attempt_count: 0,
          created_at: this.boundParams[5], updated_at: this.boundParams[6],
          subject_type: this.boundParams[7], subject_ref: this.boundParams[8],
          target_evidence_json: this.boundParams[9], reconciliation_status: 'NOT_REQUIRED',
          provider_message_ref: null, lease_until: null, lease_token: null, last_error: null,
          request_started_at: null, response_observed_at: null, response_http_status: null,
          retry_after_seconds: null, next_retry_at: null, resolved_by: null,
          resolved_at: null, resolution_reason: null, parent_operation_id: this.boundParams[10] ?? null,
          request_options_json: this.boundParams[11] ?? null
        });
        meta.changes = 1;
      }
    } else if (this.query.includes("status = 'SENDING'") && this.query.includes('attempt_count = attempt_count + 1')) {
      const [leaseUntil, leaseToken, updatedAt, id] = this.boundParams;
      const row = this.db.tables.outbound_operations.find(item => item.id === id);
      if (row && (row.status === 'PENDING' || row.status === 'FAILED_RETRYABLE')) {
        row.status = 'SENDING'; row.lease_until = leaseUntil; row.lease_token = leaseToken;
        row.attempt_count += 1; row.updated_at = updatedAt; meta.changes = 1;
      }
    } else if (this.query.includes("SET status = 'SENT'")) {
      const [providerRef, updatedAt, id, leaseToken] = this.boundParams;
      const row = this.db.tables.outbound_operations.find(item => item.id === id);
      if (row?.status === 'SENDING' && row.lease_token === leaseToken) {
        row.status = 'SENT'; row.provider_message_ref = providerRef; row.updated_at = updatedAt;
        row.lease_until = null; row.lease_token = null; meta.changes = 1;
      }
    } else if (this.query.includes('SET status = ?, last_error = ?')) {
      const [status, lastError, updatedAt, id, leaseToken] = this.boundParams;
      const row = this.db.tables.outbound_operations.find(item => item.id === id);
      if (row?.status === 'SENDING' && row.lease_token === leaseToken) {
        row.status = status; row.last_error = lastError; row.updated_at = updatedAt;
        row.lease_until = null; row.lease_token = null; meta.changes = 1;
      }
    } else if (this.query.includes("SET status = 'FAILED_FINAL'")) {
      const id = this.boundParams.length === 3 ? this.boundParams[2] : this.boundParams[1];
      const row = this.db.tables.outbound_operations.find(item => item.id === id);
      if (row) { row.status = 'FAILED_FINAL'; meta.changes = 1; }
    } else if (this.query.includes("SET status = 'AMBIGUOUS'")) {
      const row = this.db.tables.outbound_operations.find(item => item.id === this.boundParams[1]);
      if (row?.status === 'SENDING') { row.status = 'AMBIGUOUS'; meta.changes = 1; }
    } else if (this.query.includes("UPDATE ai_runs") && this.query.includes("SET status = 'SUCCESS'")) {
      const [providerRef, responseText, updatedAt, eventRef, generationId, epoch, convId, currentGenerationId, currentEpoch] = this.boundParams;
      const run = this.db.tables.ai_runs.find(row =>
        row.trigger_event_ref === eventRef && row.generation_id === generationId &&
        Number(row.handoff_epoch) === Number(epoch) && row.status === 'PENDING');
      const conv = this.db.tables.conversations.find(row =>
        row.id === convId && row.ai_mode === 'ENABLED' &&
        row.ai_generation_id === currentGenerationId && Number(row.ai_handoff_epoch) === Number(currentEpoch));
      if (run && conv) {
        run.status = 'SUCCESS'; run.provider_response_ref = providerRef;
        run.response_text = responseText; run.updated_at = updatedAt; meta.changes = 1;
      }
    } else if (this.query.includes('UPDATE ai_runs') && this.query.includes('attempt_count = attempt_count + 1')) {
      const [, eventRef, convId, generationId, epoch] = this.boundParams;
      const run = this.db.tables.ai_runs.find(row =>
        row.trigger_event_ref === eventRef && row.conversation_id === convId &&
        row.generation_id === generationId && Number(row.handoff_epoch) === Number(epoch) &&
        row.status === 'PENDING' && Number(row.attempt_count || 0) < 3);
      const conv = this.db.tables.conversations.find(row =>
        row.id === convId && row.ai_mode === 'ENABLED' && row.ai_generation_id === generationId &&
        Number(row.ai_handoff_epoch) === Number(epoch));
      if (run && conv) {
        run.attempt_count = Number(run.attempt_count || 0) + 1;
        meta.changes = 1;
      }
    } else if (this.query.includes('UPDATE ai_runs') && this.query.includes("THEN 'RETRY_EXHAUSTED'")) {
      const error = this.boundParams[4];
      const eventRef = this.boundParams[6];
      const generationId = this.boundParams[7];
      const epoch = this.boundParams[8];
      const convId = this.boundParams[9];
      const run = this.db.tables.ai_runs.find(row =>
        row.trigger_event_ref === eventRef && row.generation_id === generationId &&
        Number(row.handoff_epoch) === Number(epoch) && row.status === 'PENDING');
      const conv = this.db.tables.conversations.find(row =>
        row.id === convId && row.ai_mode === 'ENABLED' && row.ai_generation_id === generationId &&
        Number(row.ai_handoff_epoch) === Number(epoch));
      if (run && conv) {
        const exhausted = Number(run.attempt_count || 0) >= 3;
        run.status = exhausted ? 'RETRY_EXHAUSTED' : 'FAILED_RETRYABLE';
        run.next_retry_at = exhausted ? null : this.boundParams[2];
        run.last_error = exhausted ? 'AI_RETRY_EXHAUSTED' : error;
        meta.changes = 1;
      }
    } else if (this.query.includes('UPDATE ai_runs') && this.query.includes("SET status = 'FAILED_FINAL'")) {
      const [error, , eventRef, generationId, epoch, convId] = this.boundParams;
      const run = this.db.tables.ai_runs.find(row =>
        row.trigger_event_ref === eventRef && row.generation_id === generationId &&
        Number(row.handoff_epoch) === Number(epoch) && row.status === 'PENDING');
      const conv = this.db.tables.conversations.find(row =>
        row.id === convId && row.ai_mode === 'ENABLED' && row.ai_generation_id === generationId &&
        Number(row.ai_handoff_epoch) === Number(epoch));
      if (run && conv) { run.status = 'FAILED_FINAL'; run.last_error = error; run.next_retry_at = null; meta.changes = 1; }
    } else if (this.query.includes('UPDATE ai_runs') && this.query.includes("SET status = 'RETRY_EXHAUSTED'")) {
      const [, eventRef] = this.boundParams;
      const run = this.db.tables.ai_runs.find(row => row.trigger_event_ref === eventRef && Number(row.attempt_count || 0) >= 3);
      if (run && ['PENDING', 'FAILED_RETRYABLE'].includes(run.status)) {
        run.status = 'RETRY_EXHAUSTED'; run.last_error = 'AI_RETRY_EXHAUSTED'; run.next_retry_at = null; meta.changes = 1;
      }
    } else if (this.query.includes('UPDATE ai_runs') && this.query.includes("SET status = 'CANCELLED_BY_HANDOFF'")) {
      const eventRef = this.boundParams[1];
      const generationId = this.boundParams[2];
      const run = this.db.tables.ai_runs.find(row => row.trigger_event_ref === eventRef);
      if (run && run.generation_id === generationId && ['PENDING', 'SUCCESS'].includes(run.status)) {
        run.status = 'CANCELLED_BY_HANDOFF'; meta.changes = 1;
      }
    } else if (this.query.includes('UPDATE ai_runs') && this.query.includes("SET status = 'DISCARDED_STALE'")) {
      const eventRef = this.boundParams[1];
      const generationId = this.boundParams[2];
      const run = this.db.tables.ai_runs.find(row =>
        row.trigger_event_ref === eventRef && row.generation_id === generationId && row.status === 'PENDING');
      if (run) { run.status = 'DISCARDED_STALE'; meta.changes = 1; }
    } else if (this.query.includes('INSERT INTO ai_runs')) {
      const existing = this.db.tables.ai_runs.find(row => row.trigger_event_ref === this.boundParams[0]);
      const cancelled = this.query.includes("'CANCELLED_BY_HANDOFF'");
      const activeConversation = cancelled ? null : this.db.tables.conversations.find(row =>
        row.id === this.boundParams[7] && row.ai_mode === 'ENABLED' &&
        row.ai_generation_id === this.boundParams[8] &&
        Number(row.ai_handoff_epoch) === Number(this.boundParams[9]));
      if (!existing && (cancelled || activeConversation)) {
        this.db.tables.ai_runs.push({
          trigger_event_ref: this.boundParams[0], conversation_id: this.boundParams[1],
          trigger_message_ref: this.boundParams[2], generation_id: this.boundParams[3],
          handoff_epoch: this.boundParams[4], provider_response_ref: null,
          response_text: null, status: cancelled ? 'CANCELLED_BY_HANDOFF' : 'PENDING',
          attempt_count: 0, next_retry_at: null, last_error: null
        });
        meta.changes = 1;
      } else if (cancelled) {
        if (['PENDING', 'FAILED_RETRYABLE'].includes(existing.status)) {
          existing.status = 'CANCELLED_BY_HANDOFF'; meta.changes = 1;
        }
      } else if (activeConversation &&
        existing.conversation_id === this.boundParams[1] &&
        existing.trigger_message_ref === this.boundParams[2] &&
        Number(existing.attempt_count || 0) < 3 &&
        (existing.status === 'PENDING' ||
          (existing.status === 'FAILED_RETRYABLE' && Number(existing.next_retry_at) <= Number(this.boundParams[12])))
      ) {
        existing.generation_id = this.boundParams[3]; existing.handoff_epoch = this.boundParams[4];
        existing.status = 'PENDING'; existing.provider_response_ref = null; existing.response_text = null;
        existing.next_retry_at = null; existing.last_error = null; meta.changes = 1;
      }
    } else if (this.query.includes('INSERT INTO reliability_audit') && this.db.lastChanges === 1) {
      meta.changes = 1;
    }
    return { meta };
  }
}

class MockD1 {
  tables: Record<string, any[]> = { conversations: [], messages: [], event_receipts: [], outbound_operations: [], ai_runs: [], reliability_audit: [] };
  messageSeq = 0;
  lastChanges = 0;
  prepare(query: string) { return new MockPreparedStatement(this, query); }
  async batch(statements: MockPreparedStatement[]) {
    const results = [];
    for (const statement of statements) {
      const result = await statement.run();
      this.lastChanges = result.meta.changes;
      results.push(result);
    }
    return results;
  }
}

describe('Phase 2 AI Handoff', () => {
  let env: any;
  let fetchResolver: any = null;
  let counts: any = { ai: 0, chatwoot: 0, telegram: 0 };
  
  beforeEach(() => {
    vi.restoreAllMocks();
    counts = { ai: 0, chatwoot: 0, telegram: 0 };
    fetchResolver = null;
    env = {
      DB: new MockD1(), QUEUE: { async send() {} }, BOT_GROUP_ID: '-100',
      AI_BASE_URL: 'http://ai', AI_API_KEY: 'key', AI_MODEL: 'gpt-4o', CHATWOOT_API_URL: 'http://chatwoot',
      hooks: {}
    };
    global.fetch = vi.fn().mockImplementation((url) => {
      const s = String(url);
      if (s.includes('ai')) { counts.ai++; return new Promise(r => { 
          fetchResolver = (val: any) => {
            
            r(val);
          };
        }); }
      if (s.includes('chatwoot')) { counts.chatwoot++; return Promise.resolve({ ok: true, json: async () => ({ id: 100 }) }); }
      if (s.includes('telegram')) { counts.telegram++; return Promise.resolve({ ok: true, json: async () => ({ ok: true, result: { message_id: 100, message_thread_id: 100 } }) }); }
      return Promise.resolve({ ok: true, json: async () => ({ id: 100 }) });
    });
  });

  afterEach(() => vi.useRealTimers());

  function resolveAi(content: string) {
    if (fetchResolver) {
      const r = fetchResolver;
      fetchResolver = null;
      r({ ok: true, json: async () => ({ choices: [{ message: { content } }], id: 200, result: { message_id: 100 } }) });
    }
  }

  // 1. delayed retry translation is covered by tests/worker.test.ts

  // 2. duplicate ai_trigger generates and delivers exactly once
  it('duplicate ai_trigger generates and delivers exactly once', async () => {
    env.DB.tables.conversations.push({ id: 'c2', ai_mode: 'ENABLED', ai_handoff_epoch: 0, operator_thread_ref: '1', helpdesk_account_ref: '1', helpdesk_conversation_ref: '2' });
    
    const p1 = handleQueueEvent({ version: 1, source: 'internal', type: 'ai_trigger', eventId: 'ai_duplicate_test', payload: { convId: 'c2', messageId: 'm1' } }, env);
    await new Promise(r => setTimeout(r, 10)); // wait for lock
    
    await expect(handleQueueEvent({
      version: 1,
      source: 'internal',
      type: 'ai_trigger',
      eventId: 'ai_duplicate_test',
      payload: { convId: 'c2', messageId: 'm1' }
    }, env)).rejects.toBeInstanceOf(RetryableProcessingError);
    
    resolveAi('A');
    await p1;
    await handleQueueEvent({ version: 1, source: 'internal', type: 'ai_trigger', eventId: 'ai_duplicate_test', payload: { convId: 'c2', messageId: 'm1' } }, env);

    expect(counts.ai).toBe(1);
    expect(counts.chatwoot).toBe(1);
    expect(counts.telegram).toBe(1);
    expect(env.DB.tables.messages.filter((m:any) => m.actor_role === 'AI').length).toBe(1);
  });

  // 3. rapid message eventual success
  it('rapid message eventual success', async () => {
    env.DB.tables.conversations.push({ id: 'c3', ai_mode: 'ENABLED', ai_handoff_epoch: 0 });
    
    const pA = handleQueueEvent({ version: 1, source: 'internal', type: 'ai_trigger', eventId: 'ai_rapid_A', payload: { convId: 'c3', messageId: 'mA' } }, env);
    await new Promise(r => setTimeout(r, 10)); 
    
    let thrown = false;
    try { await handleQueueEvent({ version: 1, source: 'internal', type: 'ai_trigger', eventId: 'ai_rapid_B', payload: { convId: 'c3', messageId: 'mB' } }, env); }
    catch (e: any) { if (e instanceof RetryableProcessingError) thrown = true; }
    expect(thrown).toBe(true);

    resolveAi('RespA');
    await pA;

    // Retry B
    const pB = handleQueueEvent({ version: 1, source: 'internal', type: 'ai_trigger', eventId: 'ai_rapid_B', payload: { convId: 'c3', messageId: 'mB' } }, env);
    await new Promise(r => setTimeout(r, 10));
    resolveAi('RespB');
    await pB;

    const runA = env.DB.tables.ai_runs.find((r:any) => r.trigger_event_ref === 'ai_rapid_A');
    const runB = env.DB.tables.ai_runs.find((r:any) => r.trigger_event_ref === 'ai_rapid_B');
    expect(runA.response_text).toBe('RespA');
    expect(runB.response_text).toBe('RespB');
  });

  // 4. generated result retry reuses durable AI result
  it('generated result retry reuses durable AI result', async () => {
    env.DB.tables.conversations.push({ id: 'c4', ai_mode: 'ENABLED', ai_handoff_epoch: 0 });
    
    let cwFailed = false;
    global.fetch = vi.fn().mockImplementation(async (url) => {
      const s = String(url);
      if (s.includes('ai')) { counts.ai++; return { ok: true, json: async () => ({ choices: [{ message: { content: 'Reused AI' } }], id: 200 }) }; }
      if (s.includes('chatwoot') && !cwFailed) { cwFailed = true; return { ok: false, status: 429 }; }
      if (s.includes('chatwoot')) { counts.chatwoot++; return { ok: true, json: async () => ({ id: 200 }) }; }
      return { ok: true, json: async () => ({ id: 100, result: { message_id: 100 } }) };
    });

    try { await handleQueueEvent({ version: 1, source: 'internal', type: 'ai_trigger', eventId: 'ai_retry', payload: { convId: 'c4', messageId: 'm1' } }, env); } catch (e) { }

    expect(env.DB.tables.ai_runs[0].status).toBe('SUCCESS');
    expect(counts.ai).toBe(1);
    
    await handleQueueEvent({ version: 1, source: 'internal', type: 'ai_trigger', eventId: 'ai_retry', payload: { convId: 'c4', messageId: 'm1' } }, env);
    
    expect(counts.ai).toBe(1); // Provider not called again
    expect(counts.chatwoot).toBe(1); // Retry succeeds
    expect(env.DB.tables.ai_runs[0].response_text).toBe('Reused AI');
  });

  // 5. Telegram mirror retry does not resend Chatwoot
  it('Telegram mirror retry does not resend Chatwoot', async () => {
    env.DB.tables.conversations.push({ id: 'c5', ai_mode: 'ENABLED', ai_handoff_epoch: 0, operator_thread_ref: '1', helpdesk_account_ref: '1', helpdesk_conversation_ref: '1' });
    let tgFailed = false;
    global.fetch = vi.fn().mockImplementation(async (url) => {
      const s = String(url);
      if (s.includes('ai')) { counts.ai++; return { ok: true, json: async () => ({ choices: [{ message: { content: 'AI' } }], id: 200 }) }; }
      if (s.includes('chatwoot')) { counts.chatwoot++; return { ok: true, json: async () => ({ id: 200 }) }; }
      if (s.includes('telegram') && !tgFailed) { tgFailed = true; return { ok: false, status: 429 }; }
      if (s.includes('telegram')) { counts.telegram++; return { ok: true, json: async () => ({ ok: true, result: { message_id: 200, message_thread_id: 200 } }) }; }
      return { ok: true, json: async () => ({ id: 100 }) };
    });

    try { await handleQueueEvent({ version: 1, source: 'internal', type: 'ai_trigger', eventId: 'ai_tg_retry', payload: { convId: 'c5', messageId: 'm1' } }, env); } catch (e) { }
    
    expect(counts.ai).toBe(1);
    expect(counts.chatwoot).toBe(1);
    expect(counts.telegram).toBe(0); // Failed
    
    await handleQueueEvent({ version: 1, source: 'internal', type: 'ai_trigger', eventId: 'ai_tg_retry', payload: { convId: 'c5', messageId: 'm1' } }, env);
    
    expect(counts.ai).toBe(1);
    expect(counts.chatwoot).toBe(1); // Did not resend Chatwoot
    expect(counts.telegram).toBe(1); // Sent Telegram!
  });

  // 6. operator during AI request prevents all AI delivery
  it('operator during AI request prevents all AI delivery', async () => {
    env.DB.tables.conversations.push({ id: 'c6', ai_mode: 'ENABLED', ai_handoff_epoch: 0, operator_thread_ref: '1', helpdesk_account_ref: '1', helpdesk_conversation_ref: '1' });
    const p = handleQueueEvent({ version: 1, source: 'internal', type: 'ai_trigger', eventId: 'ai_op', payload: { convId: 'c6', messageId: 'm1' } }, env);
    await new Promise(r => setTimeout(r, 10));
    await pauseOperator(env, 'c6'); 
    resolveAi('Resp');
    try { await p; } catch(e){} 
    
    expect(env.DB.tables.ai_runs[0].status).toBe('CANCELLED_BY_HANDOFF');
    expect(counts.chatwoot).toBe(0);
    expect(counts.telegram).toBe(0);
  });

  // 7. operator after generation before visible send cancels all delivery
  it('operator after generation before visible send cancels all delivery', async () => {
    env.DB.tables.conversations.push({ id: 'c7', ai_mode: 'ENABLED', ai_handoff_epoch: 0, operator_thread_ref: '123' });
    env.hooks.beforeAiDispatchPreflight = async () => { await pauseOperator(env, 'c7'); };

    const p = handleQueueEvent({ version: 1, source: 'internal', type: 'ai_trigger', eventId: 'ai_op_2', payload: { convId: 'c7', messageId: 'm1' } }, env);
    await new Promise(r => setTimeout(r, 10));
    resolveAi('Resp');
    try { await p; } catch (e) {}
    
    expect(counts.chatwoot).toBe(0);
    expect(counts.telegram).toBe(0); // AI mirror send = 0
    expect(env.DB.tables.ai_runs[0].status).toBe('CANCELLED_BY_HANDOFF');

    const replyOp = env.DB.tables.outbound_operations.find((x: any) => x.id === 'ai_reply:ai_op_2');
    expect(replyOp.status).toBe('FAILED_FINAL');

    const tgOp = env.DB.tables.outbound_operations.find((x: any) => x.id === 'ai_tg_mirror:ai_op_2');
    expect(tgOp).toBeUndefined(); // operation must NOT be created/SENT
  });

  it('non-SENT Chatwoot does not mirror', async () => {
    env.DB.tables.conversations.push({ id: 'c7_non_sent', ai_mode: 'ENABLED', ai_handoff_epoch: 0, operator_thread_ref: '123' });
    
    // Force the network call for chatwoot to fail with an AMBIGUOUS timeout error
    let fetchCalled = false;
    global.fetch = vi.fn().mockImplementation((async (url: any, init: any) => {
      const s = String(url);
      if (s.includes('ai')) { 
        counts.ai++; 
        return { ok: true, json: async () => ({ choices: [{ message: { content: 'AI' } }], id: 200 }) };
      }
      if (s.includes('chatwoot')) { 
        counts.chatwoot++; 
        fetchCalled = true;
        throw new Error('Timeout or Ambiguous Network Error'); 
      }
      if (s.includes('telegram')) { counts.telegram++; return { ok: true, json: async () => ({ ok: true, result: { message_id: 100, message_thread_id: 100 } }) }; }
      return { ok: true, json: async () => ({ id: 100 }) };
    }) as any);

    try { await handleQueueEvent({ version: 1, source: 'internal', type: 'ai_trigger', eventId: 'ai_non_sent', payload: { convId: 'c7_non_sent', messageId: 'm1' } }, env); } catch (e) {}
    
    expect(fetchCalled).toBe(true);
    expect(counts.telegram).toBe(0); // Telegram mirror callback count = 0
    
    const replyOp = env.DB.tables.outbound_operations.find((x: any) => x.id === 'ai_reply:ai_non_sent');
    expect(replyOp.status).not.toBe('SENT');

    const tgOp = env.DB.tables.outbound_operations.find((x: any) => x.id === 'ai_tg_mirror:ai_non_sent');
    expect(tgOp).toBeUndefined();
  });

  // 8. operator pause then ai_on never revives old trigger
  it('operator pause then ai_on never revives old trigger', async () => {
    env.DB.tables.conversations.push({ id: 'c8', ai_mode: 'ENABLED', ai_handoff_epoch: 0 });
    env.hooks.beforeAiDispatchPreflight = async () => { await pauseOperator(env, 'c8'); };

    const p = handleQueueEvent({ version: 1, source: 'internal', type: 'ai_trigger', eventId: 'ai_revive', payload: { convId: 'c8', messageId: 'm1' } }, env);
    await new Promise(r => setTimeout(r, 10));
    resolveAi('Old');
    try { await p; } catch (e) {}

    expect(env.DB.tables.ai_runs[0].status).toBe('CANCELLED_BY_HANDOFF');
    env.hooks.beforeAiDispatchPreflight = undefined; // clear hook for future

    await resumeManual(env, 'c8'); 
    
    // old job retry
    await handleQueueEvent({ version: 1, source: 'internal', type: 'ai_trigger', eventId: 'ai_revive', payload: { convId: 'c8', messageId: 'm1' } }, env);
    
    expect(counts.ai).toBe(1); // NO NEW GENERATION
    expect(counts.chatwoot).toBe(0);
    expect(counts.telegram).toBe(0);
    expect(env.DB.tables.ai_runs[0].status).toBe('CANCELLED_BY_HANDOFF');
  });

  // 9. new customer message after ai_on generates normally
  it('new customer message after ai_on generates normally', async () => {
    env.DB.tables.conversations.push({ id: 'c9', ai_mode: 'ENABLED', ai_handoff_epoch: 0 });
    env.hooks.beforeAiDispatchPreflight = async () => { await pauseOperator(env, 'c9'); };

    const p = handleQueueEvent({ version: 1, source: 'internal', type: 'ai_trigger', eventId: 'ai_old', payload: { convId: 'c9', messageId: 'm1' } }, env);
    await new Promise(r => setTimeout(r, 10));
    resolveAi('Old');
    try { await p; } catch (e) {}
    
    env.hooks.beforeAiDispatchPreflight = undefined;
    await resumeManual(env, 'c9'); 

    // New trigger B
    const p2 = handleQueueEvent({ version: 1, source: 'internal', type: 'ai_trigger', eventId: 'ai_new', payload: { convId: 'c9', messageId: 'm2' } }, env);
    await new Promise(r => setTimeout(r, 10));
    resolveAi('New');
    await p2;

    const runB = env.DB.tables.ai_runs.find((r: any) => r.trigger_event_ref === 'ai_new');
    expect(runB.status).toBe('SUCCESS');
    expect(runB.response_text).toBe('New');
    expect(counts.chatwoot).toBe(1);
    expect(counts.ai).toBe(2);
  });

  // 10. PAUSED_MANUAL never auto resumes or calls AI
  it('PAUSED_MANUAL never auto resumes or calls AI', async () => {
    env.AI_OPERATOR_PAUSE_TIMEOUT_SECONDS = '3600';
    env.DB.tables.conversations.push({ id: 'c10', ai_mode: 'PAUSED_MANUAL', last_operator_reply_at: Math.floor(Date.now() / 1000) - 40000 });
    
    await handleQueueEvent({ version: 1, source: 'internal', type: 'ai_trigger', eventId: 'ai_man_1', payload: { convId: 'c10', messageId: 'm1' } }, env);
    
    expect(counts.ai).toBe(0);
    expect(counts.chatwoot).toBe(0);
    expect(env.DB.tables.conversations[0].ai_mode).toBe('PAUSED_MANUAL'); 
  });

  // 11. Chatwoot human operator pauses AI and still relays to Telegram
  it('Chatwoot human operator pauses AI and still relays to Telegram', async () => {
    env.DB.tables.conversations.push({ id: 'c11', ai_mode: 'ENABLED', ai_handoff_epoch: 0, operator_thread_ref: '1', helpdesk_account_ref: '1', helpdesk_conversation_ref: '2' });
    const event: SupportEvent = {
        version: 1, eventId: 'cw-evt-out', source: 'chatwoot', type: 'message_created',
        payload: { accountRef: '1', conversationRef: '2', customerRef: '5', messageRef: '6', content: 'Reply', actorRole: 'OPERATOR' }
    };
    await handleQueueEvent(event, env);
    
    const conv = env.DB.tables.conversations[0];
    expect(conv.ai_mode).toBe('PAUSED_OPERATOR');
    expect(conv.last_operator_reply_at).toBeTruthy();
    expect(conv.ai_generation_id).toBeNull();
    expect(conv.ai_handoff_epoch).toBe(1);
    expect(counts.telegram).toBe(1);
  });

  // 12. AI unconfigured keeps human bridge working
  it('AI unconfigured keeps human bridge working', async () => {
    env.AI_BASE_URL = ''; // Unconfigured
    env.DB.tables.conversations.push({ id: 'c12', ai_mode: 'ENABLED', ai_handoff_epoch: 0, helpdesk_account_ref: '1', helpdesk_conversation_ref: '2' });
    
    const event: SupportEvent = {
        version: 1, eventId: 'cw-evt-in', source: 'chatwoot', type: 'message_created',
        payload: { accountRef: '1', conversationRef: '2', customerRef: '5', messageRef: '6', content: 'Q', actorRole: 'CUSTOMER' }
    };
    await handleQueueEvent(event, env); 
    
    await handleQueueEvent({ version: 1, source: 'internal', type: 'ai_trigger', eventId: 'ai_unconf', payload: { convId: 'c12', messageId: 'm1' } } as any, env);
    
    expect(counts.telegram).toBe(2); // Human bridge works (topic + message)
    expect(counts.ai).toBe(0);
    expect(env.DB.tables.ai_runs.length).toBe(0);
  });

  // 13. context same-second ordering follows rowid insertion order
  it('context same-second ordering follows rowid insertion order', async () => {
    const aiConfig = await import('../src/config/ai');
    vi.spyOn(aiConfig, 'getAIConfig').mockReturnValue({
      enabled: true, baseUrl: 'x', apiKey: 'y', model: 'z', systemPrompt: 'Sys',
      requestTimeoutMs: 10000, contextMaxMessages: 10, contextMaxChars: 100,
      generationLeaseSeconds: 60, operatorPauseTimeoutSeconds: 3600
    });

    env.DB.tables.conversations.push({ id: 'c13', ai_mode: 'ENABLED', ai_handoff_epoch: 0 });
    
    // SAME created_at. A inserted first (_rowid=1), B inserted second (_rowid=2)
    env.DB.tables.messages.push({ conversation_id: 'c13', actor_role: 'CUSTOMER', text_content: 'A', created_at: 100, message_type: 'TEXT', id: 1, _rowid: 1 });
    env.DB.tables.messages.push({ conversation_id: 'c13', actor_role: 'CUSTOMER', text_content: 'B', created_at: 100, message_type: 'TEXT', id: 2, _rowid: 2 }); 
    
    const { buildAIContext } = await import('../src/core/ai-context');
    const msgs = await buildAIContext(env, 'c13', aiConfig.getAIConfig(env));
    
    expect(msgs[1].content).toBe('A');
    expect(msgs[2].content).toBe('B');
  });

  // 14. context hard character cap
  it('context hard character cap', async () => {
    const aiConfig = await import('../src/config/ai');
    vi.spyOn(aiConfig, 'getAIConfig').mockReturnValue({
      enabled: true, baseUrl: 'x', apiKey: 'y', model: 'z', systemPrompt: 'Sys',
      requestTimeoutMs: 10000, contextMaxMessages: 10, contextMaxChars: 10,
      generationLeaseSeconds: 60, operatorPauseTimeoutSeconds: 3600
    });

    env.DB.tables.conversations.push({ id: 'c14', ai_mode: 'ENABLED', ai_handoff_epoch: 0 });
    env.DB.tables.messages.push({ conversation_id: 'c14', actor_role: 'CUSTOMER', text_content: '12345', created_at: 100, message_type: 'TEXT', id: 1, _rowid: 1 });
    env.DB.tables.messages.push({ conversation_id: 'c14', actor_role: 'OPERATOR', text_content: '6789012', created_at: 101, message_type: 'TEXT', id: 2, _rowid: 2 }); 
    
    const { buildAIContext } = await import('../src/core/ai-context');
    const msgs = await buildAIContext(env, 'c14', aiConfig.getAIConfig(env));
    
    const totalChars = msgs.slice(1).reduce((acc, m) => acc + (typeof m.content === 'string' ? m.content.length : 0), 0);
    expect(totalChars).toBeLessThanOrEqual(10);
    expect(msgs).toHaveLength(2);
    expect(msgs[1]).toEqual({ role: 'system', content: 'Human oper' });
  });

  // 15. current customer message appears exactly once in AI input
  it('current customer message appears exactly once in AI input', async () => {
    env.DB.tables.conversations.push({
      id: 'c15', ai_mode: 'ENABLED', ai_handoff_epoch: 0,
      helpdesk_account_ref: '1', helpdesk_conversation_ref: '2'
    });
    env.DB.tables.messages.push({ conversation_id: 'c15', actor_role: 'CUSTOMER', text_content: 'hello-current-message', created_at: 100, message_type: 'TEXT', id: 1, _rowid: 1 });

    let aiPromptMessages: any[] = [];
    vi.mocked(global.fetch).mockImplementation(async (url: any, init: any) => {
      const s = String(url);
      if (s.includes('ai')) {
        counts.ai++;
        const body = JSON.parse(init.body);
        aiPromptMessages = body.messages;
        return { ok: true, json: async () => ({ choices: [{ message: { content: 'Answer' } }], id: 'ai-15' }) } as Response;
      }
      return { ok: true, json: async () => ({ id: 100 }) } as Response;
    });

    await handleQueueEvent({
      version: 1,
      source: 'internal',
      type: 'ai_trigger',
      eventId: 'ai_current_once',
      payload: { convId: 'c15', messageId: '1' }
    }, env);

    const occurrences = aiPromptMessages.filter(message =>
      message.role === 'user' && message.content === 'hello-current-message');
    expect(occurrences.length).toBe(1);
  });

  // 16. generation lease CAS rejects stale handoff epoch
  it('generation lease CAS rejects stale handoff epoch', async () => {
    env.DB.tables.conversations.push({ id: 'c16', ai_mode: 'ENABLED', ai_handoff_epoch: 0 });

    env.hooks.beforeGenerationLeaseClaim = async () => {
      await pauseOperator(env, 'c16');
      await resumeManual(env, 'c16');
    };
    const { acquireGenerationLease } = await import('../src/core/ai-state');
    const result = await acquireGenerationLease(env, 'c16', 'm1');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.reason).toBe('HANDOFF');
    expect(counts.ai).toBe(0);
  });

  // 17. CANCELLED_BY_HANDOFF outbound operation is terminal
  it('CANCELLED_BY_HANDOFF outbound operation is terminal', async () => {
    env.DB.tables.conversations.push({ id: 'c17', ai_mode: 'ENABLED', ai_handoff_epoch: 0 });
    
    let callCount = 0;
    try {
      await executeOutboundOperation(env, 'c17', 'chatwoot', 'SEND_MESSAGE', async () => {
        callCount++;
        throw new CancelledBeforeDeliveryError();
      }, 'op17', {
        subject: { type: 'AI_RUN', ref: 'ai-run:op17' },
        targetEvidence: {
          version: 1, provider: 'chatwoot', accountRef: 'account', conversationRef: 'conversation',
          sourceId: 'cz2128:op17', apiUrlSource: 'ENV', apiBaseFingerprint: 'a'.repeat(64)
        }
      });
    } catch (e) {}

    expect(env.DB.tables.outbound_operations.find((x: any) => x.id === 'op17').status).toBe('FAILED_FINAL');
    expect(callCount).toBe(1);

    // retry
    try {
      await executeOutboundOperation(env, 'c17', 'chatwoot', 'SEND_MESSAGE', async () => {
        callCount++;
        return { providerMessageRef: '123' };
      }, 'op17', {
        subject: { type: 'AI_RUN', ref: 'ai-run:op17' },
        targetEvidence: {
          version: 1, provider: 'chatwoot', accountRef: 'account', conversationRef: 'conversation',
          sourceId: 'cz2128:op17', apiUrlSource: 'ENV', apiBaseFingerprint: 'a'.repeat(64)
        }
      });
    } catch (e) {}

    expect(callCount).toBe(1); // Not called again!
  });

  it('records stale handoff epoch claim as terminal cancellation', async () => {
    env.DB.tables.conversations.push({ id: 'c18', ai_mode: 'ENABLED', ai_handoff_epoch: 0 });
    env.hooks.beforeGenerationLeaseClaim = async () => {
      await pauseOperator(env, 'c18');
      await resumeManual(env, 'c18');
    };

    await handleQueueEvent({
      version: 1,
      source: 'internal',
      type: 'ai_trigger',
      eventId: 'ai_stale_epoch',
      payload: { convId: 'c18', messageId: 'm18' }
    }, env);

    const run = env.DB.tables.ai_runs.find((row: any) => row.trigger_event_ref === 'ai_stale_epoch');
    expect(counts.ai).toBe(0);
    expect(run?.status).toBe('CANCELLED_BY_HANDOFF');
  });

  it('operator reply preserves manual pause while updating cancellation state', async () => {
    env.DB.tables.conversations.push({
      id: 'c19', ai_mode: 'PAUSED_MANUAL', ai_handoff_epoch: 2,
      last_operator_reply_at: null, ai_generation_id: 'old-generation'
    });

    await pauseOperator(env, 'c19');

    const conv = env.DB.tables.conversations[0];
    expect(conv.ai_mode).toBe('PAUSED_MANUAL');
    expect(conv.last_operator_reply_at).toBeTruthy();
    expect(conv.ai_generation_id).toBeNull();
    expect(conv.ai_handoff_epoch).toBe(3);
  });

  it('Telegram human operator pauses AI and still relays to Chatwoot', async () => {
    env.DB.tables.conversations.push({
      id: 'c20', ai_mode: 'ENABLED', ai_handoff_epoch: 0,
      operator_channel: 'telegram', operator_thread_ref: '20',
      helpdesk_account_ref: '1', helpdesk_conversation_ref: '2'
    });

    await handleQueueEvent({
      version: 1,
      source: 'telegram',
      type: 'message_created',
      eventId: 'tg:0:20',
      payload: { supportProfileVersion: 0, updateRef: '20', messageRef: '20', threadRef: '20', content: 'Human reply' }
    }, env);

    const conv = env.DB.tables.conversations[0];
    expect(conv.ai_mode).toBe('PAUSED_OPERATOR');
    expect(conv.ai_handoff_epoch).toBe(1);
    expect(conv.last_operator_reply_at).toBeTruthy();
    expect(counts.chatwoot).toBe(1);
    expect(env.DB.tables.messages.some((row: any) => row.actor_role === 'OPERATOR')).toBe(true);
  });

  it('AI control acknowledgements use outbound operations', async () => {
    env.DB.tables.conversations.push({
      id: 'c21', ai_mode: 'ENABLED', ai_handoff_epoch: 0,
      operator_channel: 'telegram', operator_thread_ref: '21'
    });

    await handleQueueEvent({
      version: 1,
      source: 'telegram',
      type: 'message_created',
      eventId: 'tg:0:21-off',
      payload: { supportProfileVersion: 0, updateRef: '21', messageRef: '21', threadRef: '21', content: '/ai_off' }
    }, env);
    await handleQueueEvent({
      version: 1,
      source: 'telegram',
      type: 'message_created',
      eventId: 'tg:0:22-on',
      payload: { supportProfileVersion: 0, updateRef: '22', messageRef: '22', threadRef: '21', content: '/ai_on' }
    }, env);

    expect(env.DB.tables.conversations[0].ai_mode).toBe('ENABLED');
    expect(env.DB.tables.outbound_operations.find((row: any) => row.id === 'ai_off_ack:0:21')?.status).toBe('SENT');
    expect(env.DB.tables.outbound_operations.find((row: any) => row.id === 'ai_on_ack:0:22')?.status).toBe('SENT');
    expect(counts.telegram).toBe(2);
  });

  it('AI event receipt lease exceeds the valid generation runtime', async () => {
    env.DB.tables.conversations.push({ id: 'c22', ai_mode: 'ENABLED', ai_handoff_epoch: 0 });
    const before = Math.floor(Date.now() / 1000);
    const processing = handleQueueEvent({
      version: 1,
      source: 'internal',
      type: 'ai_trigger',
      eventId: 'ai_long_lease',
      payload: { convId: 'c22', messageId: 'm22' }
    }, env);
    await new Promise(resolve => setTimeout(resolve, 10));

    const receipt = env.DB.tables.event_receipts.find((row: any) => row.source_event_ref === 'ai_long_lease');
    expect(receipt.lease_until - before).toBeGreaterThanOrEqual(75);

    resolveAi('Done');
    await processing;
  });

  it('represents human operator context separately from AI answers', async () => {
    env.DB.tables.messages.push({
      conversation_id: 'c23', actor_role: 'OPERATOR', text_content: 'Use the verified answer',
      created_at: 100, message_type: 'TEXT', id: 1, _rowid: 1
    });
    const { buildAIContext } = await import('../src/core/ai-context');
    const messages = await buildAIContext(env, 'c23', {
      enabled: true, baseUrl: 'https://ai.example/v1', apiKey: 'key', model: 'model', systemPrompt: 'Sys',
      requestTimeoutMs: 30000, contextMaxMessages: 10, contextMaxChars: 100,
      generationLeaseSeconds: 60, operatorPauseTimeoutSeconds: 3600
    });

    expect(messages[1]).toEqual({ role: 'system', content: 'Human operator: Use the verified answer' });
  });

  it('auto-resumes PAUSED_OPERATOR only for a new customer trigger after timeout', async () => {
    env.AI_OPERATOR_PAUSE_TIMEOUT_SECONDS = '60';
    env.DB.tables.conversations.push({
      id: 'c24', ai_mode: 'PAUSED_OPERATOR', ai_handoff_epoch: 3,
      last_operator_reply_at: Math.floor(Date.now() / 1000) - 61,
      helpdesk_account_ref: '1', helpdesk_conversation_ref: '2'
    });

    const processing = handleQueueEvent({
      version: 1,
      source: 'internal',
      type: 'ai_trigger',
      eventId: 'ai_auto_resume_new_customer',
      payload: { convId: 'c24', messageId: 'm24' }
    }, env);
    await new Promise(resolve => setTimeout(resolve, 10));
    resolveAi('Resumed answer');
    await processing;

    expect(env.DB.tables.conversations[0].ai_mode).toBe('ENABLED');
    expect(counts.ai).toBe(1);
  });

  it('assigns a new generation id to a retry after AI provider failure', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-14T00:00:00Z'));
    env.DB.tables.conversations.push({
      id: 'c25', ai_mode: 'ENABLED', ai_handoff_epoch: 0,
      helpdesk_account_ref: '1', helpdesk_conversation_ref: '2'
    });
    const event = {
      version: 1 as const,
      source: 'internal' as const,
      type: 'ai_trigger' as const,
      eventId: 'ai_attempt_identity',
      payload: { convId: 'c25', messageId: 'm25' }
    };

    vi.mocked(global.fetch).mockResolvedValueOnce({ ok: false, status: 503 } as Response);
    await expect(handleQueueEvent(event, env)).rejects.toThrow('AI_PROVIDER_5XX');
    const firstGenerationId = env.DB.tables.ai_runs[0].generation_id;

    vi.mocked(global.fetch).mockImplementation(async (url: any) => {
      if (String(url).includes('ai')) {
        return { ok: true, json: async () => ({ choices: [{ message: { content: 'Recovered' } }], id: 'ai-25' }) } as Response;
      }
      return { ok: true, json: async () => ({ id: 250 }) } as Response;
    });
    await expect(handleQueueEvent(event, env)).rejects.toThrow('AI_PROVIDER_5XX');
    expect(counts.ai).toBe(0);
    vi.advanceTimersByTime(6_000);
    await handleQueueEvent(event, env);

    expect(env.DB.tables.ai_runs[0].generation_id).not.toBe(firstGenerationId);
    expect(env.DB.tables.ai_runs[0].status).toBe('SUCCESS');
  });

  it('preserves historical SUCCESS while an old-epoch trigger completes as a no-op', async () => {
    env.DB.tables.conversations.push({ id: 'c26', ai_mode: 'PAUSED_OPERATOR', ai_handoff_epoch: 4 });
    env.DB.tables.ai_runs.push({
      trigger_event_ref: 'ai_paused_existing', conversation_id: 'c26', trigger_message_ref: 'm26',
      generation_id: 'generation-26', handoff_epoch: 3, response_text: 'Old answer', status: 'SUCCESS'
    });
    const event = {
      version: 1 as const,
      source: 'internal' as const,
      type: 'ai_trigger' as const,
      eventId: 'ai_paused_existing',
      payload: { convId: 'c26', messageId: 'm26' }
    };

    await handleQueueEvent(event, env);
    await resumeManual(env, 'c26');
    await handleQueueEvent(event, env);

    expect(env.DB.tables.ai_runs[0].status).toBe('SUCCESS');
    expect(env.DB.tables.ai_runs[0].handoff_epoch).toBe(3);
    expect(env.DB.tables.event_receipts[0].status).toBe('PROCESSED');
    expect(counts.ai).toBe(0);
    expect(counts.chatwoot).toBe(0);
    expect(counts.telegram).toBe(0);
  });

  it('AI provider failure releases its lease and leaves the human bridge operational', async () => {
    env.DB.tables.conversations.push({
      id: 'c27', ai_mode: 'ENABLED', ai_handoff_epoch: 0,
      operator_channel: 'telegram', operator_thread_ref: '27',
      helpdesk_account_ref: '1', helpdesk_conversation_ref: '2'
    });
    vi.mocked(global.fetch).mockResolvedValueOnce({ ok: false, status: 503 } as Response);

    await expect(handleQueueEvent({
      version: 1,
      source: 'internal',
      type: 'ai_trigger',
      eventId: 'ai_provider_failure',
      payload: { convId: 'c27', messageId: 'm27' }
    }, env)).rejects.toThrow('AI_PROVIDER_5XX');
    expect(env.DB.tables.conversations[0].ai_generation_id).toBeNull();

    vi.mocked(global.fetch).mockImplementation(async (url: any) => {
      if (String(url).includes('chatwoot')) counts.chatwoot++;
      return { ok: true, json: async () => ({ id: 270 }) } as Response;
    });
    await handleQueueEvent({
      version: 1,
      source: 'telegram',
      type: 'message_created',
      eventId: 'tg:0:27',
      payload: { supportProfileVersion: 0, updateRef: '27', messageRef: '27', threadRef: '27', content: 'Human recovery' }
    }, env);

    expect(counts.chatwoot).toBe(1);
    expect(env.DB.tables.conversations[0].ai_mode).toBe('PAUSED_OPERATOR');
  });

  it('rejects a stable AI job identity collision across messages', async () => {
    env.DB.tables.conversations.push({ id: 'c28', ai_mode: 'ENABLED', ai_handoff_epoch: 0 });
    env.DB.tables.ai_runs.push({
      trigger_event_ref: 'ai_collision', conversation_id: 'other-conversation',
      trigger_message_ref: 'other-message', generation_id: 'generation-other',
      handoff_epoch: 0, status: 'SUCCESS', response_text: 'Other answer'
    });

    await expect(handleQueueEvent({
      version: 1,
      source: 'internal',
      type: 'ai_trigger',
      eventId: 'ai_collision',
      payload: { convId: 'c28', messageId: 'm28' }
    }, env)).rejects.toThrow('AI run identity collision');
    expect(counts.ai).toBe(0);
    expect(counts.chatwoot).toBe(0);
  });

  it('operator between generation verification and durable success persist wins', async () => {
    env.DB.tables.conversations.push({
      id: 'c29', ai_mode: 'ENABLED', ai_handoff_epoch: 0,
      operator_thread_ref: '29', helpdesk_account_ref: '1', helpdesk_conversation_ref: '2'
    });
    env.hooks.beforeAiRunSuccessPersist = async () => pauseOperator(env, 'c29');

    const processing = handleQueueEvent({
      version: 1,
      source: 'internal',
      type: 'ai_trigger',
      eventId: 'ai_success_persist_race',
      payload: { convId: 'c29', messageId: 'm29' }
    }, env);
    await new Promise(resolve => setTimeout(resolve, 10));
    resolveAi('Stale answer');
    await processing;

    expect(env.DB.tables.ai_runs[0].status).toBe('CANCELLED_BY_HANDOFF');
    expect(counts.chatwoot).toBe(0);
    expect(counts.telegram).toBe(0);
  });

  it('an older command retry cannot override a newer Telegram AI command', async () => {
    env.DB.tables.conversations.push({
      id: 'c30', ai_mode: 'ENABLED', ai_handoff_epoch: 0,
      operator_channel: 'telegram', operator_thread_ref: '30'
    });
    let firstAck = true;
    vi.mocked(global.fetch).mockImplementation(async (url: any) => {
      if (String(url).includes('telegram') && firstAck) {
        firstAck = false;
        return { ok: false, status: 429 } as Response;
      }
      if (String(url).includes('telegram')) {
        return { ok: true, json: async () => ({ ok: true, result: { message_id: 300 } }) } as Response;
      }
      throw new Error('Unexpected provider call');
    });
    const off = {
      version: 1 as const, source: 'telegram' as const, type: 'message_created' as const,
      eventId: 'tg:0:30', payload: { supportProfileVersion: 0, updateRef: '30', messageRef: '30', threadRef: '30', content: '/ai_off' }
    };
    const on = {
      version: 1 as const, source: 'telegram' as const, type: 'message_created' as const,
      eventId: 'tg:0:31', payload: { supportProfileVersion: 0, updateRef: '31', messageRef: '31', threadRef: '30', content: '/ai_on' }
    };

    await expect(handleQueueEvent(off, env)).rejects.toBeInstanceOf(RetryableProcessingError);
    await handleQueueEvent(on, env);
    await handleQueueEvent(off, env);

    expect(env.DB.tables.conversations[0].ai_mode).toBe('ENABLED');
    expect(env.DB.tables.conversations[0].last_telegram_operator_update_id).toBe(31);
  });

  it('older ai_on cannot override a newer Telegram human reply', async () => {
    env.DB.tables.conversations.push({
      id: 'c31', ai_mode: 'ENABLED', ai_handoff_epoch: 0,
      operator_channel: 'telegram', operator_thread_ref: '31',
      helpdesk_account_ref: '1', helpdesk_conversation_ref: '2'
    });
    const aiOn = {
      version: 1 as const, source: 'telegram' as const, type: 'message_created' as const,
      eventId: 'tg:0:100', payload: { supportProfileVersion: 0, updateRef: '100', messageRef: '100', threadRef: '31', content: '/ai_on' }
    };
    const human = {
      version: 1 as const, source: 'telegram' as const, type: 'message_created' as const,
      eventId: 'tg:0:101', payload: { supportProfileVersion: 0, updateRef: '101', messageRef: '101', threadRef: '31', content: 'Human reply' }
    };

    await handleQueueEvent(human, env);
    await handleQueueEvent(aiOn, env);

    const conv = env.DB.tables.conversations[0];
    expect(conv.ai_mode).toBe('PAUSED_OPERATOR');
    expect(conv.last_telegram_operator_update_id).toBe(101);
    expect(counts.chatwoot).toBe(1);
    expect(counts.telegram).toBe(0);
  });

  it('older human reply bridges without overriding a newer ai_on state', async () => {
    env.DB.tables.conversations.push({
      id: 'c32', ai_mode: 'PAUSED_OPERATOR', ai_handoff_epoch: 4,
      operator_channel: 'telegram', operator_thread_ref: '32',
      helpdesk_account_ref: '1', helpdesk_conversation_ref: '2'
    });
    const human = {
      version: 1 as const, source: 'telegram' as const, type: 'message_created' as const,
      eventId: 'tg:0:100-human', payload: { supportProfileVersion: 0, updateRef: '100', messageRef: '100', threadRef: '32', content: 'Earlier human reply' }
    };
    const aiOn = {
      version: 1 as const, source: 'telegram' as const, type: 'message_created' as const,
      eventId: 'tg:0:101-on', payload: { supportProfileVersion: 0, updateRef: '101', messageRef: '101', threadRef: '32', content: '/ai_on' }
    };

    await handleQueueEvent(aiOn, env);
    env.DB.tables.conversations[0].ai_generation_id = 'newer-generation';
    await handleQueueEvent(human, env);

    const conv = env.DB.tables.conversations[0];
    expect(conv.ai_mode).toBe('ENABLED');
    expect(conv.ai_handoff_epoch).toBe(4);
    expect(conv.ai_generation_id).toBe('newer-generation');
    expect(conv.last_telegram_operator_update_id).toBe(101);
    expect(counts.chatwoot).toBe(1);
  });

  it('newer human reply preserves PAUSED_MANUAL and advances cancellation state', async () => {
    env.DB.tables.conversations.push({
      id: 'c33', ai_mode: 'ENABLED', ai_handoff_epoch: 0,
      operator_channel: 'telegram', operator_thread_ref: '33',
      helpdesk_account_ref: '1', helpdesk_conversation_ref: '2'
    });
    await handleQueueEvent({
      version: 1, source: 'telegram', type: 'message_created', eventId: 'tg:0:100-off',
      payload: { supportProfileVersion: 0, updateRef: '100', messageRef: '100', threadRef: '33', content: '/ai_off' }
    }, env);
    env.DB.tables.conversations[0].ai_generation_id = 'generation-after-command';
    await handleQueueEvent({
      version: 1, source: 'telegram', type: 'message_created', eventId: 'tg:0:101-human',
      payload: { supportProfileVersion: 0, updateRef: '101', messageRef: '101', threadRef: '33', content: 'Manual takeover reply' }
    }, env);

    const conv = env.DB.tables.conversations[0];
    expect(conv.ai_mode).toBe('PAUSED_MANUAL');
    expect(conv.ai_handoff_epoch).toBe(2);
    expect(conv.ai_generation_id).toBeNull();
    expect(conv.last_operator_reply_at).toBeTruthy();
    expect(conv.last_telegram_operator_update_id).toBe(101);
    expect(counts.chatwoot).toBe(1);
  });

  it('same Telegram operator updates do not repeat state or visible effects', async () => {
    env.DB.tables.conversations.push({
      id: 'c34', ai_mode: 'ENABLED', ai_handoff_epoch: 0,
      operator_channel: 'telegram', operator_thread_ref: '34',
      helpdesk_account_ref: '1', helpdesk_conversation_ref: '2'
    });
    const human = {
      version: 1 as const, source: 'telegram' as const, type: 'message_created' as const,
      eventId: 'tg:0:200', payload: { supportProfileVersion: 0, updateRef: '200', messageRef: '200', threadRef: '34', content: 'Human once' }
    };
    const aiOff = {
      version: 1 as const, source: 'telegram' as const, type: 'message_created' as const,
      eventId: 'tg:0:201', payload: { supportProfileVersion: 0, updateRef: '201', messageRef: '201', threadRef: '34', content: '/ai_off' }
    };

    await handleQueueEvent(human, env);
    await handleQueueEvent(human, env);
    expect(env.DB.tables.conversations[0].ai_handoff_epoch).toBe(1);
    expect(counts.chatwoot).toBe(1);

    await handleQueueEvent(aiOff, env);
    await handleQueueEvent(aiOff, env);
    expect(env.DB.tables.conversations[0].ai_handoff_epoch).toBe(2);
    expect(counts.telegram).toBe(1);
  });
});
