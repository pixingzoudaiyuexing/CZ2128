import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { SqliteD1 } from './helpers/sqlite-d1';
import { handleUploadCapabilityRequest } from '../src/uploads/handler';
import { handleUploadSession, cleanupUploadSessions } from '../src/uploads/sessions';
import { deriveUploadInviteToken, hashUploadCapability } from '../src/uploads/capability';
import { handleAttachmentProxy } from '../src/attachments/proxy';
import { revokeActiveUploadInvite } from '../src/uploads/repository';

class Bucket {
  uploads=new Map<string,{key:string;parts:Map<number,Uint8Array>}>(); objects=new Map<string,Uint8Array>();
  failDelete=false; failAbort=false;
  async createMultipartUpload(key:string) {const id=crypto.randomUUID();this.uploads.set(id,{key,parts:new Map()});return this.resumeMultipartUpload(key,id);}
  resumeMultipartUpload(key:string,id:string) {
    return {key,uploadId:id,uploadPart:async(n:number,body:ReadableStream<Uint8Array>|Uint8Array)=>{
      const bytes=body instanceof Uint8Array?body:new Uint8Array(await new Response(body).arrayBuffer());
      if(!this.uploads.has(id))throw new Error('NoSuchUpload');this.uploads.get(id)!.parts.set(n,bytes);
      return {partNumber:n,etag:createHash('md5').update(bytes).digest('hex')};
    },complete:async(list:Array<{partNumber:number;etag:string}>)=>{
      const upload=this.uploads.get(id);if(!upload)throw new Error('NoSuchUpload');
      const data=list.map(p=>upload.parts.get(p.partNumber)!);const merged=new Uint8Array(data.reduce((n,b)=>n+b.length,0));
      let offset=0;for(const bytes of data){merged.set(bytes,offset);offset+=bytes.length;}this.objects.set(key,merged);this.uploads.delete(id);
      return {key,size:merged.length};
    },abort:async()=>{if(this.failAbort)throw new Error('transient');this.uploads.delete(id);}};
  }
  async head(key:string){const value=this.objects.get(key);return value?{size:value.length}:null;}
  async get(key:string,options?:any){const full=this.objects.get(key);if(!full)return null;const bytes=options?.range?full.slice(options.range.offset,options.range.offset+options.range.length):full;
    return {size:full.length,body:new Blob([Uint8Array.from(bytes).buffer]).stream(),arrayBuffer:()=>{throw new Error('WHOLE_BUFFER_FORBIDDEN');}};}
  async delete(key:string){if(this.failDelete)throw new Error('transient');this.objects.delete(key);}
}
const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
describe('authenticated resumable multipart upload entry and durable storage',()=>{
  let db:SqliteD1;let bucket:Bucket;let env:any;let token:string;let queue:any[];
  beforeEach(async()=>{
    db=new SqliteD1();db.migrate();bucket=new Bucket();queue=[];
    const secret='A'.repeat(43);token=await deriveUploadInviteToken(secret,'invite');const now=Math.floor(Date.now()/1000);
    db.exec("INSERT INTO conversations(id,helpdesk_provider,helpdesk_account_ref,helpdesk_conversation_ref,customer_ref,operator_channel,operator_thread_ref,created_at,updated_at) VALUES('conv','crisp','site','session','synthetic','telegram','703',1,1)");
    await db.prepare(`INSERT INTO upload_invites(id,token_hash,conversation_id,crisp_website_ref,crisp_session_ref,telegram_group_ref,telegram_thread_ref,support_profile_version,created_by_operator_ref,created_from_update_ref,status,expires_at,max_files,max_total_bytes,created_at,updated_at,transfer_version)
      VALUES('invite',?,'conv','site','session','-100','703',0,'1','1','ACTIVE',?,3,1024,?,?,2)`)
      .bind(await hashUploadCapability(token),now+900,now,now).run();
    env={DB:db,ATTACHMENTS_BUCKET:bucket,QUEUE:{send:async(event:any)=>{queue.push(event);}},UPLOAD_CAPABILITY_SECRET:secret,
      PUBLIC_ORIGIN:'https://cz2128.482658.xyz',BOT_GROUP_ID:'-100',CRISP_API_IDENTIFIER:'fake-id',CRISP_API_KEY:'fake-key'};
    vi.spyOn(globalThis,'fetch').mockImplementation(async()=>Response.json({data:{state:'unresolved'}}));
    class Fixed {
      readable:ReadableStream<Uint8Array>;writable:WritableStream<Uint8Array>;
      constructor(length:number){let bytes=0;const stream=new TransformStream<Uint8Array,Uint8Array>({transform(chunk,controller){bytes+=chunk.length;if(bytes>length)throw new Error('length');controller.enqueue(chunk);},flush(){if(bytes!==length)throw new Error('length');}});this.readable=stream.readable;this.writable=stream.writable;}
    }
    vi.stubGlobal('FixedLengthStream',Fixed);
  });
  afterEach(()=>{db.close();vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers();});
  const post=(path:string,input:any)=>new Request(`https://attacker.example${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
  async function init(bytes:Uint8Array,id=crypto.randomUUID()) {
    const response=await handleUploadCapabilityRequest(post(`/uploads/${token}/sessions`,{id,filename:'sample.bin',sizeBytes:bytes.length,mimeType:'image/png'}),env,token);
    expect(response.status).toBe(200);return response.json() as Promise<any>;
  }
  async function put(session:any,bytes:Uint8Array,n=1,hash=digest(bytes)) {
    const request=new Request(`https://attacker.example/upload-sessions/${session.token}/parts/${n}`,{method:'PUT',headers:{'Content-Length':String(bytes.length),'X-Part-SHA256':hash},body:Uint8Array.from(bytes).buffer});
    return handleUploadSession(request,env,session.token,`parts/${n}`);
  }
  const finish=(session:any,bytes:Uint8Array)=>handleUploadSession(post(`/upload-sessions/${session.token}/complete`,{sha256:digest(bytes)}),env,session.token,'complete');

  it('stores a real 32 MiB file beyond old size constraints in four verified parts and uses trusted domain',async()=>{
    const bytes=new Uint8Array(32*1024*1024);for(let i=0;i<bytes.length;i++)bytes[i]=i%251;
    const session=await init(bytes);expect(session.partCount).toBe(4);
    for(let n=1;n<=4;n++)expect((await put(session,bytes.subarray((n-1)*session.partSize,n*session.partSize),n)).status).toBe(200);
    const completed=await finish(session,bytes);expect(completed.status).toBe(202);
    const data:any=await completed.json();expect(data.state).toBe('QUEUED');expect(data.attachment.sha256).toBe(digest(bytes));
    expect(data.attachment.url).toMatch(/^https:\/\/cz2128\.482658\.xyz\/attachments\//);expect(data.attachment.url).not.toContain('attacker');
    const row=await db.prepare('SELECT * FROM attachments').first<any>();expect(row.size_bytes).toBeNull();expect(row.stored_size_bytes).toBe(bytes.length);
    expect(row.retention_class).toBe('FILE');expect(row.retention_expires_at-row.stored_at).toBe(72*3600);expect(queue).toHaveLength(1);
    const range=await handleAttachmentProxy(new Request(data.attachment.url,{headers:{Range:'bytes=1024-2047'}}),env,data.attachment.url.split('/')[4]);
    expect(range.status).toBe(206);expect(new Uint8Array(await range.arrayBuffer())).toEqual(bytes.slice(1024,2048));
  });

  it('opens the same capability page with a trailing slash and exposes no routing identity',async()=>{
    const page=await handleUploadCapabilityRequest(new Request(`https://example/uploads/${token}/`),env,token);
    expect(page.status).toBe(200);expect(page.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(await page.text()).toContain('分片');
  });

  it('rejects wrong checksums, persists immutable part identity, and resumes the same session',async()=>{
    const bytes=new TextEncoder().encode('ordinary reliable upload');const session=await init(bytes);
    expect((await put(session,bytes,1,'0'.repeat(64))).status).toBe(422);
    // The original advertised fingerprint is immutable; start a new session after a wrong manifest.
    expect((await put(session,bytes)).status).toBe(409);
    const retry=await init(bytes);expect((await put(retry,bytes)).status).toBe(200);expect((await put(retry,bytes)).status).toBe(200);
    const current:any=await (await handleUploadSession(new Request('https://example/session'),env,retry.token,'')).json();expect(current.parts).toHaveLength(1);
    expect(current.parts[0].sha256).toBe(digest(bytes));expect((await finish(retry,bytes)).status).toBe(202);
  });

  it('retains session authority after invite expiry while rejecting new sessions and revoked unfinished uploads',async()=>{
    const bytes=new TextEncoder().encode('resume independently');const session=await init(bytes);
    db.exec("UPDATE upload_invites SET expires_at=1 WHERE id='invite'");
    expect((await put(session,bytes)).status).toBe(200);expect((await finish(session,bytes)).status).toBe(202);
    const fresh=await handleUploadCapabilityRequest(post(`/uploads/${token}/sessions`,{id:crypto.randomUUID(),filename:'later',sizeBytes:1}),env,token);expect(fresh.status).toBe(410);
    db.exec("UPDATE upload_invites SET status='ACTIVE',expires_at=9999999999 WHERE id='invite'");const pending=await init(bytes);
    db.exec("UPDATE upload_invites SET status='REVOKED' WHERE id='invite'");expect((await put(pending,bytes)).status).toBe(410);
    await cleanupUploadSessions(env);expect((await db.prepare('SELECT status FROM attachment_upload_sessions WHERE id=?').bind(pending.sessionId).first<any>()).status).toBe('ABORTED');
    const stored:any=await (await handleUploadSession(new Request('https://example/session'),env,session.token,'')).json();expect(stored.attachment.url).toBeTruthy();
  });

  it('accepts continuous files without the legacy three-file or 1 KiB invitation quota',async()=>{
    for(let i=0;i<5;i++){const bytes=new Uint8Array(2048).fill(i);const session=await init(bytes);expect((await put(session,bytes)).status).toBe(200);expect((await finish(session,bytes)).status).toBe(202);}
    expect(queue).toHaveLength(5);expect((await db.prepare('SELECT COUNT(*) AS count FROM attachments WHERE stored_at IS NOT NULL').first<any>()).count).toBe(5);
  });

  it('blocks completion with missing parts, rejects metadata reuse and has honest queue delivery state',async()=>{
    const bytes=new Uint8Array(3);const id=crypto.randomUUID();const session=await init(bytes,id);
    expect((await finish(session,bytes)).status).toBe(409);
    const conflict=await handleUploadCapabilityRequest(post(`/uploads/${token}/sessions`,{id,filename:'different',sizeBytes:3}),env,token);expect(conflict.status).toBe(409);
    expect((await put(session,bytes)).status).toBe(200);const result:any=await (await finish(session,bytes)).json();expect(result.state).toBe('QUEUED');
    expect(result.state).not.toBe('DELIVERED');const before=await db.prepare('SELECT stored_at,retention_expires_at FROM attachments').first();
    await finish(session,bytes);expect(await db.prepare('SELECT stored_at,retention_expires_at FROM attachments').first()).toEqual(before);
    expect((await handleUploadSession(new Request('https://example/session'),env,'Z'.repeat(43),'')).status).toBe(404);
  });

  it('revokes an expired invite with an independently active upload session',async()=>{
    const bytes=new Uint8Array(3);const session=await init(bytes);
    db.exec("UPDATE upload_invites SET status='EXPIRED',expires_at=1 WHERE id='invite'");
    expect(await revokeActiveUploadInvite(env,'conv')).toBe(1);
    expect((await put(session,bytes)).status).toBe(410);
  });

  it('reports abort cleanup pending on an R2 failure and preserves its retry identity',async()=>{
    const session=await init(new Uint8Array(3));bucket.failAbort=true;
    const response=await handleUploadSession(new Request('https://example/session',{method:'DELETE'}),env,session.token,'');
    expect(await response.json()).toEqual({state:'ABORTING'});
    const row=await db.prepare('SELECT r2_upload_id,last_error,lease_until FROM attachment_upload_sessions').first<any>();
    expect(row.r2_upload_id).toBeTruthy();expect(row.last_error).toBe('R2_ABORT_RETRY');
    bucket.failAbort=false;db.exec('UPDATE attachment_upload_sessions SET lease_until=0');await cleanupUploadSessions(env);
    expect((await db.prepare('SELECT status FROM attachment_upload_sessions').first<any>()).status).toBe('ABORTED');
  });

  it('bounds actual metadata bytes even without a Content-Length header',async()=>{
    const response=await handleUploadCapabilityRequest(post(`/uploads/${token}/sessions`,{id:crypto.randomUUID(),filename:'x'.repeat(20000),sizeBytes:3}),env,token);
    expect(response.status).toBe(400);expect(bucket.uploads.size).toBe(0);
  });

  it('does not let 30 delivered sessions starve a later durable Queue gap',async()=>{
    const bytes=new Uint8Array(3);const original=await init(bytes);await put(original,bytes);await finish(original,bytes);
    const a=await db.prepare('SELECT * FROM attachments').first<any>();const s=await db.prepare('SELECT * FROM attachment_upload_sessions').first<any>();
    for(let i=0;i<30;i++){
      const cloned={...a,id:`old-${i}`,source_attachment_ref:`old-source-${i}`,storage_key:`attachments-v2/old-${i}`,access_token_hash:`old-hash-${i}`,status:'DELIVERED'};
      const keys=Object.keys(cloned);await db.prepare(`INSERT INTO attachments(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).bind(...keys.map(k=>cloned[k])).run();
      const cs={...s,id:`old-session-${i}`,attachment_id:cloned.id,token_hash:`session-hash-${i}`,status:'QUEUED',updated_at:1};const sk=Object.keys(cs);
      await db.prepare(`INSERT INTO attachment_upload_sessions(${sk.join(',')}) VALUES(${sk.map(()=>'?').join(',')})`).bind(...sk.map(k=>cs[k])).run();
    }
    db.exec("UPDATE attachment_upload_sessions SET updated_at=2 WHERE id NOT LIKE 'old-session-%'");queue.length=0;
    await cleanupUploadSessions(env);expect(queue).toHaveLength(1);expect(queue[0].payload.attachmentId).toBe(a.id);
    expect((await db.prepare("SELECT COUNT(*) AS count FROM attachment_upload_sessions WHERE status='DELIVERED'").first<any>()).count).toBe(30);
  });

  it('preserves authorized stored downloads while honestly showing final forwarding failure',async()=>{
    const bytes=new TextEncoder().encode('stored but provider rejected');const session=await init(bytes);await put(session,bytes);await finish(session,bytes);
    db.exec("UPDATE attachments SET status='FAILED_FINAL',last_error='ATTACHMENT_DELIVERY_FINAL'");
    const result:any=await(await handleUploadSession(new Request('https://example/session'),env,session.token,'')).json();
    expect(result.state).toBe('FAILED');expect(result.attachment.state).toBe('FAILED');
    const url=result.attachment.url;const response=await handleAttachmentProxy(new Request(url),env,url.split('/')[4]);
    expect(response.status).toBe(200);expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    queue.length=0;await finish(session,bytes);expect(queue).toHaveLength(0);
  });

  it('keeps one immutable manifest when conflicting initial requests race',async()=>{
    const id=crypto.randomUUID();const requests=[{id,filename:'first.bin',sizeBytes:3},{id,filename:'other.bin',sizeBytes:9}];
    const responses=await Promise.all(requests.map(input=>handleUploadCapabilityRequest(post(`/uploads/${token}/sessions`,input),env,token)));
    expect(responses.map(r=>r.status).sort()).toEqual([200,409]);
    const row=await db.prepare('SELECT a.declared_size_bytes,s.size_bytes,a.original_filename FROM attachment_upload_sessions s JOIN attachments a ON a.id=s.attachment_id').first<any>();
    expect(row.declared_size_bytes).toBe(row.size_bytes);expect(row.original_filename).toBe('first.bin');
  });

  it('recovers an initializing session using its own authority after the invitation expires',async()=>{
    const session=await init(new Uint8Array(3));
    db.exec("UPDATE attachment_upload_sessions SET status='INITIALIZING',r2_upload_id=NULL,lease_until=0");
    db.exec("UPDATE upload_invites SET status='EXPIRED',expires_at=1");
    const current:any=await(await handleUploadSession(new Request('https://example/session'),env,session.token,'')).json();
    expect(current.state).toBe('UPLOADING');
    expect((await db.prepare('SELECT r2_upload_id FROM attachment_upload_sessions').first<any>()).r2_upload_id).toBeTruthy();
  });

  it('enforces token expiry and revocation separately from stored file retention',async()=>{
    const bytes=new Uint8Array(3);const session=await init(bytes);await put(session,bytes);const complete:any=await(await finish(session,bytes)).json();
    const url=complete.attachment.url;const grantToken=url.split('/')[4];
    db.exec('UPDATE attachment_access_grants SET expires_at=1');
    expect((await handleAttachmentProxy(new Request(url),env,grantToken)).status).toBe(404);
    const newer:any=await(await handleUploadSession(new Request('https://example/session'),env,session.token,'')).json();
    expect(newer.attachment.url).not.toBe(url);expect((await handleAttachmentProxy(new Request(newer.attachment.url),env,newer.attachment.url.split('/')[4])).status).toBe(200);
    db.exec('UPDATE attachment_access_grants SET revoked_at=1');
    expect((await handleAttachmentProxy(new Request(newer.attachment.url),env,newer.attachment.url.split('/')[4])).status).toBe(404);
    expect((await db.prepare('SELECT retention_expires_at>unixepoch() AS valid FROM attachments').first<any>()).valid).toBe(1);
  });
});
