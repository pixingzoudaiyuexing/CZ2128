import { DatabaseEnv } from './database';
import { OutboundOperation } from './domain';

export const TOPIC_LIFECYCLE_OPERATION_PREFIX = 'topic_lifecycle_v2_';

export function topicLifecyclePrefix(conversationId: string): string {
  return `${TOPIC_LIFECYCLE_OPERATION_PREFIX}${conversationId}_`;
}

export function isManagedTopicLifecycleOperation(operation: OutboundOperation): boolean {
  return operation.id.startsWith(topicLifecyclePrefix(operation.conversation_id)) &&
    (operation.operation_type === 'CLOSE_TOPIC' || operation.operation_type === 'REOPEN_TOPIC');
}

export function topicLifecycleTarget(operation: OutboundOperation): 'OPEN' | 'CLOSED' {
  return operation.operation_type === 'CLOSE_TOPIC' ? 'CLOSED' : 'OPEN';
}

export async function loadLatestTopicLifecycleOperation(
  env: DatabaseEnv,
  conversationId: string
): Promise<OutboundOperation | null> {
  return env.DB.prepare(
    `SELECT * FROM outbound_operations
     WHERE conversation_id = ? AND subject_type = 'CONVERSATION' AND instr(id, ?) = 1
       AND operation_type IN ('CLOSE_TOPIC', 'REOPEN_TOPIC')
     ORDER BY id DESC LIMIT 1`
  ).bind(conversationId, topicLifecyclePrefix(conversationId)).first<OutboundOperation>();
}

export async function findManagedTopicLifecycleRoot(
  env: DatabaseEnv,
  operation: OutboundOperation
): Promise<OutboundOperation | null> {
  let current = operation;
  const visited = new Set<string>();
  for (let depth = 0; depth < 16; depth += 1) {
    if (visited.has(current.id)) throw new Error('Topic lifecycle operation ancestry cycle');
    visited.add(current.id);
    if (isManagedTopicLifecycleOperation(current)) return current;
    if (!current.parent_operation_id) return null;
    const parent = await env.DB.prepare('SELECT * FROM outbound_operations WHERE id = ?')
      .bind(current.parent_operation_id).first<OutboundOperation>();
    if (!parent) throw new Error('Topic lifecycle operation parent missing');
    current = parent;
  }
  throw new Error('Topic lifecycle operation ancestry too deep');
}

export async function loadTopicLifecycleLeaf(
  env: DatabaseEnv,
  root: OutboundOperation
): Promise<OutboundOperation> {
  let current = root;
  const visited = new Set<string>();
  for (let depth = 0; depth < 16; depth += 1) {
    if (visited.has(current.id)) throw new Error('Topic lifecycle operation descendant cycle');
    visited.add(current.id);
    const children = await env.DB.prepare(
      'SELECT * FROM outbound_operations WHERE parent_operation_id = ? ORDER BY id'
    ).bind(current.id).all<OutboundOperation>();
    if (children.results.length === 0) return current;
    if (children.results.length !== 1) throw new Error('Topic lifecycle operation has multiple direct children');
    current = children.results[0];
  }
  throw new Error('Topic lifecycle operation descendants too deep');
}

export async function isLatestTopicLifecycleRoot(
  env: DatabaseEnv,
  root: OutboundOperation
): Promise<boolean> {
  const latest = await loadLatestTopicLifecycleOperation(env, root.conversation_id);
  return latest?.id === root.id;
}

export function nextTopicLifecycleOperationId(
  conversationId: string,
  latest: OutboundOperation | null,
  target: 'OPEN' | 'CLOSED'
): string {
  let sequence = 1;
  if (latest) {
    const suffix = latest.id.slice(topicLifecyclePrefix(conversationId).length);
    const current = Number(suffix.slice(0, 8));
    if (!Number.isSafeInteger(current) || current < 1 || current >= 99_999_999) {
      throw new Error('Invalid lifecycle operation sequence');
    }
    sequence = current + 1;
  }
  return `${topicLifecyclePrefix(conversationId)}${String(sequence).padStart(8, '0')}_${target.toLowerCase()}`;
}
