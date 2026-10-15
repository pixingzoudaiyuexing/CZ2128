import type { Env } from '../config/env';
import type { UploadTaskEvent } from '../core/events';
import { RetryableProcessingError, SafeError } from '../core/errors';
import { getUploadInviteById } from './repository';
import { cleanupUploadSessions, dispatchStoredUpload, initializeQueuedUpload, uploadBoundConversation, verifyQueuedUpload, type UploadSession } from './sessions';
import { assembleQueuedUploadPart } from './subparts';

const now=()=>Math.floor(Date.now()/1000);
export function uploadTaskEvent(sessionId:string,phase:UploadTaskEvent['payload']['phase'],extra:Pick<UploadTaskEvent['payload'],'partNumber'|'offset'>={}):UploadTaskEvent {
  const suffix=phase==='ASSEMBLE'?`part:${extra.partNumber}`:phase==='VERIFY'?`verify:${extra.offset||0}`:phase.toLowerCase();
  return {version:1,source:'internal',type:'upload_task',eventId:`upload_task:${sessionId}:${suffix}`,payload:{sessionId,phase,...extra}};
}
export async function queueUploadTask(env:Env,sessionId:string,phase:UploadTaskEvent['payload']['phase'],extra:Pick<UploadTaskEvent['payload'],'partNumber'|'offset'>={}):Promise<void> {
  const event=uploadTaskEvent(sessionId,phase,extra);
  const exhausted=await env.DB.prepare(`SELECT 1 AS blocked FROM event_receipts WHERE source='internal' AND source_event_ref=?
    AND status='FAILED' AND attempt_count>=4`).bind(event.eventId).first();
  if(exhausted)return; // Automatic polling must not reset the Queue delivery budget.
  const due=now()+5;
  const claim=await env.DB.prepare(`UPDATE attachment_upload_sessions SET work_enqueue_after=?
    WHERE id=? AND work_enqueue_after<=?`).bind(due,sessionId,now()).run();
  if(claim.meta.changes!==1)return;
  try{await env.QUEUE.send(event);}catch(error){
    await env.DB.prepare('UPDATE attachment_upload_sessions SET work_enqueue_after=0 WHERE id=? AND work_enqueue_after=?').bind(sessionId,due).run();
    throw error;
  }
}
async function advance(env:Env,session:UploadSession):Promise<void> {
  // A committed phase transition may enqueue its distinct successor immediately.
  await env.DB.prepare('UPDATE attachment_upload_sessions SET work_enqueue_after=0 WHERE id=?').bind(session.id).run();
  await redriveUploadWork(env,session);
}
export async function redriveUploadWork(env:Env,session:UploadSession):Promise<void> {
  if(!session.async_mode || (session.lease_until||0)>now())return;
  if(session.status==='INITIALIZING')await queueUploadTask(env,session.id,'INIT');
  else if(session.status==='STORED')await queueUploadTask(env,session.id,'DISPATCH');
  else if(session.status==='ABORTING')await queueUploadTask(env,session.id,'ABORT');
  else if(['VERIFYING','COMPLETING'].includes(session.status)&&session.expected_sha256) {
    const offset=session.verification_json?JSON.parse(session.verification_json).offset:0;
    await queueUploadTask(env,session.id,'VERIFY',{offset});
  } else if(session.status==='UPLOADING') {
    const rows=await env.DB.prepare(`SELECT part_number FROM attachment_upload_parts WHERE session_id=? AND status='WRITING'
      AND lease_until<=? ORDER BY part_number LIMIT 20`).bind(session.id,now()).all<{part_number:number}>();
    for(const row of rows.results)await queueUploadTask(env,session.id,'ASSEMBLE',{partNumber:row.part_number});
  }
}
async function sessionById(env:Env,id:string):Promise<UploadSession|null> {
  return env.DB.prepare('SELECT * FROM attachment_upload_sessions WHERE id=?').bind(id).first<UploadSession>();
}
function retry(session:UploadSession):never {
  throw new RetryableProcessingError('QUEUE_EVENT_CLAIM_CONTENDED',Math.max(2,(session.lease_until||0)-now()));
}

/** Only Queue executes CPU-heavy initialization, assembly, inspection and abort cleanup. */
export async function processUploadTask(event:UploadTaskEvent,env:Env):Promise<void> {
  const {sessionId,phase,partNumber,offset}=event.payload;
  if(!/^[A-Za-z0-9_-]{1,80}$/.test(sessionId)||!['INIT','ASSEMBLE','VERIFY','ABORT','DISPATCH'].includes(phase)||
    phase==='ASSEMBLE'&&(!Number.isInteger(partNumber)||partNumber!<1||partNumber!>10000)||
    phase==='VERIFY'&&(!Number.isSafeInteger(offset)||offset!<0)||
    uploadTaskEvent(sessionId,phase,{...(partNumber!==undefined?{partNumber}:{}),...(offset!==undefined?{offset}:{})}).eventId!==event.eventId) {
    throw new SafeError('INGRESS_PAYLOAD_INVALID');
  }
  let session=await sessionById(env,sessionId);if(!session||!session.async_mode)return;
  const invite=await getUploadInviteById(env,session.invite_id);
  if(!invite)return;
  const accepted=await env.DB.prepare('SELECT stored_at FROM attachments WHERE id=?').bind(session.attachment_id).first<{stored_at:number|null}>();
  if(accepted?.stored_at) {
    if((phase==='VERIFY'||phase==='DISPATCH')&&['STORED','QUEUED'].includes(session.status))await dispatchStoredUpload(env,session);
    return;
  }
  if(phase!=='ABORT'&&(session.expires_at<=now()||invite.status==='REVOKED'||!await uploadBoundConversation(env,invite))) {
    await env.DB.prepare(`UPDATE attachment_upload_sessions SET status='ABORTING',lease_until=0,updated_at=?
      WHERE id=? AND status NOT IN ('STORED','QUEUED','DELIVERED','AMBIGUOUS','ABORTED')`).bind(now(),session.id).run();
    await advance(env,(await sessionById(env,sessionId))!);return;
  }
  try {
    if(phase==='INIT') {
      if(session.status!=='INITIALIZING')return;
      await initializeQueuedUpload(env,session);
      session=(await sessionById(env,sessionId))!;if(session.status==='INITIALIZING')retry(session);
      await advance(env,session);
    } else if(phase==='ASSEMBLE') {
      if(session.status!=='UPLOADING')return;
      const response=await assembleQueuedUploadPart(env,session,partNumber!);
      if(response.status===410) {
        await env.DB.prepare("UPDATE attachment_upload_sessions SET status='ABORTING',lease_until=0 WHERE id=? AND status='UPLOADING'").bind(sessionId).run();
        await advance(env,(await sessionById(env,sessionId))!);return;
      }
      if(!response.ok)throw new RetryableProcessingError('R2_STORE_TRANSIENT',5);
      const stored=await env.DB.prepare(`SELECT status,lease_until FROM attachment_upload_parts WHERE session_id=? AND part_number=?`)
        .bind(sessionId,partNumber!).first<{status:string;lease_until:number}>();
      if(stored?.status!=='STORED')retry(session);
      await advance(env,(await sessionById(env,sessionId))!);
    } else if(phase==='VERIFY') {
      if(!['VERIFYING','COMPLETING'].includes(session.status)||!session.expected_sha256)return;
      const currentOffset=session.verification_json?JSON.parse(session.verification_json).offset:0;
      if(offset!==currentOffset) {if(offset!<currentOffset){await redriveUploadWork(env,session);return;}throw new SafeError('INGRESS_PAYLOAD_INVALID');}
      if((session.lease_until||0)>now())retry(session);
      const response=await verifyQueuedUpload(env,session);
      session=(await sessionById(env,sessionId))!;
      if(!response.ok) {
        if(response.status===410) {
          await env.DB.prepare(`UPDATE attachment_upload_sessions SET status='ABORTING',lease_until=0 WHERE id=?
            AND NOT EXISTS(SELECT 1 FROM attachments WHERE id=attachment_id AND stored_at IS NOT NULL)`)
            .bind(sessionId).run();
          await advance(env,(await sessionById(env,sessionId))!);return;
        }
        if(session.status==='ABORTING'){await advance(env,session);return;}
        throw new RetryableProcessingError('R2_READ_TRANSIENT',5);
      }
      await advance(env,session);
    } else {
      if(session.status!=='ABORTING')return;
      await cleanupUploadSessions(env,sessionId);
      session=(await sessionById(env,sessionId))!;if(session.status!=='ABORTED')retry(session);
    }
    await env.DB.prepare("UPDATE attachment_upload_sessions SET last_error=NULL WHERE id=? AND last_error='UPLOAD_ASYNC_RETRY'").bind(sessionId).run();
  } catch(error) {
    await env.DB.prepare(`UPDATE attachment_upload_sessions SET last_error=CASE WHEN
      (SELECT attempt_count FROM event_receipts WHERE source='internal' AND source_event_ref=?)>=4
      THEN 'UPLOAD_ASYNC_RETRY_EXHAUSTED' ELSE 'UPLOAD_ASYNC_RETRY' END WHERE id=?`).bind(event.eventId,sessionId).run();
    throw error;
  }
}
