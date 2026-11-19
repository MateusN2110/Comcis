/* Comics ZIP random-access reader. Reads directory & requested pages only; no full-archive unpacking.
   Supports classic ZIP and single-disk ZIP64 with stored or DEFLATE image entries. */
'use strict';
(function(root){
 const u16=(v,p)=>v.getUint16(p,true),u32=(v,p)=>v.getUint32(p,true);
 const SIG={local:0x04034b50,central:0x02014b50,end:0x06054b50,zip64:0x06064b50,locator:0x07064b50};
 const LIMIT=3*1024*1024*1024;
 const PAGE_LIMIT=48*1024*1024;
 const MAX_ENTRIES=10000;
 function error(message){throw new Error(message);}
 function safe64(view,pos){const n=view.getUint32(pos,true)+view.getUint32(pos+4,true)*4294967296;if(!Number.isSafeInteger(n))error('ZIP64 offset exceeds JavaScript precision.');return n;}
 function sourceFromBlob(blob){return {size:blob.size,async read(offset,length){
   if(!Number.isSafeInteger(offset)||!Number.isSafeInteger(length)||offset<0||length<0||offset+length>blob.size)error('ZIP read is out of bounds.');
   return new Uint8Array(await blob.slice(offset,offset+length).arrayBuffer());
 }};}
 function inspect(data){return new DataView(data.buffer,data.byteOffset,data.byteLength);}
 async function readExact(source,offset,length){
   if(!Number.isSafeInteger(offset)||!Number.isSafeInteger(length)||offset<0||length<0||offset+length>source.size)error('Corrupt ZIP offset or size.');
   const bytes=await source.read(offset,length);
   if(bytes.length!==length)error('Archive returned incomplete file data.');return bytes;
 }
 function findEnd(tail){const view=inspect(tail);for(let p=tail.length-22;p>=0;p--){
   if(u32(view,p)===SIG.end&&p+22+u16(view,p+20)<=tail.length)return p;
 }error('Could not find the end of this CBZ archive.');}
 function decodeName(raw,utf){try{return new TextDecoder(utf?'utf-8':'windows-1252').decode(raw);}catch(e){return new TextDecoder('utf-8').decode(raw);}}
 async function open(source){
   if(!source||!Number.isSafeInteger(source.size)||source.size<22||source.size>LIMIT)error('Comics supports CBZ archives up to 3 GiB.');
   const tailStart=Math.max(0,source.size-(65535+22+20+56));
   const tail=await readExact(source,tailStart,source.size-tailStart);
   const tailV=inspect(tail),e=findEnd(tail),eOffset=tailStart+e;
   if(u16(tailV,e+4)!==0||u16(tailV,e+6)!==0)error('Multi-volume ZIPs are not supported.');
   let count=u16(tailV,e+10),dirSize=u32(tailV,e+12),dirOffset=u32(tailV,e+16);
   if(count===0xffff||dirOffset===0xffffffff||dirSize===0xffffffff){
     if(eOffset<20)error('Invalid ZIP64 end locator.');
     const locator=await readExact(source,eOffset-20,20),lv=inspect(locator);
     if(u32(lv,0)!==SIG.locator||u32(lv,4)!==0||u32(lv,16)!==1)error('Unsupported multi-disk ZIP64 archive.');
     const end64Offset=safe64(lv,8),end64=inspect(await readExact(source,end64Offset,56));
     if(u32(end64,0)!==SIG.zip64||u32(end64,16)!==0||u32(end64,20)!==0)error('Invalid ZIP64 end record.');
     count=safe64(end64,32);dirSize=safe64(end64,40);dirOffset=safe64(end64,48);
   }
   if(count<1||count>MAX_ENTRIES||dirSize>4*1024*1024||dirOffset+dirSize>source.size)error('Archive index is unusually large or damaged.');
   const central=await readExact(source,dirOffset,dirSize),v=inspect(central),entries=[];
   let p=0;
   for(let i=0;i<count;i++){
     if(p+46>central.length||u32(v,p)!==SIG.central)error('Corrupted central directory.');
     const flags=u16(v,p+8),method=u16(v,p+10),compressed32=u32(v,p+20),uncompressed32=u32(v,p+24);
     const nameLength=u16(v,p+28),extraLength=u16(v,p+30),commentLength=u16(v,p+32);
     const diskStart=u16(v,p+34),local32=u32(v,p+42);
     const end=p+46+nameLength+extraLength+commentLength;
     if(end>central.length||diskStart!==0)error('Corrupt or multi-volume ZIP file.');
     const name=decodeName(central.subarray(p+46,p+46+nameLength),!!(flags&0x800));
     let compressed=compressed32,uncompressed=uncompressed32,localOffset=local32;
     let ep=p+46+nameLength;
     while(ep<p+46+nameLength+extraLength){
       if(ep+4>end)error('Invalid ZIP extra field.');
       const type=u16(v,ep),n=u16(v,ep+2);ep+=4;
       if(ep+n>p+46+nameLength+extraLength)error('Malformed ZIP extra field.');
       if(type===1){let k=ep;
         if(uncompressed32===0xffffffff){if(k+8>ep+n)error('Missing ZIP64 uncompressed length.');uncompressed=safe64(v,k);k+=8;}
         if(compressed32===0xffffffff){if(k+8>ep+n)error('Missing ZIP64 compressed length.');compressed=safe64(v,k);k+=8;}
         if(local32===0xffffffff){if(k+8>ep+n)error('Missing ZIP64 entry position.');localOffset=safe64(v,k);k+=8;}
       }
       ep+=n;
     }
     if(name&&!name.endsWith('/')&&!name.includes('\\')&&!name.split('/').some(part=>part==='..'||part==='.')&&
       /\.(jpe?g|png|webp|gif)$/i.test(name)&&!/(^|\/)__MACOSX\//i.test(name)&&!/(^|\/)\./.test(name)&&!(flags&1)&&
       (method===0||method===8)){
        if(compressed>PAGE_LIMIT||uncompressed>PAGE_LIMIT)error('A page exceeds the 48 MB per-page safety limit.');
        if(localOffset+30>source.size||compressed>source.size)error('Corrupt ZIP page length.');
        entries.push({name,localOffset,compressed,uncompressed,method,flags});
     }
     p=end;
   }
   if(!entries.length)error('No JPG, PNG, WebP or GIF pages found in this archive.');
   entries.sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true,sensitivity:'base'}));
   return {source,entries,async page(index){
     const info=entries[index];if(!info)error('No page at this position.');
     const head=inspect(await readExact(source,info.localOffset,30));
     if(u32(head,0)!==SIG.local||u16(head,8)!==info.method)error('Invalid ZIP page header.');
     const start=info.localOffset+30+u16(head,26)+u16(head,28);
     const compressed=await readExact(source,start,info.compressed);
     let parts,decodedLength;
     if(info.method===0){parts=[compressed];decodedLength=compressed.length;}
     else{
       // Use bounded incremental output so a forged ZIP directory cannot inflate a ZIP bomb in memory.
       const inflater=new root.pako.Inflate({raw:true,chunkSize:65536});
       parts=[];decodedLength=0;
       inflater.onData=function(chunk){
         decodedLength+=chunk.length;
         if(decodedLength>info.uncompressed||decodedLength>PAGE_LIMIT)error('ZIP page exceeds its declared safe size.');
         parts.push(chunk);
       };
       inflater.push(compressed,true);
       if(inflater.err)error('Could not decompress this ZIP page.');
     }
     if(decodedLength!==info.uncompressed)error('ZIP page decompression size mismatch.');
     return new Blob(parts,{type:({jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',gif:'image/gif'})[info.name.split('.').pop().toLowerCase()]});
   }};
 }
 root.ComicsZip={open,sourceFromBlob,LIMIT,PAGE_LIMIT};
})(typeof window!=='undefined'?window:globalThis);
