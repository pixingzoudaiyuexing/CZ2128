import { Env } from '../config/env';
import { logger } from '../observability/logger';
import { extractPendingLearningCandidates } from './extraction';
import { getNotionLearningConfig } from './notion-api';
import { pullLearningCandidateReview, syncLearningCandidateToNotion } from './notion';
import { publishApprovedLearningCandidate } from './publish';
import { recoverMissingLearningCandidates } from './repository';

export interface LearningMaintenanceResult {
  captured: number;
  extracted: number;
  synced: number;
  reviews: number;
  published: number;
}

export async function runLearningMaintenance(env: Env): Promise<LearningMaintenanceResult> {
  const result: LearningMaintenanceResult = {
    captured: 0,
    extracted: 0,
    synced: 0,
    reviews: 0,
    published: 0
  };
  try {
    result.captured = await recoverMissingLearningCandidates(env, 25);
  } catch (error) {
    logger.warn('Learning capture compensation failed', { result: 'FAILED' });
  }
  try {
    result.extracted = await extractPendingLearningCandidates(env, 10);
  } catch (error) {
    logger.warn('Learning extraction compensation failed', { result: 'FAILED' });
  }

  const notion = getNotionLearningConfig(env);
  if (notion.state !== 'READY') return result;

  try {
    const syncRows = await env.DB.prepare(
      `SELECT id
         FROM learning_candidates
        WHERE notion_sync_status IN ('PENDING', 'ERROR')
          AND review_status <> 'REJECTED'
        ORDER BY updated_at ASC, id ASC
        LIMIT 10`
    ).all<{ id: string }>();
    for (const row of syncRows.results) {
      await syncLearningCandidateToNotion(env, row.id);
      result.synced += 1;
    }
  } catch {
    logger.warn('Learning Notion sync compensation failed', { result: 'FAILED' });
  }

  try {
    const reviewRows = await env.DB.prepare(
      `SELECT id
         FROM learning_candidates
        WHERE notion_sync_status = 'SYNCED'
          AND review_status IN ('CAPTURED', 'NEEDS_REVIEW')
          AND notion_page_id IS NOT NULL
          AND last_synced_candidate_version = version
        ORDER BY updated_at ASC, id ASC
        LIMIT 10`
    ).all<{ id: string }>();
    for (const row of reviewRows.results) {
      const reviewed = await pullLearningCandidateReview(env, row.id);
      result.reviews += 1;
      if (reviewed.review_status === 'APPROVED') {
        const published = await publishApprovedLearningCandidate(env, reviewed.id);
        if (published.review_status === 'PUBLISHED') {
          result.published += 1;
          await syncLearningCandidateToNotion(env, published.id);
        }
      }
    }
  } catch {
    logger.warn('Learning review compensation failed', { result: 'FAILED' });
  }
  return result;
}
