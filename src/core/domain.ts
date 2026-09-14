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

export interface EventReceipt {
  source: string;
  source_event_ref: string;
  status: 'PROCESSING' | 'PROCESSED' | 'FAILED';
  attempt_count: number;
  lease_until: number | null;
  claim_token: string | null;
  last_error: string | null;
  processed_at: number | null;
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
  last_error: string | null;
  created_at: number;
  updated_at: number;
}
