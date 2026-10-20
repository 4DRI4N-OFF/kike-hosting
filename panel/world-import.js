'use strict';
// ZIP import: no shell extraction, bounded streams, no symlinks or ZIP64.
const fs=require('fs'),p=fs.promises,path=require('path'),zlib=require('zlib');
const {pipeline}=require('stream/promises');const {Transform}=require('stream');
const MAX_ZIP=2*1024**3,MAX_EXPANDED=8*1024**3,MAX_FILES=100000;
const table=Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
function fail(s){throw new Error(s);}
async function read(h,n,pos){const b=Buffer.alloc(n);if((await h.read(b,0,n,pos)).bytesRead!==n)fail('ZIP incompleto o dañado.');return b;}
function safe(n){
 if(!n||n.includes('\\')||n.startsWith('/')||/[\x00-\x1f:]/.test(n))fail('El ZIP contiene una ruta no segura.');
 const a=n.replace(/\/$/,'').split('/');
 if(a.some(s=>!s||s==='.'||s==='..'||/[. ]$/.test(s)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(s)))fail('El ZIP contiene una ruta no segura para Windows.');
 return n;
}
async function inspect(file){
 const h=await p.open(file,'r');try{
 const size=(await h.stat()).size;if(size>MAX_ZIP||size<22)fail('ZIP no válido o mayor de 2 GiB.');
 const tail=await read(h,Math.min(size,65557),size-Math.min(size,65557));let end=-1;
 for(let i=tail.length-22;i>=0;i--)if(tail.readUInt32LE(i)===0x06054b50&&i+22+tail.readUInt16LE(i+20)===tail.length){end=i;break;}
 if(end<0)fail('No se encuentra el índice del ZIP.');
 const n=tail.readUInt16LE(end+10),len=tail.readUInt32LE(end+12),off=tail.readUInt32LE(end+16);
 if(tail.readUInt16LE(end+4)||tail.readUInt16LE(end+6)||n!==tail.readUInt16LE(end+8)||n===65535||off===0xffffffff||len===0xffffffff)fail('ZIP64 y ZIP dividido no son compatibles. Usa ZIP estándar (máximo 2 GiB).');
 if(!n||n>MAX_FILES||len>32*1024**2||off+len>size-tail.length+end)fail('Índice ZIP no válido o demasiado grande.');
 const b=await read(h,len,off),entries=[],seen=new Set();let i=0,total=0;
 for(let k=0;k<n;k++){
 if(i+46>b.length||b.readUInt32LE(i)!==0x02014b50)fail('Índice ZIP dañado.');
 const flags=b.readUInt16LE(i+8),method=b.readUInt16LE(i+10),crc=b.readUInt32LE(i+16),compressed=b.readUInt32LE(i+20),size=b.readUInt32LE(i+24),nl=b.readUInt16LE(i+28),el=b.readUInt16LE(i+30),cl=b.readUInt16LE(i+32),attrs=b.readUInt32LE(i+38),local=b.readUInt32LE(i+42);
 if(i+46+nl+el+cl>b.length)fail('Índice ZIP incompleto.');
 const name=safe(b.subarray(i+46,i+46+nl).toString('utf8'));i+=46+nl+el+cl;
 if(flags&1||![0,8].includes(method)||size===0xffffffff||compressed===0xffffffff||local===0xffffffff||![0,0x8000,0x4000].includes((attrs>>>16)&0xf000))fail('ZIP cifrado, enlace o formato no compatible.');
 const key=name.replace(/\/$/,'').toLowerCase();if(seen.has(key))fail('El ZIP contiene rutas duplicadas.');seen.add(key);
 total+=size;if(total>MAX_EXPANDED)fail('El mundo supera 8 GiB descomprimidos.');
 if(!name.endsWith('/')&&size>0&&!compressed)fail('Entrada ZIP dañada.');
 entries.push({name,method,crc,compressed,size,local});
 }
 const levels=entries.filter(e=>e.name==='level.dat'||/^[^/]+\/level\.dat$/.test(e.name));
 if(levels.length!==1||!levels[0].size)fail('Debe haber un único level.dat en la raíz o dentro de una sola carpeta. Solo mundos Java Edition.');
 const root=levels[0].name.slice(0,-9);
 if(entries.some(e=>root&&e.name!==root&&!e.name.startsWith(root)))fail('El ZIP debe contener solo la carpeta del mundo.');
 return {entries:entries.filter(e=>e.name!==root),root,total,central:off};
 }finally{await h.close();}
}
async function extract(file,dest){
 const meta=await inspect(file),h=await p.open(file,'r');await p.mkdir(dest,{recursive:true});
 try{for(const e of meta.entries){
 const rel=e.name.slice(meta.root.length);if(!rel)continue;
 const target=path.join(dest,rel);if(!target.startsWith(path.resolve(dest)+path.sep))fail('Ruta fuera del destino.');
 if(e.name.endsWith('/')){await p.mkdir(target,{recursive:true});continue;}
 const b=await read(h,30,e.local);if(b.readUInt32LE(0)!==0x04034b50)fail('Cabecera ZIP dañada.');
 const nl=b.readUInt16LE(26),el=b.readUInt16LE(28),raw=await read(h,nl,e.local+30);
 if(raw.toString('utf8')!==e.name||b.readUInt16LE(8)!==e.method||(b.readUInt16LE(6)&1))fail('Cabecera ZIP inconsistente.');
 const start=e.local+30+nl+el;if(start+e.compressed>meta.central)fail('Datos ZIP fuera de límites.');
 await p.mkdir(path.dirname(target),{recursive:true});let count=0,crc=0xffffffff;
 const check=new Transform({transform(chunk,enc,cb){count+=chunk.length;if(count>e.size)return cb(new Error('Tamaño descomprimido no válido.'));for(const c of chunk)crc=table[(crc^c)&255]^(crc>>>8);cb(null,chunk);}});
 if(e.compressed){const src=fs.createReadStream(file,{start,end:start+e.compressed-1});await pipeline(...(e.method===8?[src,zlib.createInflateRaw(),check,fs.createWriteStream(target,{flags:'wx'})]:[src,check,fs.createWriteStream(target,{flags:'wx'})]));}
 else await p.writeFile(target,Buffer.alloc(0),{flag:'wx'});
 if(count!==e.size||((crc^0xffffffff)>>>0)!==e.crc)fail('La integridad del ZIP no es correcta (CRC).');
 }
 await p.rm(path.join(dest,'session.lock'),{force:true});return meta;
 }finally{await h.close();}
}
async function receive(req,file){
 const len=Number(req.headers['content-length']);if(!Number.isSafeInteger(len)||len<=0||len>MAX_ZIP)fail('Selecciona un ZIP de hasta 2 GiB.');
 let count=0;await pipeline(req,new Transform({transform(c,e,cb){count+=c.length;cb(count>MAX_ZIP?new Error('El ZIP supera 2 GiB.'):null,c);}}),fs.createWriteStream(file,{flags:'wx'}));if(count!==len)fail('La subida quedó incompleta.');
}
module.exports={extract,inspect,receive};
