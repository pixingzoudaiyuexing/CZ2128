export interface Conversation {
  id: string;
  helpdesk_provider: string;
  helpdesk_account_ref: string;
  helpdesk_conversation_ref: string;
  customer_ref: string;
  operator_channel: string;
  operator_thread_ref: string | null;
  operator_thread_status: 'OPEN' | 'CLOSED';
  last_operator_reply_at: number | null;
  ai_mode: 'ENABLED' | 'PAUSED_OPERATOR' | 'PAUSED_MANUAL';
  ai_pause_source: 'CRISP_OPERATOR' | 'TELEGRAM_OPERATOR' | 'MANUAL' | 'HELPDESK_OPERATOR' | null;
  ai_generation_id: string | null;
  ai_generation_started_at: number | null;
  ai_generation_message_id: string | null;
  ai_handoff_epoch: number;
  last_telegram_operator_update_id: number | null;
  last_telegram_operator_profile_version: number;
  created_at: number;
  updated_at: number;
  version: number;
}

export interface Message {
  id: string;
  conversation_id: string;
  provider: string;
  provider_message_ref: string | null;
  direction: 'INBOUND' | 'OUTBOUND';
  actor_role: 'CUSTOMER' | 'OPERATOR' | 'AI' | 'SYSTEM';
  message_type: 'TEXT' | 'ATTACHMENT';
  text_content: string | null;
  created_at: number;
}

export type AiRunStatus =
  | 'PENDING'
  | 'SUCCESS'
  | 'FAILED'
  | 'FAILED_RETRYABLE'
  | 'RETRY_EXHAUSTED'
  | 'FAILED_FINAL'
  | 'CANCELLED_BY_HANDOFF'
  | 'DISCARDED_STALE';

export interface AiRun {
  trigger_event_ref: string;
  conversation_id: string;
  trigger_message_ref: string;
  generation_id: string | null;
  handoff_epoch: number;
  provider_response_ref: string | null;
  response_text: string | null;
  status: AiRunStatus;
  attempt_count: number;
  next_retry_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export interface EventReceipt {
  source: string;
  source_event_ref: string;
  status: 'PROCESSING' | 'PROCESSED' | 'FAILED';
  attempt_count: number;
  lease_until: number | null;
  claim_token: string | null;
  last_error: SafeErrorCode | null;
  processed_at: number | null;
  event_type: string | null;
  conversation_id: string | null;
  last_attempt_at: number | null;
  dead_lettered_at: number | null;
}

export interface OutboundOperation {
  id: string;
  conversation_id: string;
  destination_provider: string;
  operation_type: 'SEND_MESSAGE' | 'SEND_ATTACHMENT' | 'CREATE_TOPIC' | 'CLOSE_TOPIC' | 'REOPEN_TOPIC';
  status: 'PENDING' | 'SENDING' | 'SENT' | 'FAILED_RETRYABLE' | 'FAILED_FINAL' | 'AMBIGUOUS';
  provider_message_ref: string | null;
  attempt_count: number;
  lease_until: number | null;
  lease_token: string | null;
  last_error: SafeErrorCode | null;
  created_at: number;
  updated_at: number;
  request_started_at: number | null;
  response_observed_at: number | null;
  response_http_status: number | null;
  next_retry_at: number | null;
  retry_after_seconds: number | null;
  reconciliation_status: 'NOT_REQUIRED' | 'PENDING' | 'CONFIRMED_SENT' | 'CONFIRMED_NOT_SENT' | 'STILL_AMBIGUOUS' | 'MANUAL_MARK_DELIVERED' | 'MANUAL_CANCELLED' | 'MANUAL_RETRY_CREATED';
  resolved_by: string | null;
  resolved_at: number | null;
  resolution_reason: string | null;
  parent_operation_id: string | null;
  subject_type: 'MESSAGE' | 'ATTACHMENT' | 'CONVERSATION' | 'AI_RUN' | 'CONTROL_ACK' | 'UPLOAD_INVITE' | null;
  subject_ref: string | null;
  target_evidence_json: string | null;
  request_options_json: string | null;
}
import { SafeErrorCode } from './error-taxonomy';
