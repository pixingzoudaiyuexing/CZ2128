import { Env } from '../config/env';
import { mergeLearningRisk, sanitizeLearningText } from './privacy';
import {
  LearningCandidateRow,
  LearningHistoryRow,
  LearningMessageRow,
  LearningNotionSyncStatus,
  LearningReviewStatus
} from './types';

export const LEARNING_CAPTURE_RECOVERY_LIMIT = 25;
export const LEARNING_ADMIN_PAGE_SIZE = 10;

function notionSyncDefault(env: Env): LearningNotionSyncStatus {
  return env.NOTION_LEARNING_ENABLED?.trim().toLowerCase() === 'true' ? 'PENDING' : 'DISABLED';
}

function newCandidateId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return 'lrn_' + Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
}

export async function getLearningCandidate(env: Env, id: string): Promise<LearningCandidateRow | null> {
  return env.DB.prepare('SELECT * FROM learning_candidates WHERE id = ?')
    .bind(id)
    .first<LearningCandidateRow>();
}

export async function getLearningCandidateBySourceMessage(
  env: Env,
  sourceHumanMessageId: string
): Promise<LearningCandidateRow | null> {
  return env.DB.prepare('SELECT * FROM learning_candidates WHERE source_human_message_id = ?')
    .bind(sourceHumanMessageId)
    .first<LearningCandidateRow>();
}

export async function listLearningCandidates(
  env: Env,
  limit = LEARNING_ADMIN_PAGE_SIZE,
  offset = 0
): Promise<LearningCandidateRow[]> {
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 50);
  const safeOffset = Math.max(Math.trunc(offset), 0);
  const rows = await env.DB.prepare(
    'SELECT * FROM learning_candidates ORDER BY updated_at DESC, id ASC LIMIT ? OFFSET ?'
  ).bind(safeLimit, safeOffset).all<LearningCandidateRow>();
  return rows.results;
}

export async function listLearningHistory(
  env: Env,
  candidateId: string,
  limit = 20
): Promise<LearningHistoryRow[]> {
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 50);
  const rows = await env.DB.prepare(
    'SELECT * FROM learning_candidate_history WHERE candidate_id = ? ORDER BY id DESC LIMIT ?'
  ).bind(candidateId, safeLimit).all<LearningHistoryRow>();
  return rows.results;
}

export async function loadLearningMessageByProviderRef(
  env: Env,
  provider: string,
  providerMessageRef: string
): Promise<LearningMessageRow | null> {
  return env.DB.prepare(
    'SELECT * FROM messages WHERE provider = ? AND provider_message_ref = ?'
  ).bind(provider, providerMessageRef).first<LearningMessageRow>();
}

async function nearestPriorCustomerQuestion(
  env: Env,
  humanMessageId: string
): Promise<LearningMessageRow | null> {
  return env.DB.prepare(
    `SELECT q.*
       FROM messages q
       JOIN messages h ON h.id = ?
      WHERE q.conversation_id = h.conversation_id
        AND q.actor_role = 'CUSTOMER'
        AND q.message_type = 'TEXT'
        AND q.text_content IS NOT NULL
        AND length(trim(q.text_content)) > 0
        AND q.rowid < h.rowid
      ORDER BY q.rowid DESC
      LIMIT 1`
  ).bind(humanMessageId).first<LearningMessageRow>();
}

export async function captureLearningCandidateFromMessage(
  env: Env,
  human: LearningMessageRow,
  actorRef = 'learning-capture'
): Promise<LearningCandidateRow | null> {
  if (
    human.actor_role !== 'OPERATOR' ||
    human.message_type !== 'TEXT' ||
    !human.text_content?.trim()
  ) return null;

  const existing = await getLearningCandidateBySourceMessage(env, human.id);
  if (existing) return existing;

  const question = await nearestPriorCustomerQuestion(env, human.id);
  const answerSanitized = sanitizeLearningText(human.text_content);
  const questionSanitized = question?.text_content
    ? sanitizeLearningText(question.text_content)
    : null;
  if (!answerSanitized.text) return null;

  const risk = mergeLearningRisk(
    answerSanitized,
    ...(questionSanitized ? [questionSanitized] : [])
  );
  const reviewStatus: LearningReviewStatus = risk.riskLevel === 'HIGH' ? 'NEEDS_REVIEW' : 'CAPTURED';
  const candidateId = newCandidateId();
  const now = Math.floor(Date.now() / 1000);
  const notionSyncStatus = notionSyncDefault(env);

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO learning_candidates
       (id, version, source_conversation_id, source_human_message_id, source_question_message_id,
        source_provider, review_status, sanitized_question, sanitized_answer, risk_level, risk_flags_json,
        extraction_status, extraction_attempt_count, notion_sync_status, created_at, updated_at)
       VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', 0, ?, ?, ?)
       ON CONFLICT(source_human_message_id) DO NOTHING`
    ).bind(
      candidateId,
      human.conversation_id,
      human.id,
      question?.id || null,
      human.provider,
      reviewStatus,
      questionSanitized?.text || null,
      answerSanitized.text,
      risk.riskLevel,
      JSON.stringify(risk.flags),
      notionSyncStatus,
      now,
      now
    ),
    env.DB.prepare(
      `INSERT INTO learning_candidate_history
       (candidate_id, candidate_version, action, review_status, extraction_status, risk_level,
        actor_type, actor_ref, detail_code, created_at)
       SELECT id, version, 'CAPTURE', review_status, extraction_status, risk_level,
              'SYSTEM', ?, 'HUMAN_REPLY_CAPTURED', ?
         FROM learning_candidates
        WHERE id = ?`
    ).bind(actorRef.slice(0, 128), now, candidateId)
  ]);

  return getLearningCandidateBySourceMessage(env, human.id);
}

export async function captureLearningCandidateByProviderRef(
  env: Env,
  provider: string,
  providerMessageRef: string,
  actorRef = 'learning-capture'
): Promise<LearningCandidateRow | null> {
  const message = await loadLearningMessageByProviderRef(env, provider, providerMessageRef);
  return message ? captureLearningCandidateFromMessage(env, message, actorRef) : null;
}

export async function listRecoverableHumanReplies(
  env: Env,
  limit = LEARNING_CAPTURE_RECOVERY_LIMIT
): Promise<LearningMessageRow[]> {
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), LEARNING_CAPTURE_RECOVERY_LIMIT);
  const rows = await env.DB.prepare(
    `SELECT m.*
       FROM messages m
      WHERE m.actor_role = 'OPERATOR'
        AND m.message_type = 'TEXT'
        AND m.text_content IS NOT NULL
        AND length(trim(m.text_content)) > 0
        AND m.provider IN ('crisp', 'telegram')
        AND NOT EXISTS (
              SELECT 1 FROM learning_candidates c WHERE c.source_human_message_id = m.id
            )
        AND (
          m.provider = 'crisp'
          OR EXISTS (
            SELECT 1
              FROM outbound_operations o
             WHERE o.subject_type = 'MESSAGE'
               AND o.subject_ref = 'telegram:' || m.provider_message_ref
               AND (
                 o.status = 'SENT'
                 OR (
                   o.status = 'AMBIGUOUS'
                   AND o.reconciliation_status IN ('CONFIRMED_SENT', 'MANUAL_MARK_DELIVERED')
                 )
               )
          )
        )
      ORDER BY m.rowid ASC
      LIMIT ?`
  ).bind(safeLimit).all<LearningMessageRow>();
  return rows.results;
}

export async function recoverMissingLearningCandidates(
  env: Env,
  limit = LEARNING_CAPTURE_RECOVERY_LIMIT
): Promise<number> {
  const messages = await listRecoverableHumanReplies(env, limit);
  let captured = 0;
  for (const message of messages) {
    const before = await getLearningCandidateBySourceMessage(env, message.id);
    if (before) continue;
    const after = await captureLearningCandidateFromMessage(env, message, 'learning-cron-recovery');
    if (after) captured += 1;
  }
  return captured;
}

export async function recordLearningError(
  env: Env,
  candidateId: string,
  detailCode: string,
  actorRef: string
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO learning_candidate_history
     (candidate_id, candidate_version, action, review_status, extraction_status, risk_level,
      actor_type, actor_ref, detail_code, created_at)
     SELECT id, version, 'ERROR', review_status, extraction_status, risk_level,
            'SYSTEM', ?, ?, ?
       FROM learning_candidates
      WHERE id = ?`
  ).bind(actorRef.slice(0, 128), detailCode.slice(0, 128), now, candidateId).run();
}

