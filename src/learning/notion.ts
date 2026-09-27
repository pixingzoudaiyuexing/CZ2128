import { Env } from '../config/env';
import { sanitizeLearningText, mergeLearningRisk } from './privacy';
import {
  candidateNotionProperties,
  createNotionCandidatePage,
  getNotionLearningConfig,
  NotionLearningError,
  notionPlainText,
  notionStatusName,
  queryCandidatePages,
  retrieveNotionDataSource,
  retrieveNotionPage,
  updateNotionPage,
  validateCandidateDataSourceSchema,
  validateKnowledgeSourcesDataSourceSchema
} from './notion-api';
import { getLearningCandidate } from './repository';
import { LearningCandidateRow, LearningReviewStatus } from './types';

const NOTION_SYNC_LEASE_SECONDS = 90;

function leaseToken(): string {
  return 'nls_' + crypto.randomUUID().replace(/-/g, '');
}

async function claimSyncLease(
  env: Env,
  candidate: LearningCandidateRow
): Promise<string | null> {
  const now = Math.floor(Date.now() / 1000);
  const token = leaseToken();
  const result = await env.DB.prepare(
    `UPDATE learning_candidates
        SET notion_sync_lease_token = ?, notion_sync_lease_until = ?, updated_at = ?
      WHERE id = ? AND version = ?
        AND (notion_sync_lease_until IS NULL OR notion_sync_lease_until <= ?)`
  ).bind(token, now + NOTION_SYNC_LEASE_SECONDS, now, candidate.id, candidate.version, now).run();
  return result.meta.changes === 1 ? token : null;
}

async function finishSyncError(
  env: Env,
  candidateId: string,
  token: string,
  code: string,
  status: 'ERROR' | 'DUPLICATE' | 'PENDING' = 'ERROR'
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE learning_candidates
          SET notion_sync_status = ?, notion_error_code = ?,
              notion_sync_lease_token = NULL, notion_sync_lease_until = NULL, updated_at = ?
        WHERE id = ? AND notion_sync_lease_token = ?`
    ).bind(status, code.slice(0, 128), now, candidateId, token),
    env.DB.prepare(
      `INSERT INTO learning_candidate_history
       (candidate_id, candidate_version, action, review_status, extraction_status, risk_level,
        actor_type, actor_ref, detail_code, created_at)
       SELECT id, version, 'ERROR', review_status, extraction_status, risk_level,
              'SYSTEM', 'notion-sync', ?, ?
         FROM learning_candidates
        WHERE id = ?`
    ).bind(code.slice(0, 128), now, candidateId)
  ]);
}

async function releaseSyncLease(env: Env, candidateId: string, token: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE learning_candidates
        SET notion_sync_lease_token = NULL, notion_sync_lease_until = NULL
      WHERE id = ? AND notion_sync_lease_token = ?`
  ).bind(candidateId, token).run();
}

export async function validateNotionLearningSources(env: Env): Promise<'DISABLED' | 'READY'> {
  const config = getNotionLearningConfig(env);
  if (config.state === 'DISABLED') return 'DISABLED';
  if (config.state === 'INVALID') throw new NotionLearningError(config.reason);
  const [candidates, sources] = await Promise.all([
    retrieveNotionDataSource(config, config.candidateDataSourceId),
    retrieveNotionDataSource(config, config.knowledgeSourcesDataSourceId)
  ]);
  validateCandidateDataSourceSchema(candidates);
  validateKnowledgeSourcesDataSourceSchema(sources);
  return 'READY';
}

export async function syncLearningCandidateToNotion(
  env: Env,
  candidateId: string
): Promise<LearningCandidateRow> {
  const candidate = await getLearningCandidate(env, candidateId);
  if (!candidate) throw new Error('LEARNING_CANDIDATE_NOT_FOUND');
  const config = getNotionLearningConfig(env);
  if (config.state === 'DISABLED') {
    await env.DB.prepare(
      `UPDATE learning_candidates
          SET notion_sync_status = 'DISABLED', notion_error_code = NULL
        WHERE id = ?`
    ).bind(candidate.id).run();
    return (await getLearningCandidate(env, candidate.id)) || candidate;
  }
  if (config.state === 'INVALID') {
    await env.DB.prepare(
      `UPDATE learning_candidates
          SET notion_sync_status = 'ERROR', notion_error_code = 'NOTION_CONFIG_INCOMPLETE'
        WHERE id = ?`
    ).bind(candidate.id).run();
    return (await getLearningCandidate(env, candidate.id)) || candidate;
  }

  const token = await claimSyncLease(env, candidate);
  if (!token) return (await getLearningCandidate(env, candidate.id)) || candidate;

  try {
    const schema = await retrieveNotionDataSource(config, config.candidateDataSourceId);
    validateCandidateDataSourceSchema(schema);
    const matches = await queryCandidatePages(config, candidate.id);
    if (matches.length > 1) {
      await finishSyncError(env, candidate.id, token, 'NOTION_DUPLICATE_CANDIDATE', 'DUPLICATE');
      return (await getLearningCandidate(env, candidate.id)) || candidate;
    }

    let page: any;
    if (matches.length === 1) {
      page = matches[0];
      if (
        candidate.notion_page_id &&
        typeof page?.id === 'string' &&
        page.id !== candidate.notion_page_id
      ) {
        await finishSyncError(env, candidate.id, token, 'NOTION_PAGE_ID_MISMATCH');
        return (await getLearningCandidate(env, candidate.id)) || candidate;
      }
    } else {
      if (candidate.notion_page_id) {
        await finishSyncError(env, candidate.id, token, 'NOTION_PAGE_MISSING');
        return (await getLearningCandidate(env, candidate.id)) || candidate;
      }
      page = await createNotionCandidatePage(config, candidateNotionProperties(candidate, schema));
    }

    if (!page || typeof page.id !== 'string' || page.id.length < 8 || page.in_trash === true) {
      await finishSyncError(env, candidate.id, token, 'NOTION_INVALID_PAGE');
      return (await getLearningCandidate(env, candidate.id)) || candidate;
    }

    const updated = await updateNotionPage(
      config,
      page.id,
      candidateNotionProperties(candidate, schema)
    );
    const now = Math.floor(Date.now() / 1000);
    const lastEdited = typeof updated?.last_edited_time === 'string'
      ? updated.last_edited_time.slice(0, 64)
      : typeof page?.last_edited_time === 'string'
        ? page.last_edited_time.slice(0, 64)
        : null;
    const results = await env.DB.batch([
      env.DB.prepare(
        `UPDATE learning_candidates
            SET notion_page_id = ?, notion_sync_status = 'SYNCED',
                last_synced_candidate_version = ?, notion_last_edited_time = ?, notion_error_code = NULL,
                notion_sync_lease_token = NULL, notion_sync_lease_until = NULL, updated_at = ?
          WHERE id = ? AND version = ? AND notion_sync_lease_token = ?
            AND (notion_page_id IS NULL OR notion_page_id = ?)`
      ).bind(
        page.id,
        candidate.version,
        lastEdited,
        now,
        candidate.id,
        candidate.version,
        token,
        page.id
      ),
      env.DB.prepare(
        `INSERT INTO learning_candidate_history
         (candidate_id, candidate_version, action, review_status, extraction_status, risk_level,
          actor_type, actor_ref, detail_code, created_at)
         SELECT id, version, 'SYNC', review_status, extraction_status, risk_level,
                'SYSTEM', 'notion-sync', 'NOTION_SYNCED', ?
           FROM learning_candidates
          WHERE id = ? AND version = ? AND notion_sync_status = 'SYNCED'`
      ).bind(now, candidate.id, candidate.version)
    ]);
    if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
      await finishSyncError(env, candidate.id, token, 'NOTION_STALE_AFTER_SYNC', 'PENDING');
    }
  } catch (error) {
    const code = error instanceof NotionLearningError ? error.code : 'NOTION_SYNC_FAILED';
    await finishSyncError(env, candidate.id, token, code);
  }
  return (await getLearningCandidate(env, candidate.id)) || candidate;
}

function remoteReviewStatus(page: any): string {
  return notionStatusName(page?.properties?.Status).trim();
}

export async function pullLearningCandidateReview(
  env: Env,
  candidateId: string
): Promise<LearningCandidateRow> {
  const candidate = await getLearningCandidate(env, candidateId);
  if (!candidate) throw new Error('LEARNING_CANDIDATE_NOT_FOUND');
  if (candidate.review_status === 'PUBLISHED' || candidate.review_status === 'REJECTED') return candidate;
  const config = getNotionLearningConfig(env);
  if (config.state !== 'READY' || !candidate.notion_page_id || !candidate.last_synced_candidate_version) {
    return candidate;
  }
  const token = await claimSyncLease(env, candidate);
  if (!token) return (await getLearningCandidate(env, candidate.id)) || candidate;

  try {
    if (candidate.version !== candidate.last_synced_candidate_version) {
      await finishSyncError(env, candidate.id, token, 'NOTION_STALE_REVIEW', 'PENDING');
      return (await getLearningCandidate(env, candidate.id)) || candidate;
    }
    const page = await retrieveNotionPage(config, candidate.notion_page_id);
    if (
      !page ||
      page.id !== candidate.notion_page_id ||
      page.in_trash === true ||
      notionPlainText(page?.properties?.['Candidate ID']) !== candidate.id
    ) {
      await finishSyncError(env, candidate.id, token, 'NOTION_REVIEW_IDENTITY_MISMATCH');
      return (await getLearningCandidate(env, candidate.id)) || candidate;
    }

    const remoteStatus = remoteReviewStatus(page);
    if (remoteStatus !== 'Approved' && remoteStatus !== 'Rejected') {
      await releaseSyncLease(env, candidate.id, token);
      return (await getLearningCandidate(env, candidate.id)) || candidate;
    }

    const title = sanitizeLearningText(notionPlainText(page?.properties?.Candidate).replace(/\s+/g, ' ').slice(0, 120));
    const question = sanitizeLearningText(notionPlainText(page?.properties?.Question));
    const answer = sanitizeLearningText(notionPlainText(page?.properties?.['Proposed Answer']));
    const notes = sanitizeLearningText(notionPlainText(page?.properties?.['Review Notes']).slice(0, 4000));
    const risk = mergeLearningRisk(title, question, answer, notes);
    let existingFlags: string[] = [];
    try {
      const parsed = JSON.parse(candidate.risk_flags_json || '[]');
      existingFlags = Array.isArray(parsed)
        ? parsed.filter((item: unknown): item is string => typeof item === 'string')
        : [];
    } catch {
      existingFlags = ['RISK_FLAGS_INVALID'];
    }
    const flags = Array.from(new Set([...existingFlags, ...risk.flags])).slice(0, 50);
    const now = Math.floor(Date.now() / 1000);
    const nextVersion = candidate.version + 1;
    const unsafeApproved = remoteStatus === 'Approved' && (
      risk.riskLevel === 'HIGH' ||
      !title.text ||
      !question.text ||
      !answer.text
    );
    const nextStatus: LearningReviewStatus = unsafeApproved
      ? 'NEEDS_REVIEW'
      : remoteStatus === 'Approved'
        ? 'APPROVED'
        : 'REJECTED';
    const detail = unsafeApproved
      ? 'APPROVED_CONTENT_UNSAFE'
      : remoteStatus === 'Approved'
        ? 'NOTION_APPROVED'
        : 'NOTION_REJECTED';
    const historyAction = remoteStatus === 'Rejected' ? 'REJECT' : unsafeApproved ? 'ERROR' : 'REVIEW';

    const results = await env.DB.batch([
      env.DB.prepare(
        `UPDATE learning_candidates
            SET version = ?, review_status = ?, extracted_title = ?, extracted_question = ?,
                extracted_answer = ?, review_notes = ?, risk_level = ?, risk_flags_json = ?,
                reviewed_at = ?, notion_last_edited_time = ?, notion_sync_status = ?,
                notion_error_code = ?, notion_sync_lease_token = NULL, notion_sync_lease_until = NULL,
                updated_at = ?
          WHERE id = ? AND version = ? AND last_synced_candidate_version = ?
            AND notion_page_id = ? AND notion_sync_lease_token = ?`
      ).bind(
        nextVersion,
        nextStatus,
        title.text || candidate.extracted_title,
        question.text || candidate.extracted_question,
        answer.text || candidate.extracted_answer,
        notes.text || null,
        risk.riskLevel,
        JSON.stringify(flags),
        now,
        typeof page.last_edited_time === 'string' ? page.last_edited_time.slice(0, 64) : null,
        unsafeApproved ? 'PENDING' : 'SYNCED',
        unsafeApproved ? detail : null,
        now,
        candidate.id,
        candidate.version,
        candidate.last_synced_candidate_version,
        candidate.notion_page_id,
        token
      ),
      env.DB.prepare(
        `INSERT INTO learning_candidate_history
         (candidate_id, candidate_version, action, review_status, extraction_status, risk_level,
          actor_type, actor_ref, detail_code, created_at)
         SELECT id, version, ?, review_status, extraction_status, risk_level,
                'NOTION_REVIEWER', 'notion', ?, ?
           FROM learning_candidates
          WHERE id = ? AND version = ?`
      ).bind(historyAction, detail, now, candidate.id, nextVersion)
    ]);
    if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
      await finishSyncError(env, candidate.id, token, 'NOTION_REVIEW_CAS_CONFLICT', 'PENDING');
    }
  } catch (error) {
    const code = error instanceof NotionLearningError ? error.code : 'NOTION_REVIEW_FAILED';
    await finishSyncError(env, candidate.id, token, code);
  }
  return (await getLearningCandidate(env, candidate.id)) || candidate;
}

