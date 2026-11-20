/* Comics CBR reader: RAR4/RAR5 via pinned libarchive.js 2.0.2, decoded in a Web Worker.
   Unlike ZIP, this WASM implementation loads the source archive into memory.
   Keep a conservative limit for older iPhones. No third-party account or uploads. */
'use strict';
(function(root){
 const LIMIT = 128 * 1024 * 1024;
 const PAGE_LIMIT = 48 * 1024 * 1024;
 const MAX_ENTRIES = 10000;
 const IMAGE = /\.(jpe?g|png|webp|gif)$/i;
 const MIME = {jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',gif:'image/gif'};
 const PREFIX = 'vendor/';
 let importPromise;
 function error(message){ throw new Error(message); }
 async function loadDecoder(){
   if(!importPromise)importPromise=import('./'+PREFIX+'libarchive.js').then(mod=>{
     mod.Archive.init({workerUrl:new URL(PREFIX+'worker-bundle.js',location.href).href});
     return mod.Archive;
   }).catch(err=>{importPromise=null;throw err;});
   return importPromise;
 }
 async function open(blob){
   if(!(blob instanceof Blob))error('CBR files from Drive must be selected through the iPhone Files app. Direct streaming supports CBZ.');
   if(blob.size>LIMIT)error('CBR files above 128 MiB cannot be safely decoded on this iPhone-compatible reader. Convert this archive to CBZ for large files.');
   if(blob.size<8)error('CBR archive is empty or damaged.');
   const sig=new Uint8Array(await blob.slice(0,8).arrayBuffer());
   const rar4=[0x52,0x61,0x72,0x21,0x1a,0x07,0x00];
   const rar5=[0x52,0x61,0x72,0x21,0x1a,0x07,0x01,0x00];
   const isRAR=rar4.every((n,i)=>n===sig[i])||rar5.every((n,i)=>n===sig[i]);
   if(!isRAR)error('This file is not a valid RAR/CBR archive.');
   let workerArchive;
   try{
     const Archive=await loadDecoder();
     workerArchive=await Archive.open(new File([blob], 'comic.cbr',{type:'application/vnd.rar'}));
     if(await workerArchive.hasEncryptedData())error('Password-protected CBR files are unsupported.');
     const all=await workerArchive.getFilesArray();
     if(all.length>MAX_ENTRIES)error('The CBR has too many entries.');
     const entries=all.filter(item=>{
       const name=item.file?.name||item.path||'';
       return IMAGE.test(name)&&name&&!name.includes('\\')&&!name.split('/').some(p=>p==='..'||p==='.')&&
         !/(^|\/)__MACOSX\//i.test(name)&&!/(^|\/)\./.test(name);
     }).map(item=>({name:item.path||item.file.name, file:item.file}));
     if(!entries.length)error('This CBR contains no supported image pages.');
     for(const e of entries){
       if(e.file.size>PAGE_LIMIT)error('A CBR page exceeds the 48 MiB safety limit.');
     }
     entries.sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true,sensitivity:'base'}));
     return {entries, async page(index){
       const entry=entries[index];if(!entry)error('Page not found.');
       const file=await entry.file.extract();
       if(file.size>PAGE_LIMIT)error('Decompressed CBR page is too large.');
       const ext=entry.name.split('.').pop().toLowerCase();
       return new Blob([file],{type:MIME[ext]});
     },async close(){await workerArchive.close();}};
   }catch(err){
     if(workerArchive)await workerArchive.close().catch(()=>{});
     throw err;
   }
 }
 root.ComicsRar={open,LIMIT,PAGE_LIMIT};
})(typeof window!=='undefined'?window:globalThis);
