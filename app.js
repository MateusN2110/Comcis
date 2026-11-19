/* Comics — device-local comic reader. No backend, no analytics. */
'use strict';
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));
const DB_NAME = 'folio-comics-1'; // Legacy database name preserves existing Folio libraries.
const DB_VERSION = 1;
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const settings = {
  transition: localStorage.getItem('folio-transition') || 'slide',
  direction: localStorage.getItem('folio-direction') || 'ltr',
  fit: localStorage.getItem('folio-fit') || 'contain',
  spread: localStorage.getItem('comics-spread') || 'single',
  clientId: localStorage.getItem('folio-client-id') || ''
};
const state = { db:null, books:[], filter:'all', query:'', activeView:'library', token:null, tokenExpiry:0,
  driveStack:[{id:'root',name:'My Drive'}], reader:null, toastTimeout:null, detailsId:null,
  connectAttempt:0, driveRequests:new Set(), sessionFiles:new Map(), relinkId:null, driveFiles:new Map() };
const ALLOWED = /\.(jpg|jpeg|png|webp|gif)$/i; // Avoid untrusted active SVG content.
const ARCHIVE = /\.(cbz|zip)$/i;
const MIME_FOLDER = 'application/vnd.google-apps.folder';
function escapeHTML(s) { return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function filenameTitle(name) { return name.replace(/\.(cbz|zip)$/i,'').replace(/[_]+/g,' ').trim(); }
function detectSeries(name){
 const clean=name.replace(/\[[^\]]*\]/g,' ').replace(/\s+/g,' ').trim();
 let match=clean.match(/^(.*?)\s*(?:#\s*|(?:issue|part|chapter)\s+)(\d{1,4})(?=\D|$)/i);
 if(!match)match=clean.match(/^(.*?)\s*[-–]\s*(\d{1,3})(?:\s*\([^)]*\))?$/);
 if(!match)match=clean.match(/^(.*?)\s+(0\d{1,3})(?:\s*\([^)]*\))?$/);
 if(!match)return {series:'',issueNumber:null};
 const series=match[1].replace(/[\s._#–-]+$/,'').trim();
 const number=Number(match[2]);
 return series && Number.isInteger(number) && number>0 ? {series,issueNumber:number} : {series:'',issueNumber:null};
}
function hasRead(book){return book.pageCount>0 && book.lastPage>=book.pageCount-1;}
function hasStarted(book){return book.lastPage>=0 || !!book.startedAt || hasRead(book);}
function dateLabel(value){
 if(!value)return 'Not recorded';
 const d=new Date(value);
 return Number.isNaN(d.getTime())?'Not recorded':new Intl.DateTimeFormat(undefined,{day:'numeric',month:'short',year:'numeric'}).format(d);
}
function localDate(value){
 if(!value)return '';
 const d=new Date(value);if(Number.isNaN(d.getTime()))return '';
 return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');
}
function dateValue(value){return value ? new Date(value+'T12:00:00').getTime() : null;}
function seriesKey(value){return (value||'').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();}
function upNextBooks(books){
 const groups=new Map();
 books.forEach(book=>{
  if(!book.series || !Number.isInteger(Number(book.issueNumber)) || Number(book.issueNumber)<1)return;
  const key=seriesKey(book.series);if(!key)return;
  if(!groups.has(key))groups.set(key,[]);groups.get(key).push(book);
 });
 const suggestions=[];
 for(const items of groups.values()){
  const byNumber=new Map();
  items.forEach(b=>{const num=Number(b.issueNumber);if(!byNumber.has(num))byNumber.set(num,b);});
  const ordered=Array.from(byNumber.values()).sort((a,b)=>Number(a.issueNumber)-Number(b.issueNumber));
  const completed=ordered.filter(hasRead);
  if(!completed.length)continue;
  const next=ordered.find(b=>!hasRead(b)&&completed.some(done=>Number(done.issueNumber)+1===Number(b.issueNumber)));
  if(next)suggestions.push({book:next,previous:completed.find(b=>Number(b.issueNumber)+1===Number(next.issueNumber))});
 }
 return suggestions.sort((a,b)=>(b.previous.finishedAt||b.previous.addedAt||0)-(a.previous.finishedAt||a.previous.addedAt||0)).slice(0,6);
}
function renderReadingOverview(){
 const done=state.books.filter(hasRead).length;
 const reading=state.books.filter(b=>hasStarted(b)&&!hasRead(b)).length;
 $('#stat-read').textContent=String(done);
 $('#stat-reading').textContent=String(reading);
 $('#stat-unread').textContent=String(state.books.length-done-reading);
 const suggested=upNextBooks(state.books),container=$('#up-next-section');
 container.classList.toggle('hidden',!suggested.length);
 $('#up-next-list').innerHTML=suggested.map(({book,previous})=>{
  const label=hasStarted(book)?'Continue reading':'Read next';
  const cover=book.cover?`<img src="${book.cover}" alt="" loading="lazy">`:'<span class="up-next-symbol">▣</span>';
  return `<button class="up-next-item" data-next="${escapeHTML(book.id)}">`+
   `<span class="up-next-cover">${cover}</span>`+
   `<span class="up-next-copy"><b>${escapeHTML(book.name)}</b><small>After ${escapeHTML(previous.name)}</small><em>${label} →</em></span></button>`;
 }).join('');
}

function makeId() { return (crypto.randomUUID ? crypto.randomUUID() : 'b'+Date.now()+'-'+Math.random().toString(36).slice(2)); }
function sizeLabel(bytes){if(!bytes)return '—';return bytes>=1073741824?(bytes/1073741824).toFixed(2)+' GB':bytes>=1048576?(bytes/1048576).toFixed(1)+' MB':Math.round(bytes/1024)+' KB';}
function toast(msg){ const el=$('#toast');el.textContent=msg;el.classList.add('visible');clearTimeout(state.toastTimeout);state.toastTimeout=setTimeout(()=>el.classList.remove('visible'),3400); }
function busy(title,description){ $('#busy-title').textContent=title;$('#busy-desc').textContent=description||'';$('#busy-overlay').classList.remove('hidden'); }
function idle(){ $('#busy-overlay').classList.add('hidden'); }
function openDatabase(){
 return new Promise((resolve,reject)=>{
  const req=indexedDB.open(DB_NAME,DB_VERSION);
  req.onupgradeneeded=()=>{const db=req.result;if(!db.objectStoreNames.contains('books'))db.createObjectStore('books',{keyPath:'id'});if(!db.objectStoreNames.contains('archives'))db.createObjectStore('archives',{keyPath:'id'});};
  req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
 });
}
function idb(action,store,record){
 return new Promise((resolve,reject)=>{
  const tx=state.db.transaction(store,action==='get'||action==='all'?'readonly':'readwrite');
  const os=tx.objectStore(store);
  let req;
  if(action==='get')req=os.get(record);
  else if(action==='all')req=os.getAll();
  else if(action==='put')req=os.put(record);
  else if(action==='delete')req=os.delete(record);
  else throw new Error('Invalid database operation');
  req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
 });
}
async function reloadBooks(){state.books=(await idb('all','books')).sort((a,b)=>b.addedAt-a.addedAt);renderLibrary();updateStorage();}
function switchView(view){
 state.activeView=view;
 $$('.view').forEach(el=>el.classList.toggle('active',el.id===view+'-view'));
 $$('.nav-item').forEach(el=>el.classList.toggle('active',el.dataset.view===view));
 window.scrollTo(0,0);
 if(view==='drive') renderDriveStatus();
 if(view==='settings') renderSettings();
}
function renderLibrary(){
 const list=state.books.filter(book=>{
  const progress=book.lastPage>=0 ? (book.lastPage+1)/book.pageCount : 0;
  if(state.filter==='reading' && !(hasStarted(book)&&!hasRead(book)))return false;
  if(state.filter==='finished' && !hasRead(book))return false;
  return book.name.toLowerCase().includes(state.query);
 });
 $('#book-count').textContent=String(state.books.length);
 const grid=$('#library-grid');
 grid.innerHTML=list.map(book=>{
  const p=book.lastPage>=0?Math.round((book.lastPage+1)/book.pageCount*100):0;
  const pageInfo=hasRead(book)?'Finished':p?`${p}% read`:'Not started';
  const dateText=hasRead(book)?('Finished: '+dateLabel(book.finishedAt)):(hasStarted(book)?'Started: '+dateLabel(book.startedAt):'');
  const sourceText=book.origin==='drive-stream'?'· Drive stream':book.origin==='local-stream'?'· Re-select to read':'';
  const cover=book.cover?`<img src="${book.cover}" alt="Cover of ${escapeHTML(book.name)}" loading="lazy">`:`<div class="placeholder-cover"><span>${escapeHTML(book.name)}</span></div>`;
  return `<article class="book-card" data-id="${escapeHTML(book.id)}"><button class="book-card-cover" data-open="${escapeHTML(book.id)}" aria-label="Read ${escapeHTML(book.name)}">${cover}</button><button class="book-card-delete" data-delete="${escapeHTML(book.id)}" aria-label="Delete local copy of ${escapeHTML(book.name)}">×</button><div class="book-card-title" title="${escapeHTML(book.name)}">${escapeHTML(book.name)}</div><div class="book-card-desc"><span>${book.pageCount} pages</span><span>${pageInfo}</span></div><div class="book-card-source">${sourceText}</div><div class="mini-progress"><span style="width:${p}%"></span></div>${dateText?`<div class="book-card-date">${escapeHTML(dateText)}</div>`:''}<button class="book-details-button" data-details="${escapeHTML(book.id)}" aria-label="Details for ${escapeHTML(book.name)}">Edit details ↗</button></article>`;
 }).join('');
 $('#empty-state').classList.toggle('hidden',state.books.length>0||state.filter!=='all'||!!state.query);
 if(!list.length&&(state.books.length>0||state.filter!=='all'||state.query))grid.innerHTML='<p style="grid-column:1/-1;color:#9b98a2;font-size:12px;padding:18px 0;">No comics match this filter.</p>';
 $$('.chip').forEach(el=>el.classList.toggle('selected',el.dataset.filter===state.filter));
 renderReadingOverview();
 const connected=!!state.token&&Date.now()<state.tokenExpiry;
 $('#drive-banner-caption').textContent=connected?'Browse your Google Drive library.':'Connect Google Drive to find your collection.';
}
function openDetails(id){
 const book=state.books.find(b=>b.id===id);if(!book)return;
 state.detailsId=id;
 $('#details-name').textContent=book.name;
 $('#details-status').textContent=hasRead(book)?'Read · '+book.pageCount+' pages':hasStarted(book)?'In progress · '+book.pageCount+' pages':'Unread · '+book.pageCount+' pages';
 $('#details-series').value=book.series||'';
 $('#details-issue').value=book.issueNumber??'';
 $('#details-started').value=localDate(book.startedAt);
 $('#details-finished').value=localDate(book.finishedAt);
 $('#details-mark-read').textContent=hasRead(book)?'Already finished ✓':'Mark finished today';
 $('#details-mark-read').disabled=hasRead(book);
 $('#details-reset').disabled=!hasStarted(book);
 $('#book-details').classList.remove('hidden');
 document.body.style.overflow='hidden';
}
function closeDetails(){state.detailsId=null;$('#book-details').classList.add('hidden');document.body.style.overflow='';}
async function saveDetails(){
 const book=state.books.find(b=>b.id===state.detailsId);if(!book)return;
 const series=$('#details-series').value.trim().slice(0,180);
 const issueRaw=$('#details-issue').value.trim();
 const issue=issueRaw===''?null:Number(issueRaw);
 if(issueRaw!==''&&(!Number.isInteger(issue)||issue<1||issue>9999)){toast('Issue must be a number from 1 to 9999.');return;}
 if(issue!==null&&!series){toast('Add a series name when setting an issue number.');return;}
 const started=dateValue($('#details-started').value),finished=dateValue($('#details-finished').value);
 if(started&&finished&&finished<started){toast('Finish date cannot be before start date.');return;}
 book.series=series;book.issueNumber=issue;book.startedAt=started;book.finishedAt=finished;
 if(finished){book.lastPage=book.pageCount-1;book.currentPage=book.pageCount-1;}
 await idb('put','books',book);closeDetails();await reloadBooks();toast('Comic details saved.');
}
async function markFinishedToday(){
 const book=state.books.find(b=>b.id===state.detailsId);if(!book)return;
 const now=Date.now();
 book.startedAt=book.startedAt||now;book.finishedAt=now;
 book.lastPage=book.pageCount-1;book.currentPage=book.pageCount-1;
 await idb('put','books',book);closeDetails();await reloadBooks();toast('Marked as read.');
}
async function resetReadingProgress(){
 const book=state.books.find(b=>b.id===state.detailsId);if(!book)return;
 if(!confirm('Reset reading progress and both dates for “'+book.name+'”?'))return;
 book.startedAt=null;book.finishedAt=null;book.lastPage=-1;book.currentPage=0;
 await idb('put','books',book);closeDetails();await reloadBooks();toast('Progress reset.');
}
function sourceForDrive(id,size){
 if(!Number.isSafeInteger(size)||size<22)throw new Error('Drive file size is unknown. Open a file that reports a size.');
 return {size,async read(offset,length){
  if(length<0||offset<0||offset+length>size)throw new Error('Invalid download range.');
  const url='https://www.googleapis.com/drive/v3/files/'+encodeURIComponent(id)+'?alt=media';
  const data=await driveRequest(url,{start:offset,end:offset+length});
  if(data.length!==length)throw new Error('Drive returned a partial or incorrect byte range.');
  return data;
 }};
}
async function coverFromArchive(archive){
 const blob=await archive.page(0),objectUrl=URL.createObjectURL(blob);
 try{const img=new Image();await new Promise((yes,no)=>{img.onload=yes;img.onerror=no;img.src=objectUrl;});
  const canvas=document.createElement('canvas');canvas.width=210;
  canvas.height=Math.min(320,Math.max(80,Math.round(210*img.naturalHeight/img.naturalWidth)));
  canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);
  return canvas.toDataURL('image/jpeg',.64);
 }catch(e){return '';}finally{URL.revokeObjectURL(objectUrl);}
}
async function addComic(sourceOrBlob,name,origin='local',driveId=null,openAfter=false){
 if(!ARCHIVE.test(name))throw new Error('Only CBZ/ZIP comic archives are supported.');
 const size=sourceOrBlob.size;
 if(size>ComicsZip.LIMIT)throw new Error('Maximum CBZ size is 3 GiB.');
 const existing=driveId&&state.books.find(book=>book.driveId===driveId);
 if(existing){if(openAfter)await openReader(existing.id);else toast('Already in your library.');return existing;}
 const blob=sourceOrBlob instanceof Blob?sourceOrBlob:null;
 const source=blob?ComicsZip.sourceFromBlob(blob):sourceOrBlob;
 busy('Indexing comic…','Reading the archive directory, not unpacking the whole file');
 try{
  const archive=await ComicsZip.open(source),cover=await coverFromArchive(archive);
  const title=filenameTitle(name),detected=detectSeries(title);
  const stream=(!blob||size>100*1024*1024);
  const actualOrigin=!blob?'drive-stream':stream?'local-stream':origin;
  const book={id:makeId(),name:title,originalName:name,pageCount:archive.entries.length,cover,addedAt:Date.now(),lastPage:-1,currentPage:0,startedAt:null,finishedAt:null,...detected,origin:actualOrigin,driveId,size};
  try{
   if(!stream)await idb('put','archives',{id:book.id,blob});
   await idb('put','books',book);
  }catch(err){await idb('delete','archives',book.id).catch(()=>{});throw new Error('Could not save the comic metadata. Check browser storage.');}
  if(blob&&stream)state.sessionFiles.set(book.id,blob);
  await reloadBooks();toast(stream?'Added in streaming mode':'Saved for offline reading');
  if(openAfter)await openReader(book.id);return book;
 }finally{idle();}
}
async function importLocalFiles(fileList){
 const files=Array.from(fileList||[]);if(!files.length)return;
 if(state.relinkId){
  const id=state.relinkId;state.relinkId=null;
  const book=state.books.find(b=>b.id===id),file=files[0];
  if(!book||book.originalName!==file.name||book.size!==file.size){toast('Please choose the same comic file (name and size) as before.');return;}
  state.sessionFiles.set(id,file);await openReader(id);return;
 }
 for(const file of files){try{await addComic(file,file.name,'local',null,false);}catch(e){toast(e.message||'Could not import '+file.name);}}
}
async function loadDemo(){
 const existing=state.books.find(x=>x.origin==='demo');if(existing){await openReader(existing.id);return;}
 try{const response=await fetch('assets/demo.cbz');if(!response.ok)throw new Error('Demo not available.');const blob=await response.blob();await addComic(blob,'The Last Signal.cbz','demo',null,true);}catch(e){idle();toast(e.message||'Demo could not be loaded.');}
}
async function deleteBook(id){
 const book=state.books.find(x=>x.id===id);if(!book)return;
 if(!confirm('Remove “'+book.name+'” from this device? A Google Drive original will not be deleted.'))return;
 state.sessionFiles.delete(id);await idb('delete','books',id);await idb('delete','archives',id);await reloadBooks();toast('Removed local copy.');
}
function updateStorage(){const kept=state.books.filter(b=>b.origin!=='local-stream'&&b.origin!=='drive-stream');const bytes=kept.reduce((sum,b)=>sum+(b.size||0),0);$('#storage-info').textContent=kept.length+' offline · '+sizeLabel(bytes)+' cached · '+(state.books.length-kept.length)+' streamed';}
function renderSettings(){
 $$('#transition-options button').forEach(b=>b.classList.toggle('active',b.dataset.transition===settings.transition));
 $$('#direction-options button').forEach(b=>b.classList.toggle('active',b.dataset.direction===settings.direction));
 $$('#fit-options button').forEach(b=>b.classList.toggle('active',b.dataset.fit===settings.fit));
 $$('#spread-options button').forEach(b=>b.classList.toggle('active',b.dataset.spread===settings.spread));
 $('#oauth-client-id').value=settings.clientId;
 updateStorage();
}
function saveSetting(key,value){settings[key]=value;localStorage.setItem(key==='spread'?'comics-spread':'folio-'+({'clientId':'client-id'}[key]||key),value);renderSettings();}
function renderDriveStatus(){
 const connected=!!state.token&&Date.now()<state.tokenExpiry;
 $('#drive-disconnected').classList.toggle('hidden',connected);
 $('#drive-connected').classList.toggle('hidden',!connected);
 $('#drive-connect-hint').textContent=settings.clientId?'Your Client ID is saved. Your Google account will ask for read-only permission.':'Set up a Google OAuth Client ID in Settings first.';
 if(connected&&!$('#drive-files').children.length)listDriveFolder();
}
function connectDrive(){
 if(!window.isSecureContext){toast('Google requires HTTPS or localhost. Use your trusted published site.');return;}
 if(state.token&&Date.now()<state.tokenExpiry){switchView('drive');return;}
 if(!settings.clientId){switchView('settings');toast('Save a Google OAuth Client ID first.');return;}
 if(!window.google||!google.accounts||!google.accounts.oauth2){toast('Google sign-in could not load. Check your connection.');return;}
 try{
  const attempt=++state.connectAttempt;
  const client=google.accounts.oauth2.initTokenClient({client_id:settings.clientId,scope:DRIVE_SCOPE,include_granted_scopes:false,callback:(response)=>{
   if(attempt!==state.connectAttempt)return;
   if(response.error){toast('Google authorization failed: '+response.error);return;}
   const grants=String(response.scope||'').split(/\s+/);
   if(!response.access_token || !grants.includes(DRIVE_SCOPE)){
    toast('Google did not grant the required read-only access.');return;
   }
   state.token=response.access_token;state.tokenExpiry=Date.now()+Math.max(0,Number(response.expires_in||3600)-90)*1000;
   state.driveStack=[{id:'root',name:'My Drive'}];$('#drive-files').innerHTML='';renderDriveStatus();renderLibrary();
  },error_callback:(error)=>toast('Could not finish Google sign-in: '+(error.type||'popup blocked'))});
  client.requestAccessToken({prompt:'consent'});
 }catch(e){toast('Could not open Google sign-in: '+e.message);}
}
function disconnectDrive(){
 state.connectAttempt++;state.driveRequests.forEach(controller=>controller.abort());state.driveRequests.clear();
 if(state.token&&window.google&&google.accounts&&google.accounts.oauth2){try{google.accounts.oauth2.revoke(state.token,()=>{});}catch(e){}}
 state.token=null;state.tokenExpiry=0;$('#drive-files').innerHTML='';state.driveStack=[{id:'root',name:'My Drive'}];renderDriveStatus();renderLibrary();toast('Disconnected from Google Drive.');
}
async function driveRequest(url,range){
 if(!state.token||Date.now()>=state.tokenExpiry){state.token=null;renderDriveStatus();throw new Error('Google authorization expired. Connect again.');}
 const target=new URL(url);
 if(target.origin!=='https://www.googleapis.com'||!/^\/drive\/v3\/files(?:\/[^/]+)?$/.test(target.pathname))
  throw new Error('Blocked an unexpected Drive request URL.');
 const controller=new AbortController();state.driveRequests.add(controller);
 try{
  const headers={Authorization:'Bearer '+state.token};
  if(range){if(!Number.isSafeInteger(range.start)||!Number.isSafeInteger(range.end)||range.start<0||range.end<=range.start)
   throw new Error('Invalid requested file range.');
   headers.Range='bytes='+range.start+'-'+(range.end-1);
  }
  const response=await fetch(target.href,{method:'GET',headers,credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',redirect:'error',mode:'cors',signal:controller.signal});
  if(response.status===401){state.token=null;renderDriveStatus();throw new Error('Google authorization expired. Connect again.');}
  if(range&&response.status===200){await response.body?.cancel().catch(()=>{});throw new Error('Google Drive did not honor byte-range streaming. Large file was not downloaded.');}
  if(range&&response.status!==206){throw new Error('Drive range request failed (HTTP '+response.status+').');}
  if(!response.ok){let msg='Drive request failed ('+response.status+').';try{const body=await response.json();msg=body.error?.message||msg;}catch(e){}throw new Error(msg);}
  if(range){
   const declared=response.headers.get('Content-Range');
   if(declared){const match=declared.match(/^bytes (\d+)-(\d+)\/(\d+|\*)$/);
    if(!match||Number(match[1])!==range.start||Number(match[2])!==range.end-1)throw new Error('Drive returned an unexpected range.');
   }
   return new Uint8Array(await response.arrayBuffer());
  }
  return response;
 }finally{state.driveRequests.delete(controller);}
}
async function listDriveFolder(){
 const folder=state.driveStack[state.driveStack.length-1];
 $('#drive-files').innerHTML='<div class="drive-empty">Looking inside this folder…</div>';
 $('#drive-empty').classList.add('hidden');
 $('#drive-path').innerHTML=state.driveStack.map((entry,i)=>`<button class="path-item" data-path="${i}">${escapeHTML(entry.name)}</button>`).join('');
 try{
  const files=[];let pageToken='';
  do{
   const q=`'${folder.id.replace(/'/g,"\\'")}' in parents and trashed = false`;
   const params=new URLSearchParams({q,fields:'nextPageToken,files(id,name,mimeType,size,modifiedTime)',pageSize:'1000',orderBy:'name',spaces:'drive'});
   if(pageToken)params.set('pageToken',pageToken);
   const response=await driveRequest('https://www.googleapis.com/drive/v3/files?'+params.toString());
   const body=await response.json();files.push(...(body.files||[]));pageToken=body.nextPageToken||'';
  }while(pageToken);
  const shown=files.filter(f=>f.mimeType===MIME_FOLDER||ARCHIVE.test(f.name)).sort((a,b)=> (a.mimeType===MIME_FOLDER?0:1)-(b.mimeType===MIME_FOLDER?0:1)||a.name.localeCompare(b.name,undefined,{numeric:true}));
  state.driveFiles=new Map(shown.filter(f=>f.mimeType!==MIME_FOLDER).map(f=>[f.id,f]));
  $('#drive-files').innerHTML=shown.map(f=>{
   const isFolder=f.mimeType===MIME_FOLDER;
   return `<button class="drive-file" data-drive-id="${escapeHTML(f.id)}" data-drive-name="${escapeHTML(f.name)}" data-folder="${isFolder}"><span class="drive-file-symbol">${isFolder?'▤':'▣'}</span><span class="drive-file-info"><b>${escapeHTML(f.name)}</b><small>${isFolder?'Folder · tap to browse':sizeLabel(Number(f.size)||0)+' · stream to read'}</small></span><span class="drive-file-action">${isFolder?'›':'↓'}</span></button>`;
  }).join('');
  $('#drive-empty').classList.toggle('hidden',shown.length>0);
 }catch(e){$('#drive-files').innerHTML='';state.driveFiles.clear();toast(e.message||'Unable to browse Drive.');}
}
async function downloadDriveFile(id,name){
 try{
  const old=state.books.find(b=>b.driveId===id);if(old){await openReader(old.id);return;}
  const info=state.driveFiles.get(id);if(!info)throw new Error('Drive file metadata is unavailable. Refresh this folder.');
  const size=Number(info.size);
  if(!Number.isSafeInteger(size)||size>ComicsZip.LIMIT)throw new Error('Comics supports Drive files up to 3 GiB.');
  await addComic(sourceForDrive(id,size),name,'drive',id,true);
 }catch(e){idle();toast(e.message||'Could not open the Drive comic.');}
}
// Reader keeps only a small sliding cache of decompressed page images.
function spreadSize(r){
 return settings.spread==='two'?2:settings.spread==='auto'&&window.innerWidth>=640?2:1;
}
function alignPage(r,page){const n=spreadSize(r);return Math.min(r.paths.length-1,Math.floor(Math.max(0,page)/n)*n);}
function indicesFor(r,page){const n=spreadSize(r);return Array.from({length:n},(_,i)=>page+i).filter(i=>i>=0&&i<r.paths.length);}
async function pageURL(r,index){
 if(index<0||index>=r.paths.length)return null;
 if(r.cache.has(index))return r.cache.get(index);
 if(r.pending.has(index))return r.pending.get(index);
 const promise=(async()=>{
  const blob=await r.archive.page(index);
  if(r.destroyed)throw new Error('Reader closed.');
  const url=URL.createObjectURL(blob);r.cache.set(index,url);r.pageSizes.set(index,blob.size);r.pending.delete(index);return url;
 })().catch(err=>{r.pending.delete(index);throw err;});
 r.pending.set(index,promise);return promise;
}
function pruneCache(r){
 const active=new Set(indicesFor(r,r.page));let kept=0;
 for(const idx of active)kept+=r.pageSizes.get(idx)||0;
 const extras=Array.from(r.cache.keys()).filter(idx=>!active.has(idx)).sort((a,b)=>Math.abs(a-r.page)-Math.abs(b-r.page));
 for(const index of extras){const bytes=r.pageSizes.get(index)||0;
  if(kept+bytes<=64*1024*1024){kept+=bytes;continue;}
  URL.revokeObjectURL(r.cache.get(index));r.cache.delete(index);r.pageSizes.delete(index);
 }
}
function preloadAround(r){const currentBytes=Array.from(r.pageSizes?.values()||[]).reduce((a,b)=>a+b,0);if(currentBytes>32*1024*1024)return;const next=r.page+spreadSize(r);indicesFor(r,next).forEach(i=>pageURL(r,i).catch(()=>{}));}
function renderSpread(layer,urls){
 const isTwo=spreadSize(state.reader)===2;
 layer.classList.toggle('two-page',isTwo);
 const ids=layer.id==='reader-over'?['#reader-over-img','#reader-over-img2']:['#reader-under-img','#reader-under-img2'];
 const order=isTwo&&settings.direction==='rtl'?(urls.length===1?[null,urls[0]]:[...urls].reverse()):urls;
 ids.forEach((selector,i)=>{
  const img=$(selector);const url=order[i];
  if(url){img.src=url;img.classList.remove('empty-page');}
  else{img.removeAttribute('src');img.classList.add('empty-page');}
 });
}
async function spreadURLs(r,page){return Promise.all(indicesFor(r,page).map(i=>pageURL(r,i)));}
function resetPageLayers(){
 const over=$('#reader-over'),under=$('#reader-under');
 [over,under].forEach(layer=>{layer.style.transition='none';layer.style.transform='none';layer.style.transformOrigin='center center';layer.style.boxShadow='none';layer.style.zIndex='1';layer.classList.remove('fit-width','zoomed');});
 over.style.visibility='visible';over.style.zIndex='2';under.style.visibility='hidden';
 over.classList.toggle('fit-width',settings.fit==='width');
}
function updateReaderStatus(r){
 const final=Math.min(r.page+spreadSize(r),r.paths.length);
 $('#reader-page-label').textContent=(r.page+1)+(final>r.page+1?'–'+final:'')+' / '+r.paths.length;
 $('#reader-percent').textContent=Math.round(final/r.paths.length*100)+'% read';
 $('#reader-slider').max=String(r.paths.length);
 $('#reader-slider').value=String(r.page+1);
 $('#reader-gesture-hint').textContent=(spreadSize(r)===2?'Two-page spread · ':'')+(settings.transition==='curl'?'Page turn':'Swipe to turn')+' · Double tap to zoom';
 $('#reader-chapter').textContent=spreadSize(r)===2?'Two-page spread':'Single-page view';
}
async function commitPage(r,index){
 if(state.reader!==r)return;
 const next=alignPage(r,index);const urls=await spreadURLs(r,next);
 if(state.reader!==r)return;
 r.page=next;r.zoom=1;r.panX=0;r.panY=0;
 resetPageLayers();renderSpread($('#reader-over'),urls);
 $('#reader-over-content').style.transform='none';
 const lastVisible=Math.min(next+spreadSize(r),r.paths.length)-1;
 const priorLastPage=r.book.lastPage;
 if(priorLastPage<0&&!r.book.startedAt)r.book.startedAt=Date.now();
 if(lastVisible>=r.paths.length-1&&priorLastPage<r.paths.length-1&&!r.book.finishedAt)r.book.finishedAt=Date.now();
 r.book.lastPage=Math.max(priorLastPage,lastVisible);
 r.book.currentPage=next;
 await idb('put','books',r.book).catch(()=>{});
 updateReaderStatus(r);pruneCache(r);preloadAround(r);
}
async function openReader(id){
 const book=state.books.find(x=>x.id===id);if(!book)return;
 let source;
 if(book.origin==='drive-stream'){
  if(!state.token||Date.now()>=state.tokenExpiry){switchView('drive');toast('Connect Google Drive again to stream this comic.');return;}
  source=sourceForDrive(book.driveId,book.size);
 }else if(book.origin==='local-stream'){
  const file=state.sessionFiles.get(id);
  if(!file){state.relinkId=id;$('#local-picker').click();toast('Select the original comic again to resume reading.');return;}
  source=ComicsZip.sourceFromBlob(file);
 }else{
  const stored=await idb('get','archives',id);
  if(!stored||!stored.blob){toast('Comic is missing from local storage.');return;}
  source=ComicsZip.sourceFromBlob(stored.blob);
 }
 busy('Opening '+book.name,'Reading comic index');
 try{
  const archive=await ComicsZip.open(source),paths=archive.entries.map(e=>e.name);
  if(state.reader)closeReader();
  const r={id,book,archive,paths,page:0,cache:new Map(),pageSizes:new Map(),pending:new Map(),busy:false,gesture:null,zoom:1,panX:0,panY:0,lastTap:0};
  state.reader=r;$('#reader-title').textContent=book.name;$('#reader').classList.remove('hidden','ui-hidden');document.body.style.overflow='hidden';
  await commitPage(r,book.currentPage??Math.max(0,book.lastPage));
 }catch(e){closeReader();toast(e.message||'Unable to open comic.');}finally{idle();}
}
function closeReader(){
 const r=state.reader;if(!r)return;r.destroyed=true;state.reader=null;
 r.cache.forEach(url=>URL.revokeObjectURL(url));r.cache.clear();r.pageSizes.clear();
 $('#reader').classList.add('hidden');document.body.style.overflow='';
 ['#reader-over-img','#reader-over-img2','#reader-under-img','#reader-under-img2'].forEach(sel=>$(sel).removeAttribute('src'));
 reloadBooks().catch(()=>{});
}
function movementSign(step){return (step===1?-1:1)*(settings.direction==='rtl'?-1:1);}
async function setupTransition(r,step){
 const stride=spreadSize(r),target=r.page+step*stride;
 if(target<0||target>=r.paths.length)return false;
 const [currentURLs,targetURLs]=await Promise.all([spreadURLs(r,r.page),spreadURLs(r,target)]);
 if(state.reader!==r)return false;
 const over=$('#reader-over'),under=$('#reader-under'),sign=movementSign(step);
 resetPageLayers();under.style.visibility='visible';
 if(sign<0){renderSpread(over,currentURLs);renderSpread(under,targetURLs);over.style.zIndex='2';under.style.zIndex='1';}
 else{renderSpread(over,targetURLs);renderSpread(under,currentURLs);over.style.zIndex='2';under.style.zIndex='1';}
 if(settings.fit==='width'){over.classList.add('fit-width');under.classList.add('fit-width');}
 r.transitionStep=step;r.transitionSign=sign;renderTransitionProgress(r,0,false);return true;
}
function renderTransitionProgress(r,p,animate){
 p=Math.min(1,Math.max(0,p));
 const sign=r.transitionSign,over=$('#reader-over'),under=$('#reader-under');
 const duration=animate?'270ms cubic-bezier(.23,.9,.26,1)':'none';
 over.style.transition='transform '+duration+',box-shadow '+duration;
 under.style.transition='transform '+duration;
 if(settings.transition==='curl'){
  if(sign<0){over.style.transformOrigin='left center';over.style.transform=`rotateY(${-p*98}deg)`;under.style.transform=`scale(${.97+.03*p})`;}
  else{over.style.transformOrigin='left center';over.style.transform=`rotateY(${(-1+p)*98}deg)`;under.style.transform='scale(1)';}
  over.style.boxShadow=`${sign<0?1:-1}0px 0 36px rgba(0,0,0,${.14+.32*p})`;
 }else{
  if(sign<0){over.style.transform=`translate3d(${-100*p}%,0,0)`;under.style.transform=`translate3d(${100*(1-p)}%,0,0)`;}
  else{over.style.transform=`translate3d(${-100*(1-p)}%,0,0)`;under.style.transform='translate3d(0,0,0)';}
 }
}
async function turnPage(step){
 const r=state.reader;if(!r||r.busy||r.zoom>1)return;
 const target=r.page+step*spreadSize(r);
 if(target<0||target>=r.paths.length){toast(step>0?'End of comic.':'Beginning of comic.');return;}
 r.busy=true;
 try{
  if(!await setupTransition(r,step))return;
  requestAnimationFrame(()=>requestAnimationFrame(()=>renderTransitionProgress(r,1,true)));
  await new Promise(resolve=>setTimeout(resolve,310));
  await commitPage(r,target);
 }catch(e){toast('Page could not be loaded.');}finally{r.busy=false;}
}
function applyZoom(r){$('#reader-over-content').style.transform=`translate(${r.panX}px,${r.panY}px) scale(${r.zoom})`;}
function toggleZoom(){const r=state.reader;if(!r||r.busy)return;r.zoom=r.zoom>1?1:2;r.panX=0;r.panY=0;applyZoom(r);toast(r.zoom>1?'Zoomed in · drag to move':'Fit to page');}
function handleStageStart(event){
 const r=state.reader;if(!r||r.busy)return;
 if(event.touches.length===2){const a=event.touches[0],b=event.touches[1];r.gesture={pinch:true,dist:Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY),zoom:r.zoom};return;}
 if(event.touches.length!==1)return;
 const t=event.touches[0];r.gesture={x:t.clientX,y:t.clientY,lastX:t.clientX,lastY:t.clientY,start:Date.now(),dragging:false,prepared:false,preparing:false,step:0,p:0,panStartX:r.panX,panStartY:r.panY};
}
function handleStageMove(event){
 const r=state.reader,g=r&&r.gesture;if(!r||!g||r.busy)return;
 if(g.pinch&&event.touches.length===2){event.preventDefault();const a=event.touches[0],b=event.touches[1];r.zoom=Math.min(3,Math.max(1,g.zoom*Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY)/g.dist));if(r.zoom<=1.01){r.zoom=1;r.panX=0;r.panY=0;}applyZoom(r);return;}
 if(event.touches.length!==1||g.pinch)return;
 const t=event.touches[0],dx=t.clientX-g.x,dy=t.clientY-g.y;
 g.lastX=t.clientX;g.lastY=t.clientY;
 if(r.zoom>1){event.preventDefault();if(Math.abs(dx)>8||Math.abs(dy)>8)g.dragging=true;r.panX=g.panStartX+dx;r.panY=g.panStartY+dy;applyZoom(r);return;}
 if(!g.dragging){if(Math.abs(dx)<12&&Math.abs(dy)<12)return;if(Math.abs(dy)>Math.abs(dx)){r.gesture=null;return;}g.dragging=true;}
 event.preventDefault();
 const physicalSign=dx<0?-1:1;g.step=physicalSign===-1?1:-1;if(settings.direction==='rtl')g.step*=-1;
 g.p=Math.min(1,Math.abs(dx)/Math.max(1,$('#reader-stage').clientWidth));
 if(r.page+g.step*spreadSize(r)<0||r.page+g.step*spreadSize(r)>=r.paths.length)return;
 if(!g.prepared&&!g.preparing){g.preparing=true;setupTransition(r,g.step).then(ok=>{g.prepared=ok;g.preparing=false;if(ok&&r.gesture===g)renderTransitionProgress(r,g.p,false);}).catch(()=>{g.preparing=false;});}
 else if(g.prepared)renderTransitionProgress(r,g.p,false);
}
async function handleStageEnd(event){
 const r=state.reader,g=r&&r.gesture;if(!r||!g||r.busy)return;r.gesture=null;
 if(g.pinch){if(r.zoom<=1.05){r.zoom=1;r.panX=0;r.panY=0;applyZoom(r);}return;}
 if(r.zoom>1){const now=Date.now();if(!g.dragging&&now-r.lastTap<300){r.lastTap=0;toggleZoom();}else if(!g.dragging)r.lastTap=now;return;}
 if(g.dragging){
  const width=$('#reader-stage').clientWidth,dx=g.lastX-g.x,elapsed=Date.now()-g.start;
  const commit=Math.abs(dx)>width*.26||(elapsed<250&&Math.abs(dx)>width*.10);
  if(!commit||r.page+g.step*spreadSize(r)<0||r.page+g.step*spreadSize(r)>=r.paths.length){
   if(g.prepared){renderTransitionProgress(r,0,true);setTimeout(()=>{if(state.reader===r&&!r.busy)resetPageLayers();},310);}return;
  }
  r.busy=true;
  try{
   if(!g.prepared)await setupTransition(r,g.step);
   renderTransitionProgress(r,1,true);await new Promise(resolve=>setTimeout(resolve,310));
   await commitPage(r,r.page+g.step*spreadSize(r));
  }catch(e){toast('Page could not be turned.');}finally{r.busy=false;}
  return;
 }
 const now=Date.now();if(now-r.lastTap<280){r.lastTap=0;toggleZoom();return;}r.lastTap=now;
 const x=g.x/window.innerWidth;
 if(x>.31&&x<.69){$('#reader').classList.toggle('ui-hidden');return;}
 const side=x<.31?-1:1,step=side*(settings.direction==='rtl'?-1:1);
 turnPage(step);
}
async function clearFinished(){
 const done=state.books.filter(hasRead);
 if(!done.length){toast('No finished comics to remove.');return;}
 if(!confirm('Remove '+done.length+' finished comic(s) from this device? Originals in Google Drive stay untouched.'))return;
 for(const b of done){state.sessionFiles.delete(b.id);await idb('delete','books',b.id);await idb('delete','archives',b.id);}
 await reloadBooks();toast('Cleaned up '+done.length+' comics.');
}
function bindEvents(){
 $$('.nav-item').forEach(el=>el.addEventListener('click',()=>switchView(el.dataset.view)));
 $('#settings-shortcut').addEventListener('click',()=>switchView('settings'));
 $('#drive-banner-button').addEventListener('click',()=>switchView('drive'));
 $('#library-search').addEventListener('input',e=>{state.query=e.target.value.toLowerCase().trim();renderLibrary();});
 $$('.chip').forEach(el=>el.addEventListener('click',()=>{state.filter=el.dataset.filter;renderLibrary();}));
 $$('.add-button, label[for="local-picker"]').forEach(el=>el.addEventListener('click',()=>{state.relinkId=null;}));
 $('#local-picker').addEventListener('change',e=>{importLocalFiles(e.target.files).catch(err=>toast(err.message));e.target.value='';});
 $('#library-grid').addEventListener('click',e=>{
  const del=e.target.closest('[data-delete]');if(del){deleteBook(del.dataset.delete).catch(err=>toast(err.message));return;}
  const details=e.target.closest('[data-details]');if(details){openDetails(details.dataset.details);return;}
  const open=e.target.closest('[data-open]');if(open)openReader(open.dataset.open);
 });
 $('#up-next-list').addEventListener('click',e=>{const next=e.target.closest('[data-next]');if(next)openReader(next.dataset.next);});
 $('#details-close').addEventListener('click',closeDetails);
 $('#details-backdrop').addEventListener('click',closeDetails);
 $('#details-save').addEventListener('click',()=>saveDetails().catch(e=>toast(e.message)));
 $('#details-mark-read').addEventListener('click',()=>markFinishedToday().catch(e=>toast(e.message)));
 $('#details-reset').addEventListener('click',()=>resetReadingProgress().catch(e=>toast(e.message)));
 $('#load-demo-empty').addEventListener('click',loadDemo);
 $('#connect-drive').addEventListener('click',connectDrive);
 $('#disconnect-drive').addEventListener('click',disconnectDrive);
 $('#drive-path').addEventListener('click',e=>{const el=e.target.closest('[data-path]');if(!el)return;state.driveStack=state.driveStack.slice(0,Number(el.dataset.path)+1);listDriveFolder();});
 $('#drive-files').addEventListener('click',e=>{const el=e.target.closest('[data-drive-id]');if(!el)return;if(el.dataset.folder==='true'){state.driveStack.push({id:el.dataset.driveId,name:el.dataset.driveName});listDriveFolder();}else downloadDriveFile(el.dataset.driveId,el.dataset.driveName);});
 $('#transition-options').addEventListener('click',e=>{if(e.target.dataset.transition)saveSetting('transition',e.target.dataset.transition);});
 $('#direction-options').addEventListener('click',e=>{if(e.target.dataset.direction)saveSetting('direction',e.target.dataset.direction);});
 $('#fit-options').addEventListener('click',e=>{if(e.target.dataset.fit)saveSetting('fit',e.target.dataset.fit);});
 $('#spread-options').addEventListener('click',e=>{const mode=e.target.dataset.spread;if(!mode)return;saveSetting('spread',mode);const r=state.reader;if(r)commitPage(r,r.page).catch(err=>toast(err.message));});
 window.addEventListener('resize',()=>{const r=state.reader;if(r&&!r.busy&&settings.spread==='auto')commitPage(r,r.page).catch(()=>{});});
 $('#save-client').addEventListener('click',()=>{const v=$('#oauth-client-id').value.trim();if(v&&!/^\d+[-\w]+\.apps\.googleusercontent\.com$/.test(v)){toast('That does not look like a Google Web OAuth Client ID.');return;}if(v!==settings.clientId)disconnectDrive();saveSetting('clientId',v);toast('Client ID saved on this device.');});
 $('#remove-finished').addEventListener('click',clearFinished);
 $('#close-reader').addEventListener('click',closeReader);
 $('#reader-menu').addEventListener('click',()=>{const mode=settings.spread==='single'?'two':'single';saveSetting('spread',mode);toast(mode==='two'?'Two-page spread':'Single-page view');if(state.reader)commitPage(state.reader,state.reader.page).catch(err=>toast(err.message));});
 $('#reader-slider').addEventListener('change',e=>{const r=state.reader;if(!r||r.busy)return;r.busy=true;commitPage(r,Number(e.target.value)-1).catch(err=>toast(err.message)).finally(()=>{r.busy=false;});});
 const stage=$('#reader-stage');stage.addEventListener('touchstart',handleStageStart,{passive:true});stage.addEventListener('touchmove',handleStageMove,{passive:false});stage.addEventListener('touchend',handleStageEnd,{passive:true});stage.addEventListener('touchcancel',()=>{if(state.reader){state.reader.gesture=null;resetPageLayers();}},{passive:true});
 stage.addEventListener('click',e=>{if('ontouchstart' in window)return;const r=state.reader;if(!r)return;const x=e.clientX/window.innerWidth;if(x>.32&&x<.68)$('#reader').classList.toggle('ui-hidden');else turnPage((x<.32?-1:1)*(settings.direction==='rtl'?-1:1));});
 stage.addEventListener('dblclick',e=>{e.preventDefault();toggleZoom();});
 document.addEventListener('keydown',e=>{if(e.key==='Escape'&&state.detailsId){closeDetails();return;}if(!state.reader)return;if(e.key==='Escape'){closeReader();return;}if(e.key==='ArrowRight'||e.key==='ArrowLeft'){e.preventDefault();turnPage((e.key==='ArrowRight'?1:-1)*(settings.direction==='rtl'?-1:1));}});
}
async function init(){
 bindEvents();renderSettings();renderDriveStatus();
 try{state.db=await openDatabase();await reloadBooks();}catch(e){toast('Local storage is unavailable. Open this site in Safari, not Private Browsing.');}
 if('serviceWorker' in navigator&&location.protocol==='https:')navigator.serviceWorker.register('./service-worker.js').catch(()=>{});
}
init();
