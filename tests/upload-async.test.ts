import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { SqliteD1 } from './helpers/sqlite-d1';
import { TestFixedLengthStream } from './fixtures/fixed-length-stream';
import { handleUploadCapabilityRequest } from '../src/uploads/handler';
import { handleUploadSession,cleanupUploadSessions } from '../src/uploads/sessions';
import { deriveUploadInviteToken, hashUploadCapability } from '../src/uploads/capability';
import { handleQueueEvent } from '../src/queue/consumer';
import { captureDlqMessage } from '../src/queue/dlq-consumer';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
class Bucket {
  objects = new Map<string, Uint8Array>(); uploads = new Map<string, {key: string; parts: Map<number, Uint8Array>}>();
  creates = 0; assemblies = 0; nativeHashes: string[] = []; failDelete = false;
  async createMultipartUpload(key: string) { this.creates++; const id = randomUUID(); this.uploads.set(id, {key, parts:new Map()}); return this.resumeMultipartUpload(key,id); }
  resumeMultipartUpload(key: string, id: string) { return {key, uploadId:id,
    uploadPart: async (number: number, body: ReadableStream<Uint8Array>) => { const data = new Uint8Array(await new Response(body).arrayBuffer()); this.assemblies++; this.uploads.get(id)!.parts.set(number,data); return {partNumber:number,etag:sha(data)}; },
    complete: async (parts: Array<{partNumber:number}>) => { const upload = this.uploads.get(id)!; const values = parts.map(p=>upload.parts.get(p.partNumber)!); const bytes = new Uint8Array(values.reduce((n,v)=>n+v.length,0)); let offset=0;for(const value of values){bytes.set(value,offset);offset+=value.length;}this.objects.set(key,bytes);this.uploads.delete(id);return {key,size:bytes.length}; },
    abort: async () => {this.uploads.delete(id);} }; }
  async put(key: string, body: ReadableStream<Uint8Array>, options: any) { const bytes = new Uint8Array(await new Response(body).arrayBuffer());this.nativeHashes.push(options?.sha256);if(options?.sha256 !== sha(bytes))throw new Error('R2_NATIVE_CHECKSUM_MISMATCH');this.objects.set(key,bytes);return {key,size:bytes.length,etag:sha(bytes)}; }
  async head(key: string) {const bytes=this.objects.get(key);return bytes?{key,size:bytes.length}:null;}
  async get(key: string, options?: any) {const full=this.objects.get(key);if(!full)return null;const bytes=options?.range?full.subarray(options.range.offset,options.range.offset+options.range.length):full;return {key,size:full.length,body:new Blob([Uint8Array.from(bytes).buffer]).stream()};}
  async delete(key: string){if(this.failDelete)throw new Error('R2_DELETE');this.objects.delete(key);}
}
const post = (path: string, body: any) => new Request('https://custom.example'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});

describe('free HTTP upload uses native checksums and durable queue work',()=>{
  let db:SqliteD1;let bucket:Bucket;let env:any;let token:string;let jobs:any[];
  beforeEach(async()=>{
    db=new SqliteD1();db.migrate();bucket=new Bucket();jobs=[];const now=Math.floor(Date.now()/1000);
    token=await deriveUploadInviteToken('A'.repeat(43),'invite');
    db.exec("INSERT INTO conversations(id,helpdesk_provider,helpdesk_account_ref,helpdesk_conversation_ref,customer_ref,operator_channel,operator_thread_ref,created_at,updated_at) VALUES('conv','crisp','site','session','synthetic','telegram','703',1,1)");
    await db.prepare(`INSERT INTO upload_invites(id,token_hash,conversation_id,crisp_website_ref,crisp_session_ref,telegram_group_ref,telegram_thread_ref,support_profile_version,created_by_operator_ref,created_from_update_ref,status,expires_at,max_files,max_total_bytes,created_at,updated_at,transfer_version) VALUES('invite',?,'conv','site','session','-100','703',0,'admin','1','ACTIVE',?,3,1024,?,?,2)`).bind(await hashUploadCapability(token),now+900,now,now).run();
    env={DB:db,ATTACHMENTS_BUCKET:bucket,QUEUE:{send:async(event:any)=>{jobs.push(event);}},UPLOAD_CAPABILITY_SECRET:'A'.repeat(43),PUBLIC_ORIGIN:'https://custom.example',BOT_GROUP_ID:'-100',CRISP_API_IDENTIFIER:'fake',CRISP_API_KEY:'fake'};
    vi.spyOn(globalThis,'fetch').mockImplementation(async()=>Response.json({data:{state:'unresolved'}}));vi.stubGlobal('FixedLengthStream',TestFixedLengthStream);
  });
  afterEach(()=>{db.close();vi.restoreAllMocks();vi.unstubAllGlobals();});
  async function init(bytes:Uint8Array){const response=await handleUploadCapabilityRequest(post('/uploads/'+token+'/sessions',{id:randomUUID(),filename:'sample.bin',sizeBytes:bytes.length,async:true}),env,token);expect(response.status).toBe(202);return response.json() as Promise<any>;}
  const status = async (session:any) => (await handleUploadSession(new Request('https://custom.example/upload-sessions/'+session.token),env,session.token,'')).json() as Promise<any>;
  async function run(phase:string){const index=jobs.findIndex(j=>j.type==='upload_task'&&j.payload.phase===phase);expect(index).toBeGreaterThanOrEqual(0);const event=jobs.splice(index,1)[0];await handleQueueEvent(event,env);return event;}
  async function chunk(session:any,bytes:Uint8Array,hash=sha(bytes)){return handleUploadSession(new Request('https://custom.example/chunk',{method:'PUT',headers:{'Content-Length':String(bytes.length),'X-Part-SHA256':hash},body:Uint8Array.from(bytes).buffer}),env,session.token,'parts/1/chunks/1');}
  async function assemble(session:any,bytes:Uint8Array){return handleUploadSession(post('/assemble',{sha256:sha(bytes)}),env,session.token,'parts/1/assemble');}
  async function complete(session:any,bytes:Uint8Array){return handleUploadSession(post('/complete',{sha256:sha(bytes)}),env,session.token,'complete');}

  it('returns INITIALIZING without creating the MPU in HTTP and converges duplicate INIT jobs',async()=>{
    const session=await init(new Uint8Array(31));expect(session).toMatchObject({async:true,state:'INITIALIZING',networkChunkSize:8388608});expect(bucket.creates).toBe(0);
    const event=await run('INIT');expect(bucket.creates).toBe(1);await handleQueueEvent(event,env);expect(bucket.creates).toBe(1);expect((await status(session)).state).toBe('UPLOADING');
    expect(JSON.stringify(event)).not.toMatch(/token|https:|body|fake/);
  });
  it('checks network chunks natively, queues assembly and verification, and admits only verified whole bytes',async()=>{
    const bytes=new Uint8Array(257).fill(71),session=await init(bytes);await run('INIT');
    expect((await chunk(session,bytes)).status).toBe(200);expect(bucket.nativeHashes).toEqual([sha(bytes)]);expect(bucket.assemblies).toBe(0);
    expect((await assemble(session,bytes)).status).toBe(202);expect((await status(session)).pendingParts).toEqual([{number:1,sizeBytes:bytes.length,sha256:sha(bytes),state:'ASSEMBLING'}]);expect(bucket.assemblies).toBe(0);
    await run('ASSEMBLE');expect(bucket.assemblies).toBe(1);expect((await status(session)).parts).toHaveLength(1);
    expect((await complete(session,bytes)).status).toBe(202);expect((await db.prepare('SELECT stored_at FROM attachments').first<any>()).stored_at).toBeNull();
    await run('VERIFY');const current=await status(session);expect(current.attachment.sha256).toBe(sha(bytes));expect(current.state).toBe('QUEUED');
    const row=await db.prepare('SELECT stored_at,retention_expires_at FROM attachments').first<any>();expect(row.retention_expires_at-row.stored_at).toBe(259200);
    expect(jobs.filter(j=>j.type==='attachment_transfer')).toHaveLength(1);
  });
  it('rejects native checksum corruption without marking a chunk stored or permitting assembly',async()=>{
    const bytes=new Uint8Array(33).fill(2),session=await init(bytes);await run('INIT');expect((await chunk(session,bytes,'0'.repeat(64))).status).toBe(422);
    expect((await status(session)).chunks).toEqual([]);expect((await assemble(session,bytes)).status).toBe(409);expect(bucket.assemblies).toBe(0);
  });
  it('redrives an INIT queue gap from durable state without creating an MPU in HTTP',async()=>{
    const session=await init(new Uint8Array(31));jobs=[];
    vi.spyOn(Date,'now').mockReturnValue(Date.now()+6000);await status(session);expect(jobs).toHaveLength(1);expect(bucket.creates).toBe(0);await run('INIT');expect((await status(session)).state).toBe('UPLOADING');
  });
  it('does not assemble or admit after invitation revocation and queues abort work instead of cleaning in HTTP',async()=>{
    const bytes=new Uint8Array(31),session=await init(bytes);await run('INIT');await chunk(session,bytes);await assemble(session,bytes);db.exec("UPDATE upload_invites SET status='REVOKED'");
    await run('ASSEMBLE');expect(bucket.assemblies).toBe(0);expect((await db.prepare('SELECT stored_at FROM attachments').first<any>()).stored_at).toBeNull();
  });
  it('DELETE persists ABORTING and lets the queue delete bytes before retiring metadata',async()=>{
    const bytes=new Uint8Array(31),session=await init(bytes);await run('INIT');await chunk(session,bytes);expect(bucket.objects.size).toBe(1);
    const result=await handleUploadSession(new Request('https://custom.example/delete',{method:'DELETE'}),env,session.token,'');expect(await result.json()).toEqual({state:'ABORTING'});expect(bucket.objects.size).toBe(1);
    await run('ABORT');expect(bucket.objects.size).toBe(0);expect((await status(session)).state).toBe('ABORTED');
  });
  it('records async task DLQ identity without retaining payloads or capability material',async()=>{
    const session=await init(new Uint8Array(31));const event=jobs[0];await captureDlqMessage(env,{id:'dlq-msg',body:event},123,'staging-dlq');const row=await db.prepare('SELECT event_type,conversation_id,source_event_ref FROM dlq_receipts').first<any>();expect(row).toEqual({event_type:'upload_task',conversation_id:'conv',source_event_ref:event.eventId});expect(session.token).toHaveLength(43);
  });
  it('limits repeated GET redrive to one durable enqueue per five-second window',async()=>{
    const session=await init(new Uint8Array(31));jobs=[];for(let i=0;i<10;i++)await status(session);expect(jobs).toHaveLength(0);
    const clock=vi.spyOn(Date,'now').mockReturnValue(Date.now()+6000);for(let i=0;i<10;i++)await status(session);expect(jobs).toHaveLength(1);
    clock.mockReturnValue(Date.now()+6000);await status(session);expect(jobs).toHaveLength(2);
  });
  it('does not reset exhausted task retry budgets when clients continue polling',async()=>{
    const session=await init(new Uint8Array(31));const event=jobs[0];jobs=[];
    await db.prepare("INSERT INTO event_receipts(source,source_event_ref,status,attempt_count) VALUES('internal',?,'FAILED',4)").bind(event.eventId).run();
    vi.spyOn(Date,'now').mockReturnValue(Date.now()+6000);await status(session);expect(jobs).toHaveLength(0);
  });
  it('does not initialize or assemble if Crisp has closed after the durable intent was accepted',async()=>{
    const session=await init(new Uint8Array(31));vi.mocked(fetch).mockResolvedValue(Response.json({data:{state:'resolved'}}));await run('INIT');expect(bucket.creates).toBe(0);expect((await db.prepare('SELECT stored_at FROM attachments').first<any>()).stored_at).toBeNull();expect(jobs.some(j=>j.payload.phase==='ABORT')).toBe(true);
  });
  it('keeps abort retry metadata when physical deletion fails, then finishes only after a successful retry',async()=>{
    const bytes=new Uint8Array(31),session=await init(bytes);await run('INIT');await chunk(session,bytes);bucket.failDelete=true;
    await handleUploadSession(new Request('https://custom.example/delete',{method:'DELETE'}),env,session.token,'');
    const abort=jobs.find(j=>j.payload.phase==='ABORT');await expect(handleQueueEvent(abort,env)).rejects.toThrow();
    expect((await db.prepare('SELECT status FROM attachment_upload_sessions').first<any>()).status).toBe('ABORTING');expect(bucket.objects.size).toBe(1);
    bucket.failDelete=false;vi.spyOn(Date,'now').mockReturnValue(Date.now()+61000);await handleQueueEvent(abort,env);
    expect((await db.prepare('SELECT status FROM attachment_upload_sessions').first<any>()).status).toBe('ABORTED');expect(bucket.objects.size).toBe(0);
  });
  it('preserves expected whole-file identity and denies a conflicting completion request',async()=>{
    const bytes=new Uint8Array(31),session=await init(bytes);await run('INIT');await chunk(session,bytes);await assemble(session,bytes);await run('ASSEMBLE');await complete(session,bytes);
    const response=await handleUploadSession(post('/complete',{sha256:'0'.repeat(64)}),env,session.token,'complete');expect(response.status).toBe(409);
    await run('VERIFY');expect((await status(session)).attachment.sha256).toBe(sha(bytes));
  });
  it('recovers a Queue dispatch failure after verified admission without rehashing or resetting retention',async()=>{
    const bytes=new Uint8Array(31),session=await init(bytes);await run('INIT');await chunk(session,bytes);await assemble(session,bytes);await run('ASSEMBLE');await complete(session,bytes);
    const verify=jobs.find(j=>j.payload.phase==='VERIFY');const send=env.QUEUE.send;
    env.QUEUE.send=async(event:any)=>{if(event.type==='attachment_transfer')throw new Error('QUEUE_TRANSIENT');await send(event);};
    await expect(handleQueueEvent(verify,env)).rejects.toThrow();const before=await db.prepare('SELECT stored_at,retention_expires_at FROM attachments').first();
    env.QUEUE.send=send;await handleQueueEvent(verify,env);expect(jobs.filter(j=>j.type==='attachment_transfer')).toHaveLength(1);
    expect((await status(session)).state).toBe('QUEUED');expect(await db.prepare('SELECT stored_at,retention_expires_at FROM attachments').first()).toEqual(before);
  });
  it('never admits a different whole-file digest and durably schedules physical abort',async()=>{
    const bytes=new Uint8Array(31),session=await init(bytes);await run('INIT');await chunk(session,bytes);await assemble(session,bytes);await run('ASSEMBLE');
    await handleUploadSession(post('/complete',{sha256:'0'.repeat(64)}),env,session.token,'complete');await run('VERIFY');
    expect((await db.prepare('SELECT stored_at FROM attachments').first<any>()).stored_at).toBeNull();expect(jobs.filter(j=>j.type==='attachment_transfer')).toHaveLength(0);
    expect((await db.prepare('SELECT status,last_error FROM attachment_upload_sessions').first<any>())).toEqual({status:'ABORTING',last_error:'UPLOAD_CHECKSUM_MISMATCH'});
    expect(jobs.some(j=>j.payload.phase==='ABORT')).toBe(true);
  });
  it('rechecks profile generation before queued work and cannot publish into a changed operator binding',async()=>{
    const bytes=new Uint8Array(31),session=await init(bytes);await run('INIT');await chunk(session,bytes);await assemble(session,bytes);
    env.runtimeConfigSnapshot={versions:{TELEGRAM_SUPPORT_PROFILE:1},errors:{}};await run('ASSEMBLE');expect(bucket.assemblies).toBe(0);expect(jobs.filter(j=>j.type==='attachment_transfer')).toHaveLength(0);
    expect((await db.prepare('SELECT status FROM attachment_upload_sessions').first<any>()).status).toBe('ABORTING');
  });
  it('releases only its failed verification lease and retries without falsely admitting data',async()=>{
    const bytes=new Uint8Array(31),session=await init(bytes);await run('INIT');await chunk(session,bytes);await assemble(session,bytes);await run('ASSEMBLE');await complete(session,bytes);
    const verify=jobs.find(j=>j.payload.phase==='VERIFY');const get=bucket.get.bind(bucket);bucket.get=async()=>{throw new Error('TRANSIENT_R2_READ');};
    await expect(handleQueueEvent(verify,env)).rejects.toThrow();expect((await db.prepare('SELECT lease_until FROM attachment_upload_sessions').first<any>()).lease_until).toBe(0);
    expect((await db.prepare('SELECT stored_at FROM attachments').first<any>()).stored_at).toBeNull();bucket.get=get;await handleQueueEvent(verify,env);
    expect((await status(session)).state).toBe('QUEUED');
  });
  it('does not execute R2 work from prequeued duplicate tasks after the durable four-attempt budget is exhausted',async()=>{
    const session=await init(new Uint8Array(31)),event=jobs[0];
    const create=vi.spyOn(bucket,'createMultipartUpload').mockRejectedValue(new Error('R2_TRANSIENT'));
    for(let attempt=0;attempt<4;attempt++)await expect(handleQueueEvent(event,env)).rejects.toThrow();
    const before=await db.prepare('SELECT status,attempt_count FROM event_receipts WHERE source_event_ref=?').bind(event.eventId).first();
    await handleQueueEvent(event,env);await handleQueueEvent(event,env);
    expect(create).toHaveBeenCalledTimes(4);expect(await db.prepare('SELECT status,attempt_count FROM event_receipts WHERE source_event_ref=?').bind(event.eventId).first()).toEqual(before);
    expect(before).toEqual({status:'FAILED',attempt_count:4});expect((await db.prepare('SELECT last_error FROM attachment_upload_sessions WHERE id=?').bind(session.sessionId).first<any>()).last_error).toBe('UPLOAD_ASYNC_RETRY_EXHAUSTED');
  });
  it('keeps an inflight chunk managed across cancel and a late R2 commit rather than retiring its key too early',async()=>{
    const bytes=new Uint8Array(31),session=await init(bytes);await run('INIT');const put=bucket.put.bind(bucket);
    let release!:()=>void;let started!:()=>void;const ready=new Promise<void>(r=>{started=r;});const barrier=new Promise<void>(r=>{release=r;});
    bucket.put=async(key,body,options)=>{started();await barrier;return put(key,body,options);};
    const pending=chunk(session,bytes);await ready;await handleUploadSession(new Request('https://custom.example/delete',{method:'DELETE'}),env,session.token,'');
    const abort=jobs.find(j=>j.payload.phase==='ABORT');await expect(handleQueueEvent(abort,env)).rejects.toThrow();
    expect((await db.prepare('SELECT status FROM attachment_upload_sessions').first<any>()).status).toBe('ABORTING');
    expect((await db.prepare('SELECT state FROM attachment_upload_subparts').first<any>()).state).not.toBe('DELETED');
    release();expect((await pending).status).toBe(410);vi.spyOn(Date,'now').mockReturnValue(Date.now()+301000);await handleQueueEvent(abort,env);
    expect(bucket.objects.size).toBe(0);expect((await db.prepare('SELECT state FROM attachment_upload_subparts').first<any>()).state).toBe('DELETED');
    expect((await db.prepare('SELECT status FROM attachment_upload_sessions').first<any>()).status).toBe('ABORTED');
  });
  it('reopens managed cleanup when an expired writer commits after cleanup already marked the session ABORTED',async()=>{
    const bytes=new Uint8Array(31),session=await init(bytes);await run('INIT');const put=bucket.put.bind(bucket);
    let release!:()=>void;let started!:()=>void;const ready=new Promise<void>(r=>{started=r;});const barrier=new Promise<void>(r=>{release=r;});
    bucket.put=async(key,body,options)=>{started();await barrier;return put(key,body,options);};
    const pending=chunk(session,bytes);await ready;
    await handleUploadSession(new Request('https://custom.example/delete',{method:'DELETE'}),env,session.token,'');
    const clock=vi.spyOn(Date,'now').mockReturnValue(Date.now()+301000);await run('ABORT');
    expect(bucket.objects.size).toBe(0);
    expect((await db.prepare('SELECT state FROM attachment_upload_subparts').first<any>()).state).toBe('DELETED');
    expect((await db.prepare('SELECT status FROM attachment_upload_sessions').first<any>()).status).toBe('ABORTED');
    release();expect((await pending).status).toBe(410);
    expect(bucket.objects.size).toBe(1);
    expect((await db.prepare('SELECT state,lease_until FROM attachment_upload_subparts').first<any>())).toEqual({state:'WRITING',lease_until:0});
    expect((await db.prepare('SELECT status FROM attachment_upload_sessions').first<any>()).status).toBe('ABORTING');
    clock.mockReturnValue(Date.now()+6000);await cleanupUploadSessions(env);
    expect(bucket.objects.size).toBe(0);
    expect((await db.prepare('SELECT state FROM attachment_upload_subparts').first<any>()).state).toBe('DELETED');
    expect((await db.prepare('SELECT status FROM attachment_upload_sessions').first<any>()).status).toBe('ABORTED');
    expect((await db.prepare('SELECT stored_at FROM attachments').first<any>()).stored_at).toBeNull();
  });
  it('redrives a durable upload queue gap through bounded maintenance after the browser is closed',async()=>{
    const session=await init(new Uint8Array(31));jobs=[];vi.spyOn(Date,'now').mockReturnValue(Date.now()+6000);
    await cleanupUploadSessions(env);expect(jobs.filter(j=>j.type==='upload_task'&&j.payload.phase==='INIT')).toHaveLength(1);
    await run('INIT');expect((await db.prepare('SELECT status FROM attachment_upload_sessions WHERE id=?').bind(session.sessionId).first<any>()).status).toBe('UPLOADING');
  });
  it('atomically refuses a fifth task claim when another consumer exhausts the budget after the preliminary read',async()=>{
    const session=await init(new Uint8Array(31)),event=jobs[0];
    await db.prepare("INSERT INTO event_receipts(source,source_event_ref,status,attempt_count) VALUES('internal',?,'FAILED',3)").bind(event.eventId).run();
    const original=db.prepare.bind(db);let raced=false;
    vi.spyOn(db,'prepare').mockImplementation((sql:string)=>{
      if(!raced&&sql.includes('INSERT INTO event_receipts')) {raced=true;db.exec("UPDATE event_receipts SET attempt_count=4 WHERE source='internal'");}
      return original(sql);
    });
    await handleQueueEvent(event,env);expect(raced).toBe(true);expect(bucket.creates).toBe(0);
    expect(await original('SELECT status,attempt_count FROM event_receipts').first()).toEqual({status:'FAILED',attempt_count:4});
    expect((await original('SELECT last_error FROM attachment_upload_sessions WHERE id=?').bind(session.sessionId).first<any>()).last_error).toBe('UPLOAD_ASYNC_RETRY_EXHAUSTED');
  });
  it('keeps a fourth hard-interrupted Queue attempt exhausted after its receipt lease expires',async()=>{
    const session=await init(new Uint8Array(31)),event=jobs[0];
    await db.prepare("INSERT INTO event_receipts(source,source_event_ref,status,attempt_count,lease_until) VALUES('internal',?,'PROCESSING',4,1)").bind(event.eventId).run();
    await handleQueueEvent(event,env);expect(bucket.creates).toBe(0);expect((await db.prepare('SELECT attempt_count FROM event_receipts').first<any>()).attempt_count).toBe(4);
    expect((await db.prepare('SELECT last_error FROM attachment_upload_sessions').first<any>()).last_error).toBe('UPLOAD_ASYNC_RETRY_EXHAUSTED');
  });
  it('does not let twenty exhausted sessions starve the next recoverable maintenance queue gap',async()=>{
    const session=await init(new Uint8Array(31));const a=await db.prepare('SELECT * FROM attachments').first<any>();const s=await db.prepare('SELECT * FROM attachment_upload_sessions').first<any>();
    for(let i=0;i<20;i++) {
      const att={...a,id:'exhaust-att-'+i,source_attachment_ref:'exhaust-source-'+i,storage_key:'attachments-v2/exhaust-'+i,access_token_hash:'exhaust-hash-'+i};const keys=Object.keys(att);
      await db.prepare(`INSERT INTO attachments(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).bind(...keys.map(k=>att[k])).run();
      const stale={...s,id:'exhaust-'+i,attachment_id:att.id,token_hash:'exhaust-token-'+i,last_error:'UPLOAD_ASYNC_RETRY_EXHAUSTED',updated_at:1};const sk=Object.keys(stale);
      await db.prepare(`INSERT INTO attachment_upload_sessions(${sk.join(',')}) VALUES(${sk.map(()=>'?').join(',')})`).bind(...sk.map(k=>stale[k])).run();
    }
    jobs=[];vi.spyOn(Date,'now').mockReturnValue(Date.now()+6000);await cleanupUploadSessions(env);
    expect(jobs.filter(j=>j.type==='upload_task')).toHaveLength(1);expect(jobs[0].payload.sessionId).toBe(session.sessionId);
  });
});
