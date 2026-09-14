import { DatabaseEnv } from './database';

export interface ReliabilityAuditInput {
  id: string;
  entityType: 'OUTBOUND_OPERATION';
  entityId: string;
  action: string;
  actorType: 'SYSTEM' | 'ADMIN';
  actorRef?: string;
  oldState?: string;
  newState?: string;
  reasonCode: string;
  createdAt: number;
}

export function auditAfterPreviousChange(
  env: DatabaseEnv,
  input: ReliabilityAuditInput
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO reliability_audit
     (id, entity_type, entity_id, action, actor_type, actor_ref, old_state, new_state, reason_code, created_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE changes() = 1`
  ).bind(
    input.id,
    input.entityType,
    input.entityId,
    input.action,
    input.actorType,
    input.actorRef || null,
    input.oldState || null,
    input.newState || null,
    input.reasonCode,
    input.createdAt
  );
}

export function d1Changed(result: D1Result | undefined): boolean {
  return Number(result?.meta.changes || 0) === 1;
}
