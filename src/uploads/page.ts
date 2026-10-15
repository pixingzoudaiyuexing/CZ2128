// This implementation hashes fixed-size blocks; file contents never enter localStorage.
export const UPLOAD_SHA256_SCRIPT = String.raw`
const uploadSha256Constants = new Uint32Array([
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
]);
class UploadSha256 {
  constructor() {
    this.h = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
    this.buffer = new Uint8Array(64); this.words = new Uint32Array(64);
    this.used = 0; this.bytes = 0; this.done = false;
  }
  block(data, offset) {
    const w = this.words, rotate = (x,n) => (x >>> n) | (x << (32-n));
    for (let i=0; i<16; i++) {
      const p=offset+i*4; w[i]=(data[p]<<24)|(data[p+1]<<16)|(data[p+2]<<8)|data[p+3];
    }
    for (let i=16; i<64; i++) {
      const x=w[i-15], y=w[i-2];
      w[i]=(w[i-16]+(rotate(x,7)^rotate(x,18)^(x>>>3))+w[i-7]+(rotate(y,17)^rotate(y,19)^(y>>>10)))>>>0;
    }
    let [a,b,c,d,e,f,g,h]=this.h;
    for (let i=0; i<64; i++) {
      const t1=(h+(rotate(e,6)^rotate(e,11)^rotate(e,25))+((e&f)^(~e&g))+uploadSha256Constants[i]+w[i])>>>0;
      const t2=((rotate(a,2)^rotate(a,13)^rotate(a,22))+((a&b)^(a&c)^(b&c)))>>>0;
      h=g; g=f; f=e; e=(d+t1)>>>0; d=c; c=b; b=a; a=(t1+t2)>>>0;
    }
    const v=[a,b,c,d,e,f,g,h]; for(let i=0;i<8;i++) this.h[i]=(this.h[i]+v[i])>>>0;
  }
  update(data) {
    if(this.done) throw new Error('HASH_FINALIZED');
    this.bytes+=data.byteLength;
    if(!Number.isSafeInteger(this.bytes)) throw new Error('HASH_LENGTH_INVALID');
    let offset=0;
    if(this.used) {
      const length=Math.min(64-this.used,data.byteLength);
      this.buffer.set(data.subarray(0,length),this.used); this.used+=length; offset=length;
      if(this.used===64) { this.block(this.buffer,0); this.used=0; }
    }
    while(offset+64<=data.byteLength) { this.block(data,offset); offset+=64; }
    if(offset<data.byteLength) { this.buffer.set(data.subarray(offset),this.used); this.used+=data.byteLength-offset; }
    return this;
  }
  digest() {
    if(this.done) throw new Error('HASH_FINALIZED');
    this.buffer[this.used++]=0x80;
    if(this.used>56) { this.buffer.fill(0,this.used); this.block(this.buffer,0); this.used=0; }
    this.buffer.fill(0,this.used,56);
    const view=new DataView(this.buffer.buffer);
    view.setUint32(56,Math.floor(this.bytes/0x20000000)); view.setUint32(60,(this.bytes*8)>>>0);
    this.block(this.buffer,0); this.done=true;
    return Array.from(this.h,x=>x.toString(16).padStart(8,'0')).join('');
  }
}
`;

export const UPLOAD_PAGE_CLIENT_SCRIPT = String.raw`
function createUploadClient(doc) {
  const input=doc.getElementById('files'), start=doc.getElementById('start');
  const notice=doc.getElementById('notice'), list=doc.getElementById('uploads');
  const storedList=doc.getElementById('stored-files');
  const jobs=[], HASH_CHUNK=1024*1024, NETWORK_CHUNK=8*1024*1024, STORAGE='cz2128.upload.v1.';
  const path=location.pathname.replace(/\/$/,''), recovery=/^\/upload-sessions\/([A-Za-z0-9_-]{43})\/page$/.exec(path);
  const invite=/^\/uploads\/[A-Za-z0-9_-]{43}$/.test(path) ? path : null;
  const stateLabels={STORED:'已存储，等待转发',QUEUED:'已排队，等待送达',DELIVERED:'已送达',AMBIGUOUS:'交付结果不确定，请联系人工客服确认',FAILED:'文件已存储，转发失败，请联系人工客服'};
  const stoppedLabels={ABORTING:'正在取消，后台清理中',ABORTED:'已取消上传',EXPIRED:'上传会话已过期，请向客服获取新的入口',REVOKED:'上传已撤销，请向客服获取新的入口'};
  let active=false, queuePromise=Promise.resolve(), storageWarning=false, selectionTarget=null;

  function element(tag,text) { const node=doc.createElement(tag); if(text!==undefined) node.textContent=text; return node; }
  function showNotice(text) { notice.textContent=text; }
  function bytes(value) {
    if(value<1024) return value+' B';
    const units=['KiB','MiB','GiB','TiB']; let n=value/1024,i=0;
    while(n>=1024&&i<units.length-1) { n/=1024; i++; }
    return n.toFixed(n<10?2:1)+' '+units[i];
  }
  function key(text) { return new UploadSha256().update(new TextEncoder().encode(text)).digest(); }
  function save(job) {
    const r=job.record;
    try {
      localStorage.setItem(STORAGE+'file.'+r.id,JSON.stringify(r));
      if(r.token) localStorage.setItem(STORAGE+'session.'+key(r.token),JSON.stringify(r));
    } catch {
      if(!storageWarning) { storageWarning=true; showNotice('浏览器无法保存续传记录。请保持此页打开；暂停后仍可在本页继续。'); }
    }
  }
  function forget(job) {
    try {
      localStorage.removeItem(STORAGE+'file.'+job.record.id);
      if(job.record.token) localStorage.removeItem(STORAGE+'session.'+key(job.record.token));
    } catch { /* Upload does not depend on browser storage availability. */ }
  }
  function sessionPath(job) { return '/upload-sessions/'+job.record.token; }
  function check(job) { if(job.cancelled||job.paused) { const error=new Error('PAUSED'); error.paused=true; throw error; } }
  function safeLink(value) {
    if(typeof value!=='string'||!value.trim()) return null;
    try { const url=new URL(value,location.origin); return url.origin===location.origin&&url.protocol==='https:' ? url.href : null; }
    catch { return null; }
  }
  function errorText(error) {
    if(error.fileMismatch) return '选择的文件与原文件不同。请重新选择原文件，或取消后作为新文件上传。';
    if(error.integrity) return '文件完整性校验未通过，未确认上传成功。请重新选择原文件重试。';
    if(error.status===404||error.status===410) return '上传入口或会话已过期、已撤销或不可用。请向客服获取新的入口。';
    if(error.status===401||error.status===403) return '上传授权无效，请向客服获取新的入口。';
    if(error.status===413) return '当前传输请求超出服务平台限制。请保留原文件并联系人工客服选择其他交付方式。';
    if(error.status===409) return '文件状态发生变化或分片不一致。请刷新状态后使用原文件重试。';
    if(error.status===415) return '服务器无法安全接收这种文件内容。请联系人工客服。';
    if(error.status===429) return '上传请求过于频繁，请稍后重试。';
    if(error.status>=500) return '上传服务暂时不可用，已上传分片可在恢复后继续。';
    return '连接中断或请求未完成。请检查网络后继续上传，已确认的分片不会重复上传。';
  }
  async function api(url,method='GET',body) {
    let response;
    try { response=await fetch(url,{method,credentials:'omit',redirect:'error',cache:'no-store',
      headers:body===undefined ? {} : {'Content-Type':'application/json'},body:body===undefined ? undefined : JSON.stringify(body)}); }
    catch { throw new Error('NETWORK'); }
    if(!response.ok) { const error=new Error('HTTP'); error.status=response.status; throw error; }
    if(response.status===204) return {};
    try { return await response.json(); } catch { throw new Error('RESPONSE_INVALID'); }
  }
  function update(job,text,loaded) {
    job.status.textContent=text;
    if(loaded!==undefined) {
      job.progress.max=Math.max(1,job.record.sizeBytes); job.progress.value=loaded;
      job.amount.textContent=bytes(loaded)+' / '+bytes(job.record.sizeBytes);
    }
    const stored=Object.prototype.hasOwnProperty.call(stateLabels,job.record.state);
    const stopped=Object.prototype.hasOwnProperty.call(stoppedLabels,job.record.state);
    job.pause.hidden=stored||stopped||job.cancelled||!job.running;
    job.resume.hidden=stored||stopped||job.cancelled||job.running;
    job.resume.textContent=job.file ? '继续上传' : '选择原文件继续';
    job.cancel.hidden=stored||stopped||job.cancelled;
    job.refresh.hidden=!job.record.token||!(stored||stopped);
    job.dispatch.hidden=!['STORED','QUEUED'].includes(job.record.state);
  }
  function displayStored(job,data) {
    if(!Object.prototype.hasOwnProperty.call(stateLabels,data.state)) throw new Error('RESPONSE_STATE_INVALID');
    if(!/^[a-f0-9]{64}$/.test(data.sha256)||job.record.sha256&&data.sha256!==job.record.sha256) { const error=new Error('INTEGRITY'); error.integrity=true; throw error; }
    job.record.state=data.state;
    if(data.sha256) job.record.sha256=data.sha256;
    save(job); update(job,stateLabels[data.state],job.record.sizeBytes);
    job.details.replaceChildren();
    if(data.expiresAt) {
      const date=new Date(data.expiresAt<1e12 ? data.expiresAt*1000 : data.expiresAt);
      if(!Number.isNaN(date.getTime())) job.details.append(element('span','保留至 '+date.toLocaleString('zh-CN')));
    }
    const href=safeLink(data.url);
    if(href) { const a=element('a','查看或下载文件'); a.href=href; a.rel='noreferrer'; a.target='_blank'; job.details.append(a); }
    if(job.record.sha256) { const digest=element('details'), summary=element('summary','查看文件校验值'); digest.append(summary,element('code',job.record.sha256)); job.details.append(digest); }
  }
  function displayStopped(job,state) {
    if(!Object.prototype.hasOwnProperty.call(stoppedLabels,state)) throw new Error('RESPONSE_STATE_INVALID');
    job.record.state=state;job.cancelled=true;job.requested=false;
    if(state==='ABORTED')forget(job);else save(job);
    update(job,stoppedLabels[state]);
  }
  function displayVerification(job,data) {
    const progress=data.verification||data;
    const total=progress.totalBytes===undefined?progress.sizeBytes:progress.totalBytes;
    if(!Number.isSafeInteger(progress.verifiedBytes)||progress.verifiedBytes<0||progress.verifiedBytes>job.record.sizeBytes||
      total!==job.record.sizeBytes)throw new Error('VERIFICATION_INVALID');
    job.record.state='VERIFYING';job.record.verifiedBytes=progress.verifiedBytes;save(job);
    update(job,'文件已上传，正在校验完整性：'+bytes(progress.verifiedBytes)+' / '+bytes(total),progress.verifiedBytes);
  }
  async function completeFile(job) {
    while(true) {
      check(job);
      const completed=await api(sessionPath(job)+'/complete','POST',{sha256:job.record.sha256});
      if(completed.state==='VERIFYING'&&!completed.attachment) {
        displayVerification(job,completed);
        await new Promise(resolve=>setTimeout(resolve,50));
        continue;
      }
      displayStored(job,completed.attachment||completed);schedulePoll(job,0);await refreshFiles();return;
    }
  }
  async function hashBlob(blob,job,onProgress) {
    const hash=new UploadSha256();
    for(let offset=0;offset<blob.size;offset+=HASH_CHUNK) {
      check(job); const chunk=new Uint8Array(await blob.slice(offset,Math.min(blob.size,offset+HASH_CHUNK)).arrayBuffer());
      hash.update(chunk); if(onProgress) onProgress(Math.min(blob.size,offset+chunk.byteLength));
    }
    check(job); return hash.digest();
  }
  function validateSession(data,job) {
    if(!data||!Number.isSafeInteger(data.partSize)||data.partSize<1||data.partSize>5*1024*1024*1024||
      !Number.isSafeInteger(data.partCount)||data.partCount<0||data.partCount>10000||
      data.partCount!==Math.ceil(job.record.sizeBytes/data.partSize)||
      data.sizeBytes!==undefined&&data.sizeBytes!==job.record.sizeBytes) throw new Error('SESSION_INVALID');
    job.record.partSize=data.partSize; job.record.partCount=data.partCount;
    if(data.sessionId) job.record.sessionId=data.sessionId;
  }
  function putPart(job,number,blob,sha256,confirmed,chunkIndex) {
    return new Promise((resolve,reject)=>{
      const xhr=new XMLHttpRequest(); job.xhr=xhr;
      xhr.open('PUT',sessionPath(job)+'/parts/'+number+(chunkIndex?'/chunks/'+chunkIndex:'')); xhr.timeout=120000;
      xhr.setRequestHeader('Content-Type','application/octet-stream'); xhr.setRequestHeader('X-Part-SHA256',sha256);
      xhr.upload.addEventListener('progress',event=>{
        if(event.lengthComputable) update(job,'正在上传第 '+number+' / '+job.record.partCount+' 个分片'+(chunkIndex?'，第 '+chunkIndex+' 个网络块':''),confirmed+Math.min(event.loaded,blob.size));
      });
      xhr.onload=()=>{
        job.xhr=null;
        if(xhr.status>=200&&xhr.status<300) resolve();
        else { const error=new Error('HTTP'); error.status=xhr.status; reject(error); }
      };
      xhr.onerror=xhr.ontimeout=()=>{job.xhr=null;reject(new Error('NETWORK'));};
      xhr.onabort=()=>{job.xhr=null;const error=new Error('PAUSED');error.paused=job.paused||job.cancelled;reject(error);};
      xhr.send(blob);
    });
  }
  async function putWithRetry(job,number,blob,sha256,confirmed,chunkIndex) {
    for(let attempt=0;;attempt++) {
      check(job);
      try {await putPart(job,number,blob,sha256,confirmed,chunkIndex);return;}
      catch(error) {
        if(error.paused||attempt>=2||error.status&&error.status!==429&&error.status<500)throw error;
        update(job,'连接未完成，正在重试当前分片',confirmed);
        await new Promise(resolve=>setTimeout(resolve,Math.min(1000*2**attempt,4000)));
      }
    }
  }
  async function upload(job) {
    job.running=true; job.paused=false; update(job,'正在校验原文件',0);
    try {
      if(!job.file) { update(job,'请重新选择原文件以继续上传'); return; }
      if(!job.verified) {
        const sha256=await hashBlob(job.file,job,n=>update(job,'正在校验原文件',n));
        if(job.record.sha256&&job.record.sha256!==sha256) { const error=new Error('FILE_MISMATCH');error.fileMismatch=true;throw error; }
        job.record.sha256=sha256; job.verified=true; save(job);
      }
      check(job);
      if(!job.record.token) {
        if(!invite) throw new Error('INVITE_MISSING');
        job.initializing=true;
        let created;
        try {created=await api(invite+'/sessions','POST',{id:job.record.id,filename:job.record.filename,
          sizeBytes:job.record.sizeBytes,mimeType:job.record.mimeType});}
        finally {job.initializing=false;}
        if(typeof created.token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(created.token)) throw new Error('SESSION_INVALID');
        job.record.token=created.token; validateSession(created,job); save(job);
        if(job.cancelled) {const result=await api(sessionPath(job),'DELETE');displayStopped(job,result.state);schedulePoll(job,0);check(job);}
      }
      check(job);
      const remote=await api(sessionPath(job)); check(job); validateSession(remote,job);
      if(remote.attachment) { displayStored(job,remote.attachment); return; }
      if(Object.prototype.hasOwnProperty.call(stateLabels,remote.state)) { displayStored(job,remote); return; }
      if(Object.prototype.hasOwnProperty.call(stoppedLabels,remote.state)) {displayStopped(job,remote.state);schedulePoll(job,0);return;}
      if(remote.state==='VERIFYING'){displayVerification(job,remote);await completeFile(job);return;}
      const present=new Map();
      for(const part of remote.parts||[]) {
        if(!Number.isSafeInteger(part.number)||part.number<1||part.number>job.record.partCount||present.has(part.number)||
          !/^[a-f0-9]{64}$/.test(part.sha256)) throw new Error('PART_INVALID');
        present.set(part.number,part);
      }
      let confirmed=0;
      for(let number=1;number<=job.record.partCount;number++) {
        check(job);
        const offset=(number-1)*job.record.partSize, blob=job.file.slice(offset,Math.min(job.file.size,offset+job.record.partSize));
        update(job,'正在校验第 '+number+' / '+job.record.partCount+' 个分片',confirmed);
        const digest=await hashBlob(blob,job), old=present.get(number);
        if(old) {
          if(old.sha256!==digest||old.sizeBytes!==blob.size) {const error=new Error('INTEGRITY');error.integrity=true;throw error;}
        } else if(job.record.partSize>64*1024*1024) {
          const manifest=await api(sessionPath(job)+'?part='+number);check(job);
          const chunks=new Map();
          for(const chunk of manifest.chunks||[]) {
            const expected=Math.min(NETWORK_CHUNK,blob.size-(chunk.index-1)*NETWORK_CHUNK);
            if(chunk.number!==number||!Number.isSafeInteger(chunk.index)||chunk.index<1||chunk.index>Math.ceil(blob.size/NETWORK_CHUNK)||
              expected<1||chunk.sizeBytes!==expected||!/^[a-f0-9]{64}$/.test(chunk.sha256)||chunks.has(chunk.index))throw new Error('PART_INVALID');
            chunks.set(chunk.index,chunk);
          }
          for(let offset=0,index=1;offset<blob.size;offset+=NETWORK_CHUNK,index++) {
            check(job);
            const block=blob.slice(offset,Math.min(blob.size,offset+NETWORK_CHUNK));
            const blockHash=await hashBlob(block,job), storedChunk=chunks.get(index);
            if(storedChunk) {
              if(storedChunk.sha256!==blockHash||storedChunk.sizeBytes!==block.size){const error=new Error('INTEGRITY');error.integrity=true;throw error;}
            } else await putWithRetry(job,number,block,blockHash,confirmed+offset,index);
            update(job,'已上传并校验第 '+number+' 个分片的第 '+index+' 个网络块',confirmed+offset+block.size);
          }
          check(job);
          update(job,'正在合并并校验第 '+number+' / '+job.record.partCount+' 个分片',confirmed+blob.size);
          await api(sessionPath(job)+'/parts/'+number+'/assemble','POST',{sha256:digest});
        } else await putWithRetry(job,number,blob,digest,confirmed);
        confirmed+=blob.size; update(job,'已上传并校验 '+number+' / '+job.record.partCount+' 个分片',confirmed);
      }
      check(job); update(job,'正在确认文件完整性与存储状态',confirmed);
      await completeFile(job);
    } catch(error) {
      if(job.cancelled) update(job,stoppedLabels[job.record.state]||'已停止上传，正在确认取消状态');
      else if(error.paused) update(job,'已暂停；可继续上传已确认分片之后的内容');
      else {job.paused=true;update(job,errorText(error));}
    } finally {job.running=false;update(job,job.status.textContent);}
  }
  async function refreshJob(job) {
    try {
      const data=await api(sessionPath(job));
      if(data.attachment) displayStored(job,data.attachment);
      else if(Object.prototype.hasOwnProperty.call(stateLabels,data.state)) displayStored(job,data);
      else if(Object.prototype.hasOwnProperty.call(stoppedLabels,data.state))displayStopped(job,data.state);
      else if(data.state==='VERIFYING')displayVerification(job,data);
      return job.record.state;
    } catch(error) {update(job,errorText(error));return null;}
  }
  function schedulePoll(job,attempt) {
    if(!['STORED','QUEUED','ABORTING'].includes(job.record.state)||attempt>=15) return;
    setTimeout(async()=>{await refreshJob(job);schedulePoll(job,attempt+1);},2000);
  }
  async function dispatch(job) {
    try {
      await api(sessionPath(job)+'/dispatch','POST',{}); await refreshJob(job);schedulePoll(job,0);
    } catch(error) {update(job,errorText(error));}
  }
  async function cancel(job) {
    job.cancelled=true;job.requested=false;if(job.xhr) job.xhr.abort();
    try {
      if(job.record.token) {
        const result=await api(sessionPath(job),'DELETE');
        displayStopped(job,result.state);schedulePoll(job,0);
      } else if(job.initializing)update(job,'已停止上传，正在确认取消状态');
      else displayStopped(job,'ABORTED');
    } catch(error) {
      job.cancelled=false;job.paused=true;update(job,'取消未确认。'+errorText(error));
    }
  }
  function makeJob(record,file) {
    const job={record,file,verified:false,paused:false,cancelled:false,running:false,initializing:false,requested:false,xhr:null};
    const row=element('li'), header=element('div');header.className='file-heading';
    header.append(element('strong',record.filename),element('span',bytes(record.sizeBytes)));
    job.status=element('p',file?'准备上传':'找到未完成记录，请选择原文件继续');job.status.className='file-status';
    job.progress=element('progress');job.progress.max=Math.max(1,record.sizeBytes);job.progress.value=0;job.progress.setAttribute('aria-label',record.filename+' 上传进度');
    job.amount=element('span','0 B / '+bytes(record.sizeBytes));job.amount.className='amount';
    job.details=element('div');job.details.className='file-details';
    const actions=element('div');actions.className='file-actions';
    job.pause=element('button','暂停');job.resume=element('button','继续上传');job.cancel=element('button','取消上传');
    job.refresh=element('button','刷新交付状态');job.dispatch=element('button','重试转发');
    for(const button of [job.pause,job.resume,job.cancel,job.refresh,job.dispatch]) button.type='button';
    job.pause.addEventListener('click',()=>{job.paused=true;job.requested=false;if(job.xhr)job.xhr.abort();});
    job.resume.addEventListener('click',()=>{if(!job.file){selectionTarget=job;input.click();return;}job.requested=true;return drain();});
    job.cancel.addEventListener('click',()=>cancel(job));job.refresh.addEventListener('click',()=>refreshJob(job));
    job.dispatch.addEventListener('click',()=>dispatch(job));
    actions.append(job.pause,job.resume,job.cancel,job.refresh,job.dispatch);
    row.append(header,job.status,job.progress,job.amount,job.details,actions);list.append(row);jobs.push(job);update(job,job.status.textContent);
    return job;
  }
  function addFiles(files) {
    for(const file of files) {
      if(!Number.isSafeInteger(file.size)||file.size<0) {showNotice('浏览器无法读取此文件大小，请重新选择。');continue;}
      if(selectionTarget) {
        const target=selectionTarget;
        if(target.record.filename!==file.name||target.record.sizeBytes!==file.size||
          target.record.lastModified!==undefined&&target.record.lastModified!==file.lastModified) {
          showNotice('请选择与原上传记录一致的文件。');continue;
        }
        selectionTarget=null;target.file=file;target.verified=false;update(target,'原文件已选择，点击继续上传');continue;
      }
      let existing=jobs.find(job=>!job.cancelled&&!Object.prototype.hasOwnProperty.call(stateLabels,job.record.state)&&
        job.record.filename===file.name&&job.record.sizeBytes===file.size&&job.record.lastModified===file.lastModified);
      if(recovery&&!existing) {
        existing=jobs[0];
        if(!existing||existing.record.sizeBytes!==file.size||existing.record.filename!==file.name||
           existing.record.lastModified!==undefined&&existing.record.lastModified!==file.lastModified) {
          showNotice('请选择与原上传记录一致的文件。');continue;
        }
      }
      if(existing) {existing.file=file;existing.verified=false;update(existing,'原文件已选择，点击继续上传');}
      else if(invite) {
        const record={id:crypto.randomUUID(),inviteHash:key(invite),filename:file.name,sizeBytes:file.size,
          lastModified:file.lastModified,mimeType:file.type||'application/octet-stream',state:'PENDING'};
        const job=makeJob(record,file);save(job);
      }
    }
    input.value='';
  }
  async function drain() {
    if(active) return queuePromise;
    active=true;start.disabled=true;
    queuePromise=(async()=>{
      try {
        while(true) {
          const job=jobs.find(item=>item.requested&&!item.running&&!item.cancelled&&!Object.prototype.hasOwnProperty.call(stateLabels,item.record.state));
          if(!job) break;job.requested=false;await upload(job);
        }
      } finally {active=false;start.disabled=false;}
    })();
    return queuePromise;
  }
  async function begin() {
    for(const job of jobs) if(job.file&&!job.cancelled&&!Object.prototype.hasOwnProperty.call(stateLabels,job.record.state)) job.requested=true;
    if(!jobs.some(job=>job.requested)) showNotice('请先选择文件；续传时请选择原文件。');
    return drain();
  }
  async function refreshFiles() {
    if(!invite) return;
    try {
      const result=await api(invite+'/files');storedList.replaceChildren();
      for(const file of result.files||[]) {
        const row=element('li'),name=element('strong',file.filename||'文件');row.append(name);
        row.append(element('p',(stateLabels[file.state]||'已存储')+' · '+bytes(file.sizeBytes||0)));
        if(file.expiresAt) {const date=new Date(file.expiresAt<1e12?file.expiresAt*1000:file.expiresAt);if(!Number.isNaN(date.getTime()))row.append(element('p','保留至 '+date.toLocaleString('zh-CN')));}
        const href=safeLink(file.url);if(href){const link=element('a','查看或下载文件');link.href=href;link.rel='noreferrer';link.target='_blank';row.append(link);}
        storedList.append(row);
      }
      if(!storedList.children.length) storedList.append(element('li','还没有已存储的文件。'));
    } catch(error) {showNotice(errorText(error)+' 已创建的上传会话可从下方继续。');}
  }
  async function initialize() {
    input.addEventListener('change',()=>addFiles(Array.from(input.files||[])));
    start.addEventListener('click',begin);doc.getElementById('refresh-files').addEventListener('click',refreshFiles);
    if(!invite&&!recovery) {showNotice('上传链接无效，请向客服获取新的入口。');start.disabled=true;input.disabled=true;return;}
    const records=new Map();
    try {
      if(recovery) {
        input.multiple=false;
        const raw=localStorage.getItem(STORAGE+'session.'+key(recovery[1]));if(raw){const r=JSON.parse(raw);records.set(r.id,r);}
      } else {
        for(let i=0;i<localStorage.length;i++) {
          const storageKey=localStorage.key(i);
          if(storageKey&&storageKey.startsWith(STORAGE+'file.')) {
            try {const r=JSON.parse(localStorage.getItem(storageKey));if(r.inviteHash===key(invite))records.set(r.id,r);}catch{}
          }
        }
      }
    } catch {showNotice('无法读取本地续传记录，请保持当前页面打开。');}
    for(const record of records.values()) {
      if(typeof record.id!=='string'||typeof record.filename!=='string'||!Number.isSafeInteger(record.sizeBytes)||record.sizeBytes<0||
        record.token!==undefined&&!/^[A-Za-z0-9_-]{43}$/.test(record.token)||recovery&&record.token!==recovery[1]) continue;
      const job=makeJob(record,null);if(record.token)await refreshJob(job);
    }
    if(recovery&&!jobs.length) {
      try {
        const data=await api('/upload-sessions/'+recovery[1]);
        const record={id:crypto.randomUUID(),token:recovery[1],sessionId:data.sessionId,filename:data.filename,
          sizeBytes:data.sizeBytes,partSize:data.partSize,partCount:data.partCount,state:'PENDING'};
        if(typeof data.filename!=='string'||!Number.isSafeInteger(data.sizeBytes))throw new Error('SESSION_INVALID');
        const job=makeJob(record,null);validateSession(data,job);save(job);
        if(data.attachment)displayStored(job,data.attachment);
        else if(Object.prototype.hasOwnProperty.call(stateLabels,data.state))displayStored(job,data);
        else if(Object.prototype.hasOwnProperty.call(stoppedLabels,data.state))displayStopped(job,data.state);
        else if(data.state==='VERIFYING')displayVerification(job,data);
      } catch(error){showNotice(errorText(error));start.disabled=true;input.disabled=true;return;}
    }
    if(recovery)showNotice('继续此前已创建的上传。请选择原文件；上传入口过期不会提前删除已存储文件。');
    await refreshFiles();
  }
  return {initialize,addFiles,begin,jobs,refreshFiles};
}
`;

export function uploadPage(): Response {
  const nonceBytes = crypto.getRandomValues(new Uint8Array(18));
  const nonce = btoa(String.fromCharCode(...nonceBytes));
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>向客服上传文件</title><style nonce="${nonce}">
  :root{color-scheme:light;font:16px/1.6 system-ui,-apple-system,"PingFang SC",sans-serif;color:#20262d;background:#f5f6f7}*{box-sizing:border-box}body{margin:0}main{max-width:780px;margin:40px auto;padding:0 24px 48px}h1{font-size:28px;margin:0 0 8px}h2{font-size:19px;margin:32px 0 12px}p{margin:8px 0}.intro{color:#56606a}.picker{padding:20px;background:white;border:1px solid #d7dce0;border-radius:8px;margin-top:24px}label{display:block;font-weight:600;margin-bottom:12px}input[type=file]{display:block;max-width:100%;font:inherit;margin-bottom:16px}button,a{font:inherit}button{border:1px solid #b9c2cb;border-radius:5px;background:#fff;color:#27394b;padding:8px 14px;cursor:pointer;min-height:44px}button.primary{background:#145a91;color:white;border-color:#145a91}button:disabled{opacity:.55;cursor:default}button:focus-visible,a:focus-visible,input:focus-visible,summary:focus-visible{outline:3px solid #2983c7;outline-offset:3px}a{color:#145a91;overflow-wrap:anywhere}#notice{min-height:26px;color:#734b0c;margin:14px 0;overflow-wrap:anywhere}ul{list-style:none;padding:0}li{padding:18px 0;border-bottom:1px solid #d7dce0}.file-heading{display:flex;align-items:baseline;justify-content:space-between;gap:16px}.file-heading strong{overflow-wrap:anywhere;min-width:0}.file-heading span,.amount{font-size:14px;color:#606b75;white-space:nowrap}.file-status{overflow-wrap:anywhere}progress{display:block;width:100%;height:14px;accent-color:#145a91}.amount{display:block;margin-top:4px}.file-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}.file-details{font-size:14px;display:grid;gap:6px;margin-top:8px}code{display:block;overflow-wrap:anywhere;font-size:12px;margin-top:6px}summary{cursor:pointer}.retention{font-size:14px;color:#606b75;margin-top:18px}[hidden]{display:none!important}@media(max-width:520px){main{margin:24px auto;padding:0 16px 32px}h1{font-size:24px}.picker{padding:16px}.file-heading{align-items:start}.file-actions button{flex:1 1 auto}}
  </style></head><body><main><h1>向客服上传文件</h1><p class="intro">选择图片或普通文件，可连续上传多个文件。中断后重新选择原文件，可接着上传。</p><p class="retention">普通附件默认保存 72 小时，图片默认保存 7 天，从成功存储开始计算。上传入口的有效期与文件保存期限独立。</p><section class="picker" aria-label="选择上传文件"><label for="files">选择图片和文件</label><input id="files" type="file" multiple><button id="start" class="primary" type="button">开始上传</button></section><p id="notice" role="status" aria-live="polite"></p><section aria-labelledby="upload-heading"><h2 id="upload-heading">上传进度</h2><ul id="uploads" aria-live="polite" aria-relevant="additions text"></ul></section><section aria-labelledby="stored-heading"><h2 id="stored-heading">已存储的文件</h2><button id="refresh-files" type="button">刷新文件列表</button><ul id="stored-files"></ul></section><noscript><p>请启用 JavaScript 以分片上传和继续未完成的文件。</p></noscript></main><script nonce="${nonce}">${UPLOAD_SHA256_SCRIPT}
${UPLOAD_PAGE_CLIENT_SCRIPT}
createUploadClient(document).initialize();</script></body></html>`;
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'private, no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'none'; media-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`
    }
  });
}
