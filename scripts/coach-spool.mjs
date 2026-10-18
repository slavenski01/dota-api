// Runs inside the worker container; fixed operations, no model-generated commands.
import {readdir,mkdir,open,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {coachBridgeRoot,atomicCoachFile,readCoachFile} from '@dota/jobs';
const root=coachBridgeRoot();await mkdir(root,{recursive:true,mode:0o700});
const [action,id]=process.argv.slice(2);
if(action==='next'&&!id){
  let found=null;
  for(const name of (await readdir(root)).filter(n=>/^[a-f0-9-]{36}\.request\.json$/.test(n)).sort()){
    const key=name.slice(0,36),result=join(root,`${key}.result.json`);
    if(await stat(result).catch(()=>null))continue;
    const request=await readCoachFile(join(root,name),160*1024);
    if(request.expiresAt<Date.now()){await atomicCoachFile(result,{error:'coach_request_expired'});continue;}
    const claim=await open(join(root,`${key}.claim`),'wx',0o600).catch(e=>{if(e.code==='EEXIST')return null;throw e;});
    if(!claim)continue;
    await claim.writeFile('docker-host');await claim.close();found=request;break;
  }
  console.log(JSON.stringify(found));
}else if(action==='complete'&&/^[a-f0-9-]{36}$/.test(id)){
  let size=0;const chunks=[];for await(const chunk of process.stdin){size+=chunk.length;if(size>64*1024)throw Error('result_limit');chunks.push(chunk);}
  const request=await readCoachFile(join(root,`${id}.request.json`),160*1024);
  if(request.id!==id)throw Error('request_mismatch');
  if(!await stat(join(root,`${id}.result.json`)).catch(()=>null))await atomicCoachFile(join(root,`${id}.result.json`),JSON.parse(Buffer.concat(chunks).toString('utf8')));
  console.log('{}');
}else throw Error('invalid_spool_operation');
