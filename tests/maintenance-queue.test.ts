import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteD1 } from './helpers/sqlite-d1';
import { handleQueueEvent, eventLeaseSeconds } from '../src/queue/consumer';
import type { MaintenanceTickEvent } from '../src/core/events';
import { captureDlqMessage } from '../src/queue/dlq-consumer';
import * as attachments from '../src/attachments/cleanup';
import * as uploads from '../src/uploads/sessions';
import * as learning from '../src/learning/maintenance';

function tick(kind:MaintenanceTickEvent['payload']['kind'],scheduledHour=123):MaintenanceTickEvent {
  return {version:1,source:'internal',type:'maintenance_tick',eventId:`maintenance:${scheduledHour}:${kind.toLowerCase()}`,payload:{scheduledHour,kind}};
}
describe('free Cron delegates bounded maintenance to durable Queue receipts',()=>{
  let db:SqliteD1;let env:any;
  beforeEach(()=>{db=new SqliteD1();db.migrate();env={DB:db};vi.spyOn(attachments,'cleanupExpiredAttachments').mockResolvedValue(undefined);vi.spyOn(uploads,'cleanupUploadSessions').mockResolvedValue(undefined);vi.spyOn(learning,'runLearningMaintenance').mockResolvedValue({} as learning.LearningMaintenanceResult);});
  afterEach(()=>{vi.restoreAllMocks();db.close();});
  it.each(['ATTACHMENTS','UPLOADS','LEARNING'] as const)('executes %s independently and idempotently without processing the other categories',async kind=>{
    const event=tick(kind);expect(eventLeaseSeconds(event,env)).toBe(360);await handleQueueEvent(event,env);await handleQueueEvent(event,env);
    expect(attachments.cleanupExpiredAttachments).toHaveBeenCalledTimes(kind==='ATTACHMENTS'?1:0);
    expect(uploads.cleanupUploadSessions).toHaveBeenCalledTimes(kind==='UPLOADS'?1:0);
    expect(learning.runLearningMaintenance).toHaveBeenCalledTimes(kind==='LEARNING'?1:0);
    expect((await db.prepare('SELECT status FROM event_receipts').first<any>()).status).toBe('PROCESSED');
  });
  it('keeps a failing maintenance receipt retryable and recovers without blocking the other categories',async()=>{
    vi.mocked(uploads.cleanupUploadSessions).mockRejectedValueOnce(new Error('R2_DELETE_TRANSIENT'));
    await expect(handleQueueEvent(tick('UPLOADS'),env)).rejects.toThrow('R2_DELETE_TRANSIENT');
    expect((await db.prepare("SELECT status FROM event_receipts WHERE source_event_ref='maintenance:123:uploads'").first<any>()).status).toBe('FAILED');
    await handleQueueEvent(tick('ATTACHMENTS'),env);await handleQueueEvent(tick('UPLOADS'),env);
    expect(uploads.cleanupUploadSessions).toHaveBeenCalledTimes(2);expect(attachments.cleanupExpiredAttachments).toHaveBeenCalledTimes(1);
  });
  it('rejects a mismatched or invalid deterministic tick identity before executing cleanup',async()=>{
    await expect(handleQueueEvent({...tick('ATTACHMENTS'),eventId:'maintenance:123:learning'},env)).rejects.toThrow('INGRESS_PAYLOAD_INVALID');
    expect(attachments.cleanupExpiredAttachments).not.toHaveBeenCalled();expect(learning.runLearningMaintenance).not.toHaveBeenCalled();
  });
  it('retains safe maintenance DLQ identity with no conversation or raw task body',async()=>{
    const event=tick('UPLOADS');await captureDlqMessage(env,{id:'maintenance-dlq',body:event},123,'staging-dlq');
    expect(await db.prepare('SELECT event_type,source_event_ref,conversation_id FROM dlq_receipts').first()).toEqual({event_type:'maintenance_tick',source_event_ref:event.eventId,conversation_id:null});
  });
});
