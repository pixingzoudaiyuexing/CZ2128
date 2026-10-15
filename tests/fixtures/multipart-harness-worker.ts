import { Env } from '../../src/config/env';
import { handleUploadCapabilityRequest } from '../../src/uploads/handler';
import { handleUploadSession } from '../../src/uploads/sessions';
import { handleAttachmentProxy } from '../../src/attachments/proxy';
import { deriveUploadInviteToken, hashUploadCapability } from '../../src/uploads/capability';
import { handleQueueEvent } from '../../src/queue/consumer';
import type { SupportEvent } from '../../src/core/events';

// Only the upstream state adapter is replaced. D1, R2 and FixedLengthStream are real workerd bindings.
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if ((init?.method || 'GET') === 'GET' &&
      /^https:\/\/api\.crisp\.chat\/v1\/website\/harness-site\/conversation\/harness-[a-f0-9-]+\/state$/.test(url)) {
    return Response.json({ error: false, data: { state: 'unresolved' } });
  }
  throw new Error('HARNESS_EXTERNAL_NETWORK_DISABLED');
}) as typeof fetch;

function json(data: unknown, status = 200) { return Response.json(data, { status }); }

export default {
  async fetch(request: Request, bindings: Env): Promise<Response> {
    const env = { ...bindings, QUEUE: { send: async (event: any) => {
      if(event.type==='upload_task') {
        await bindings.DB.prepare('INSERT INTO harness_upload_tasks(event_id,body) VALUES(?,?) ON CONFLICT(event_id) DO NOTHING')
          .bind(event.eventId,JSON.stringify(event)).run();return;
      }
      await bindings.DB.prepare('INSERT INTO harness_dispatches(event_id,attachment_id) VALUES(?,?)')
        .bind(event.eventId, event.payload.attachmentId).run();
    } } as unknown as Env['QUEUE'] };
    const path = new URL(request.url).pathname;
    if (path === '/health') return json({ ok: true, runtime: 'real-local-D1-R2-FixedLengthStream' });
    if (path === '/seed' && request.method === 'POST') {
      await env.DB.prepare('CREATE TABLE IF NOT EXISTS harness_dispatches(id INTEGER PRIMARY KEY,event_id TEXT,attachment_id TEXT)').run();
      await env.DB.prepare('CREATE TABLE IF NOT EXISTS harness_upload_tasks(event_id TEXT PRIMARY KEY,body TEXT)').run();
      const id = crypto.randomUUID();
      const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM conversations').first<{ count: number }>();
      const threadRef = String(1000 + (count?.count || 0));
      const token = await deriveUploadInviteToken(env.UPLOAD_CAPABILITY_SECRET!, id);
      const now = Math.floor(Date.now() / 1000);
      await env.DB.prepare(`INSERT INTO conversations(id,helpdesk_provider,helpdesk_account_ref,helpdesk_conversation_ref,
        customer_ref,operator_channel,operator_thread_ref,created_at,updated_at)
        VALUES(?,'crisp','harness-site',?,'synthetic-local-visitor','telegram',?,?,?)`)
        .bind(id, 'harness-' + id, threadRef, now, now).run();
      await env.DB.prepare(`INSERT INTO upload_invites(id,token_hash,conversation_id,crisp_website_ref,crisp_session_ref,
        telegram_group_ref,telegram_thread_ref,support_profile_version,created_by_operator_ref,created_from_update_ref,
        status,expires_at,max_files,max_total_bytes,created_at,updated_at,transfer_version)
        VALUES(?,?,?,'harness-site',?,'-100123',?,0,'local-admin',?,'ACTIVE',?,3,1024,?,?,2)`)
        .bind(id, await hashUploadCapability(token), id, 'harness-' + id, threadRef, threadRef, now + 900, now, now).run();
      return json({ inviteId: id, token });
    }
    if(path==='/queue/drain'&&request.method==='POST') {
      const input=await request.json<{limit?:number}>();const limit=Math.min(20,Math.max(1,input.limit||1));let processed=0;
      for(let i=0;i<limit;i++) {
        const next=await env.DB.prepare('SELECT event_id,body FROM harness_upload_tasks ORDER BY rowid LIMIT 1').first<{event_id:string;body:string}>();
        if(!next)break;
        await handleQueueEvent(JSON.parse(next.body) as SupportEvent,env);
        await env.DB.prepare('DELETE FROM harness_upload_tasks WHERE event_id=?').bind(next.event_id).run();processed++;
      }
      return json({processed,pending:(await env.DB.prepare('SELECT COUNT(*) AS count FROM harness_upload_tasks').first<{count:number}>())?.count});
    }
    if (path === '/control' && request.method === 'POST') {
      const input = await request.json<{ inviteId: string; sessionId?: string; action: string; partSize?:number }>();
      if (input.action === 'expire-invite') {
        await env.DB.prepare("UPDATE upload_invites SET status='EXPIRED',expires_at=1 WHERE id=?").bind(input.inviteId).run();
      } else if (input.action === 'revoke-invite') {
        await env.DB.prepare("UPDATE upload_invites SET status='REVOKED',revoked_at=1 WHERE id=?").bind(input.inviteId).run();
      } else if (input.action === 'expire-session' && input.sessionId) {
        await env.DB.prepare('UPDATE attachment_upload_sessions SET expires_at=1 WHERE id=? AND invite_id=?')
          .bind(input.sessionId, input.inviteId).run();
      } else if(input.action==='logical-part-size' && input.sessionId && Number.isSafeInteger(input.partSize) && input.partSize!>=5*1024*1024){
        await env.DB.prepare('UPDATE attachment_upload_sessions SET part_size=?,part_count=1 WHERE id=? AND invite_id=? AND size_bytes<=?')
          .bind(input.partSize!,input.sessionId,input.inviteId,input.partSize!).run();
      } else return json({ error: 'CONTROL_INVALID' }, 400);
      return json({ ok: true });
    }
    if (path.startsWith('/snapshot/') && request.method === 'GET') {
      const sessionId = path.slice('/snapshot/'.length);
      const row = await env.DB.prepare(`SELECT a.status,a.transfer_version,a.size_bytes,a.stored_size_bytes,a.stored_at,
        a.retention_class,a.retention_expires_at,a.sha256,s.status AS session_status,s.verification_json,
        (SELECT COUNT(*) FROM attachment_upload_parts WHERE session_id=s.id AND status='STORED') AS stored_parts,
        (SELECT COUNT(*) FROM harness_dispatches WHERE attachment_id=a.id) AS dispatch_count
        FROM attachment_upload_sessions s JOIN attachments a ON a.id=s.attachment_id WHERE s.id=?`)
        .bind(sessionId).first();
      return json(row);
    }
    const invite = /^\/uploads\/([A-Za-z0-9_-]{43})(?:\/.*)?$/.exec(path);
    if (invite) return handleUploadCapabilityRequest(request, env, invite[1]);
    const session = /^\/upload-sessions\/([A-Za-z0-9_-]{43})(?:\/(.*))?$/.exec(path);
    if (session) return handleUploadSession(request, env, session[1], session[2] || '');
    const attachment = /^\/attachments\/([A-Za-z0-9_-]{43})\/(inline|download)$/.exec(path);
    if (attachment) return handleAttachmentProxy(request, env, attachment[1], attachment[2] as 'inline' | 'download');
    return json({ error: 'LOCAL_HARNESS_ROUTE_NOT_FOUND' }, 404);
  }
};
