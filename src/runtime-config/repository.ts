import { Env } from '../config/env';
import {
  AdminSessionRow,
  RuntimeConfigAction,
  RuntimeConfigHistoryRow,
  RuntimeConfigKey,
  RuntimeConfigRow,
  RuntimeValueKind
} from './types';
import { SafeErrorCode } from '../core/error-taxonomy';
import { SafeError } from '../core/errors';

export class RuntimeConfigConflictError extends SafeError {
  constructor() {
    super('RUNTIME_CONFIG_VERSION_CONFLICT');
    this.name = 'RuntimeConfigConflictError';
  }
}

export interface RuntimeConfigMutation {
  key: RuntimeConfigKey;
  kind: RuntimeValueKind;
  valueText?: string;
  ciphertext?: string;
  nonce?: string;
  expectedVersion: number;
  actorUserId: string;
  sourceUpdateId: string;
  action?: RuntimeConfigAction;
}

export async function listRuntimeConfig(env: Env): Promise<RuntimeConfigRow[]> {
  const result = await env.DB.prepare('SELECT * FROM runtime_config ORDER BY key').all<RuntimeConfigRow>();
  return result.results;
}

export async function getRuntimeConfig(env: Env, key: RuntimeConfigKey): Promise<RuntimeConfigRow | null> {
  return env.DB.prepare('SELECT * FROM runtime_config WHERE key = ?').bind(key).first<RuntimeConfigRow>();
}

async function nextVersion(env: Env, key: RuntimeConfigKey): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT COALESCE(MAX(version), 0) AS version FROM runtime_config_history WHERE key = ?'
  ).bind(key).first<{ version: number }>();
  return Number(row?.version || 0) + 1;
}

function payload(input: RuntimeConfigMutation): [string | null, string | null, string | null] {
  return input.kind === 'PLAIN'
    ? [input.valueText ?? null, null, null]
    : [null, input.ciphertext ?? null, input.nonce ?? null];
}

function writeStatements(
  env: Env,
  input: RuntimeConfigMutation,
  version: number,
  now: number
): D1PreparedStatement[] {
  const [valueText, ciphertext, nonce] = payload(input);
  const write = input.expectedVersion === 0
    ? env.DB.prepare(
        `INSERT INTO runtime_config
         (key, value_kind, value_text, ciphertext, nonce, version, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (key) DO NOTHING`
      ).bind(input.key, input.kind, valueText, ciphertext, nonce, version, input.actorUserId, now)
    : env.DB.prepare(
        `UPDATE runtime_config
         SET value_kind = ?, value_text = ?, ciphertext = ?, nonce = ?, version = ?, updated_by = ?, updated_at = ?
         WHERE key = ? AND version = ?`
      ).bind(
        input.kind, valueText, ciphertext, nonce, version, input.actorUserId, now,
        input.key, input.expectedVersion
      );
  const history = env.DB.prepare(
    `INSERT INTO runtime_config_history
     (key, version, value_kind, value_text, ciphertext, nonce, is_deleted,
      actor_user_id, action, source_update_id, created_at)
     SELECT ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?
     WHERE EXISTS (SELECT 1 FROM runtime_config WHERE key = ? AND version = ?)`
  ).bind(
    input.key, version, input.kind, valueText, ciphertext, nonce,
    input.actorUserId, input.action || 'SET', input.sourceUpdateId, now,
    input.key, version
  );
  return [write, history];
}

function changed(result: D1Result): boolean {
  return Number(result.meta.changes || 0) === 1;
}

export async function setRuntimeConfig(env: Env, input: RuntimeConfigMutation): Promise<number> {
  const current = await getRuntimeConfig(env, input.key);
  if (Number(current?.version || 0) !== input.expectedVersion) throw new RuntimeConfigConflictError();
  const version = await nextVersion(env, input.key);
  const now = Math.floor(Date.now() / 1000);
  try {
    const results = await env.DB.batch(writeStatements(env, input, version, now));
    if (!changed(results[0]) || !changed(results[1])) throw new RuntimeConfigConflictError();
    return version;
  } catch (error) {
    if (error instanceof RuntimeConfigConflictError) throw error;
    throw new RuntimeConfigConflictError();
  }
}

export async function removeRuntimeConfig(
  env: Env,
  key: RuntimeConfigKey,
  expectedVersion: number,
  actorUserId: string,
  sourceUpdateId: string
): Promise<number> {
  const current = await getRuntimeConfig(env, key);
  if (!current || current.version !== expectedVersion) throw new RuntimeConfigConflictError();
  const version = await nextVersion(env, key);
  const now = Math.floor(Date.now() / 1000);
  const results = await env.DB.batch([
    env.DB.prepare('DELETE FROM runtime_config WHERE key = ? AND version = ?').bind(key, expectedVersion),
    env.DB.prepare(
      `INSERT INTO runtime_config_history
       (key, version, value_kind, value_text, ciphertext, nonce, is_deleted,
        actor_user_id, action, source_update_id, created_at)
       SELECT ?, ?, ?, NULL, NULL, NULL, 1, ?, 'RESTORE_ENV', ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM runtime_config WHERE key = ?)`
    ).bind(key, version, current.value_kind, actorUserId, sourceUpdateId, now, key)
  ]);
  if (!changed(results[0]) || !changed(results[1])) throw new RuntimeConfigConflictError();
  return version;
}

export async function listRuntimeHistory(env: Env, limit = 20): Promise<RuntimeConfigHistoryRow[]> {
  const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 50);
  const result = await env.DB.prepare(
    'SELECT * FROM runtime_config_history ORDER BY created_at DESC, id DESC LIMIT ?'
  ).bind(safeLimit).all<RuntimeConfigHistoryRow>();
  return result.results;
}

export async function getRuntimeHistory(env: Env, id: number): Promise<RuntimeConfigHistoryRow | null> {
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return env.DB.prepare('SELECT * FROM runtime_config_history WHERE id = ?').bind(id).first<RuntimeConfigHistoryRow>();
}

export async function rollbackRuntimeConfig(
  env: Env,
  history: RuntimeConfigHistoryRow,
  expectedVersion: number,
  actorUserId: string,
  sourceUpdateId: string
): Promise<number> {
  if (history.is_deleted) {
    const current = await getRuntimeConfig(env, history.key);
    if (!current) throw new RuntimeConfigConflictError();
    return removeRuntimeConfig(env, history.key, expectedVersion, actorUserId, sourceUpdateId);
  }
  return setRuntimeConfig(env, {
    key: history.key,
    kind: history.value_kind,
    valueText: history.value_text || undefined,
    ciphertext: history.ciphertext || undefined,
    nonce: history.nonce || undefined,
    expectedVersion,
    actorUserId,
    sourceUpdateId,
    action: 'ROLLBACK'
  });
}

export async function migrateSupportGroup(
  env: Env,
  groupId: string,
  expectedVersion: number,
  actorUserId: string,
  sourceUpdateId: string
): Promise<number> {
  const key: RuntimeConfigKey = 'BOT_GROUP_ID';
  const current = await getRuntimeConfig(env, key);
  if (Number(current?.version || 0) !== expectedVersion) throw new RuntimeConfigConflictError();
  const version = await nextVersion(env, key);
  const now = Math.floor(Date.now() / 1000);
  const input: RuntimeConfigMutation = {
    key,
    kind: 'PLAIN',
    valueText: groupId,
    expectedVersion,
    actorUserId,
    sourceUpdateId,
    action: 'GROUP_MIGRATION'
  };
  const results = await env.DB.batch([
    ...writeStatements(env, input, version, now),
    env.DB.prepare(
      `UPDATE conversations
       SET operator_thread_ref = NULL, operator_thread_status = 'OPEN', updated_at = ?, version = version + 1
       WHERE operator_channel = 'telegram' AND operator_thread_ref IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM runtime_config
           WHERE key = 'BOT_GROUP_ID' AND version = ? AND value_text = ?
         )`
    ).bind(now, version, groupId)
  ]);
  if (!changed(results[0]) || !changed(results[1])) throw new RuntimeConfigConflictError();
  return version;
}

export async function claimAdminUpdate(
  env: Env,
  updateId: string,
  userId: string
): Promise<boolean> {
  const result = await env.DB.prepare(
    `INSERT INTO admin_update_receipts (update_id, admin_user_id, status, created_at)
     VALUES (?, ?, 'PROCESSING', ?)
     ON CONFLICT (update_id) DO NOTHING`
  ).bind(updateId, userId, Math.floor(Date.now() / 1000)).run();
  return result.meta.changes === 1;
}

export async function completeAdminUpdate(
  env: Env,
  updateId: string,
  action: string,
  errorCode?: SafeErrorCode
): Promise<void> {
  await env.DB.prepare(
    `UPDATE admin_update_receipts
     SET status = ?, action = ?, error_code = ?, processed_at = ?
     WHERE update_id = ? AND status = 'PROCESSING'`
  ).bind(
    errorCode ? 'FAILED' : 'PROCESSED', action.slice(0, 64), errorCode || null,
    Math.floor(Date.now() / 1000), updateId
  ).run();
}

export async function getAdminSession(env: Env, userId: string): Promise<AdminSessionRow | null> {
  return env.DB.prepare(
    'SELECT * FROM admin_sessions WHERE admin_user_id = ? AND expires_at > ?'
  ).bind(userId, Math.floor(Date.now() / 1000)).first<AdminSessionRow>();
}

export async function saveAdminSession(
  env: Env,
  session: Omit<AdminSessionRow, 'expires_at' | 'updated_at'>
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO admin_sessions
     (admin_user_id, action, target, expected_version, candidate_value_text,
      candidate_ciphertext, candidate_nonce, context_json, expires_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (admin_user_id) DO UPDATE SET
       action = excluded.action,
       target = excluded.target,
       expected_version = excluded.expected_version,
       candidate_value_text = excluded.candidate_value_text,
       candidate_ciphertext = excluded.candidate_ciphertext,
       candidate_nonce = excluded.candidate_nonce,
       context_json = excluded.context_json,
       expires_at = excluded.expires_at,
       updated_at = excluded.updated_at`
  ).bind(
    session.admin_user_id, session.action, session.target, session.expected_version,
    session.candidate_value_text, session.candidate_ciphertext, session.candidate_nonce,
    session.context_json, now + 600, now
  ).run();
}

export async function clearAdminSession(env: Env, userId: string): Promise<void> {
  await env.DB.prepare('DELETE FROM admin_sessions WHERE admin_user_id = ?').bind(userId).run();
}
