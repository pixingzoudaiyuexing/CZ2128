import { Env } from '../config/env';
import { decryptRuntimeSecret, encryptRuntimeSecret } from './crypto';
import { getRuntimeConfigDefinition, validateRuntimeValue } from './registry';
import {
  getRuntimeConfig,
  getRuntimeHistory,
  migrateSupportGroup,
  removeRuntimeConfig,
  rollbackRuntimeConfig,
  setRuntimeConfig
} from './repository';
import { RuntimeConfigAction, RuntimeConfigKey } from './types';

export async function currentRuntimeVersion(env: Env, key: RuntimeConfigKey): Promise<number> {
  return Number((await getRuntimeConfig(env, key))?.version || 0);
}

function validateCrossFieldConfig(env: Env, key: RuntimeConfigKey, value: string): void {
  if (key !== 'AI_REQUEST_TIMEOUT_MS' && key !== 'AI_GENERATION_LEASE_SECONDS') return;
  const timeoutMs = Number(key === 'AI_REQUEST_TIMEOUT_MS' ? value : env.AI_REQUEST_TIMEOUT_MS || 30000);
  const leaseSeconds = Number(key === 'AI_GENERATION_LEASE_SECONDS' ? value : env.AI_GENERATION_LEASE_SECONDS || 60);
  if (leaseSeconds < Math.ceil(timeoutMs / 1000) + 10) {
    throw new Error('AI_LEASE_TOO_SHORT');
  }
}

export async function setPlainOverride(
  env: Env,
  key: RuntimeConfigKey,
  value: string,
  expectedVersion: number,
  actorUserId: string,
  sourceUpdateId: string,
  action: RuntimeConfigAction = 'SET'
): Promise<number> {
  const definition = getRuntimeConfigDefinition(key);
  if (definition.kind !== 'PLAIN') throw new Error('CONFIG_KIND_MISMATCH');
  const normalized = validateRuntimeValue(key, value);
  validateCrossFieldConfig(env, key, normalized);
  return setRuntimeConfig(env, {
    key,
    kind: 'PLAIN',
    valueText: normalized,
    expectedVersion,
    actorUserId,
    sourceUpdateId,
    action
  });
}

export async function setSecretOverride(
  env: Env,
  key: RuntimeConfigKey,
  value: string,
  expectedVersion: number,
  actorUserId: string,
  sourceUpdateId: string,
  action: RuntimeConfigAction = 'SET'
): Promise<number> {
  const definition = getRuntimeConfigDefinition(key);
  if (definition.kind !== 'SECRET') throw new Error('CONFIG_KIND_MISMATCH');
  const normalized = validateRuntimeValue(key, value);
  const encrypted = await encryptRuntimeSecret(env.RUNTIME_CONFIG_MASTER_KEY || '', key, normalized);
  return setRuntimeConfig(env, {
    key,
    kind: 'SECRET',
    ...encrypted,
    expectedVersion,
    actorUserId,
    sourceUpdateId,
    action
  });
}

export async function restoreEnvOverride(
  env: Env,
  key: RuntimeConfigKey,
  expectedVersion: number,
  actorUserId: string,
  sourceUpdateId: string
): Promise<number> {
  if (getRuntimeConfigDefinition(key).rollback === 'DEDICATED') {
    throw new Error('DEDICATED_WORKFLOW_REQUIRED');
  }
  return removeRuntimeConfig(env, key, expectedVersion, actorUserId, sourceUpdateId);
}

export async function rollbackOverride(
  env: Env,
  historyId: number,
  expectedVersion: number,
  actorUserId: string,
  sourceUpdateId: string
): Promise<number> {
  const history = await getRuntimeHistory(env, historyId);
  if (!history) throw new Error('HISTORY_NOT_FOUND');
  const definition = getRuntimeConfigDefinition(history.key);
  if (definition.rollback === 'DEDICATED') throw new Error('DEDICATED_WORKFLOW_REQUIRED');
  if (history.value_kind === 'SECRET' && !history.is_deleted) {
    if (!history.ciphertext || !history.nonce) throw new Error('HISTORY_SECRET_INVALID');
    await decryptRuntimeSecret(
      env.RUNTIME_CONFIG_MASTER_KEY || '',
      history.key,
      history.ciphertext,
      history.nonce
    );
  }
  return rollbackRuntimeConfig(env, history, expectedVersion, actorUserId, sourceUpdateId);
}

export async function migrateTelegramGroup(
  env: Env,
  groupId: string,
  expectedVersion: number,
  actorUserId: string,
  sourceUpdateId: string
): Promise<number> {
  const normalized = validateRuntimeValue('BOT_GROUP_ID', groupId);
  return migrateSupportGroup(env, normalized, expectedVersion, actorUserId, sourceUpdateId);
}
