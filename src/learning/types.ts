export type LearningReviewStatus = 'CAPTURED' | 'NEEDS_REVIEW' | 'APPROVED' | 'REJECTED' | 'PUBLISHED';
export type LearningRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';
export type LearningExtractionStatus = 'PENDING' | 'SUCCEEDED' | 'REJECTED' | 'FAILED';
export type LearningNotionSyncStatus = 'DISABLED' | 'PENDING' | 'SYNCED' | 'ERROR' | 'DUPLICATE';

export interface LearningCandidateRow {
  id: string;
  version: number;
  source_conversation_id: string;
  source_human_message_id: string;
  source_question_message_id: string | null;
  source_provider: string;
  review_status: LearningReviewStatus;
  sanitized_question: string | null;
  sanitized_answer: string;
  extracted_title: string | null;
  extracted_question: string | null;
  extracted_answer: string | null;
  extraction_reason: string | null;
  review_notes: string | null;
  risk_level: LearningRiskLevel;
  risk_flags_json: string;
  extraction_status: LearningExtractionStatus;
  extraction_attempt_count: number;
  extraction_error_code: string | null;
  notion_page_id: string | null;
  notion_sync_status: LearningNotionSyncStatus;
  notion_sync_lease_token: string | null;
  notion_sync_lease_until: number | null;
  last_synced_candidate_version: number | null;
  notion_last_edited_time: string | null;
  notion_error_code: string | null;
  reviewed_at: number | null;
  published_knowledge_id: string | null;
  published_knowledge_version: number | null;
  created_at: number;
  updated_at: number;
}

export interface LearningHistoryRow {
  id: number;
  candidate_id: string;
  candidate_version: number;
  action: 'CAPTURE' | 'EXTRACT' | 'SYNC' | 'REVIEW' | 'REJECT' | 'PUBLISH' | 'ERROR';
  review_status: LearningReviewStatus;
  extraction_status: LearningExtractionStatus;
  risk_level: LearningRiskLevel;
  actor_type: string;
  actor_ref: string;
  detail_code: string | null;
  created_at: number;
}

export interface LearningMessageRow {
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

