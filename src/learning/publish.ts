import { Env } from '../config/env';
import {
  buildKnowledgeSearchTerms,
  getKnowledgeEntry,
  sanitizeKnowledgeBody,
  sanitizeKnowledgeTitle
} from '../knowledge/repository';
import { getLearningCandidate } from './repository';
import { LearningCandidateRow } from './types';

async function learningKnowledgeId(candidateId: string): Promise<string> {
  const bytes = new TextEncoder().encode(candidateId);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  return 'kb_lrn_' + hex.slice(0, 24);
}

export async function publishApprovedLearningCandidate(
  env: Env,
  candidateId: string
): Promise<LearningCandidateRow> {
  const candidate = await getLearningCandidate(env, candidateId);
  if (!candidate) throw new Error('LEARNING_CANDIDATE_NOT_FOUND');
  if (candidate.review_status === 'PUBLISHED') return candidate;
  if (candidate.review_status !== 'APPROVED') return candidate;
  if (candidate.risk_level === 'HIGH') throw new Error('LEARNING_PUBLICATION_HIGH_RISK');
  if (!candidate.extracted_title || !candidate.extracted_answer) {
    throw new Error('LEARNING_PUBLICATION_CONTENT_MISSING');
  }

  const knowledgeId = await learningKnowledgeId(candidate.id);
  const actor = `learning:${candidate.id}`;
  const title = sanitizeKnowledgeTitle(candidate.extracted_title);
  const body = sanitizeKnowledgeBody(candidate.extracted_answer);
  const searchTerms = buildKnowledgeSearchTerms(
    [title, candidate.extracted_question || '', body].filter(Boolean).join('\n')
  );
  if (!searchTerms) throw new Error('LEARNING_PUBLICATION_CONTENT_INVALID');
  const now = Math.floor(Date.now() / 1000);
  const nextVersion = candidate.version + 1;
  const sourceUpdateId = `learning-publish:${candidate.id}:v${candidate.version}`;

  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO knowledge_entries
       (id, title, body, search_terms, enabled, version, created_by, updated_by, created_at, updated_at)
       SELECT ?, ?, ?, ?, 1, 1, ?, ?, ?, ?
         FROM learning_candidates
        WHERE id = ? AND version = ? AND review_status = 'APPROVED'
       ON CONFLICT(id) DO NOTHING`
    ).bind(
      knowledgeId, title, body, searchTerms, actor, actor, now, now,
      candidate.id, candidate.version
    ),
    env.DB.prepare(
      `INSERT INTO knowledge_entry_history
       (entry_id, version, action, title, body, enabled, actor_user_id, source_update_id, created_at)
       SELECT k.id, 1, 'CREATE', k.title, k.body, 1, ?, ?, ?
         FROM knowledge_entries k
         JOIN learning_candidates c ON c.id = ?
        WHERE k.id = ? AND k.created_by = ? AND k.updated_by = ?
          AND k.version = 1 AND k.title = ? AND k.body = ?
          AND c.version = ? AND c.review_status = 'APPROVED'
          AND NOT EXISTS (
            SELECT 1 FROM knowledge_entry_history h WHERE h.entry_id = k.id AND h.version = 1
          )`
    ).bind(
      actor, sourceUpdateId, now, candidate.id, knowledgeId, actor, actor,
      title, body, candidate.version
    ),
    env.DB.prepare(
      `UPDATE learning_candidates
          SET version = ?, review_status = 'PUBLISHED',
              published_knowledge_id = ?, published_knowledge_version = 1,
              notion_sync_status = CASE WHEN notion_page_id IS NULL THEN notion_sync_status ELSE 'PENDING' END,
              notion_error_code = NULL, updated_at = ?
        WHERE id = ? AND version = ? AND review_status = 'APPROVED'
          AND EXISTS (
            SELECT 1 FROM knowledge_entries k
             WHERE k.id = ? AND k.created_by = ? AND k.updated_by = ?
               AND k.version = 1 AND k.title = ? AND k.body = ?
          )`
    ).bind(
      nextVersion, knowledgeId, now, candidate.id, candidate.version,
      knowledgeId, actor, actor, title, body
    ),
    env.DB.prepare(
      `INSERT INTO learning_candidate_history
       (candidate_id, candidate_version, action, review_status, extraction_status, risk_level,
        actor_type, actor_ref, detail_code, created_at)
       SELECT id, version, 'PUBLISH', review_status, extraction_status, risk_level,
              'SYSTEM', 'learning-publish', 'D1_KNOWLEDGE_PUBLISHED', ?
         FROM learning_candidates
        WHERE id = ? AND version = ? AND review_status = 'PUBLISHED'
          AND changes() = 1`
    ).bind(now, candidate.id, nextVersion)
  ]);

  const updated = await getLearningCandidate(env, candidate.id);
  if (!updated) throw new Error('LEARNING_CANDIDATE_NOT_FOUND');
  if (updated.review_status === 'PUBLISHED') {
    const knowledge = await getKnowledgeEntry(env, updated.published_knowledge_id || '');
    if (!knowledge || knowledge.id !== knowledgeId || knowledge.created_by !== actor) {
      throw new Error('LEARNING_PUBLICATION_IDENTITY_MISMATCH');
    }
    return updated;
  }
  if (results[2]?.meta.changes !== 1) throw new Error('LEARNING_PUBLICATION_CAS_CONFLICT');
  return updated;
}

