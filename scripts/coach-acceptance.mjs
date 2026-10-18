// Explicit live check, invoked only with authorization to send these contexts to Codex.
// Private inputs/reports remain in ignored data/e08-validation, never in the repository.
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
process.loadEnvFile();
const base=`http://127.0.0.1:${process.env.DOTA_PORT||3000}`,root=resolve('data/e08-validation');
await mkdir(root,{recursive:true,mode:0o700});
async function dockerScript(script) {
  const child=spawn('docker',['compose','exec','-T','worker','node','--input-type=module','-e',script],{stdio:['ignore','pipe','pipe'],env:process.env});
  let output='';child.stdout.on('data',b=>output+=b);child.stderr.resume();const [code]=await once(child,'close');if(code)throw Error('local_database_read_failed');return JSON.parse(output);
}
async function targets(){return dockerScript(`import {openDatabase} from '@dota/persistence';const p=openDatabase();try{console.log(JSON.stringify((await p.query("SELECT DISTINCT ON(a.match_id) a.id AS analysis_id,a.dataset_id,a.match_id,p.payload->>'accountId' AS account_id FROM dota.analysis_runs a JOIN dota.records p ON p.dataset_id=a.dataset_id AND p.kind='participant' AND p.player_slot=a.player_slot ORDER BY a.match_id,a.created_at DESC")).rows));}finally{await p.end();}`);}
async function json(path,body){const r=await fetch(base+path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw Error(`http_${r.status}:${data.error}`);return data;}
async function until(fn,timeout){const end=Date.now()+timeout;while(Date.now()<end){const result=await fn();if(result)return result;await delay(1000);}throw Error('acceptance_timeout');}
let selected=await targets();
if(selected.length<3){
  const path=resolve('data/replay-validation/2026-10-12-e01-t02/manifest.json'),m=JSON.parse(await readFile(path,'utf8'));
  const sample=m.records.find(r=>!selected.some(t=>t.match_id===String(r.matchId))&&r.status==='ready')??m.records.find(r=>!selected.some(t=>t.match_id===String(r.matchId)));
  if(!sample)throw Error('three_real_matches_required');
  const file=join(dirname(path),sample.replayFile),url=`/api/replays/${sample.matchId}?accountId=${m.accountId}`;
  const response=await fetch(base+url,{method:'POST',headers:{'Content-Type':'application/octet-stream','Content-Length':String((await stat(file)).size),Origin:base},body:createReadStream(file),duplex:'half'});
  if(!response.ok)throw Error('control_replay_import_failed');const job=await response.json();
  console.log('Imported local control replay; waiting for analysis.');
  await until(async()=>{const r=await json(`/api/jobs/${job.id}`);if(['failed','unavailable','cancelled'].includes(r.job.status))throw Error(`replay_${r.job.status}:${r.job.error?.code}`);return r.job.status==='ready';},300000);
  selected=await targets();
}
selected=selected.slice(0,3);
if(selected.length!==3)throw Error('three_real_matches_required');
await writeFile(join(root,'targets.json'),JSON.stringify(selected,null,2),{mode:0o600});
const summaries=[],reportIds=[];
for(let i=0;i<selected.length;i++){
  const t=selected[i],url=`/api/datasets/${t.dataset_id}/coach?${new URLSearchParams({accountId:t.account_id,analysisId:t.analysis_id})}`;
  const existing=(await json(url)).reports.find(r=>r.status==='ready'&&!r.stale);
  let report=existing;
  if(!report){
    const sent=await json(url,{requestKey:randomUUID(),settings:{role:null,goal:i===1?'objectives':'deaths_trades'}});
    console.log(`Control ${i+1}: coach queued.`);
    report=await until(async()=>{const r=(await json(url)).reports.find(r=>r.id===sent.id);if(r?.status==='failed')throw Error(`coach_${i+1}:${r.error}`);return r?.status==='ready'&&r;},250000);
  }
  await writeFile(join(root,`report-${i+1}.json`),JSON.stringify(report,null,2),{mode:0o600});
  reportIds.push(report.id);
  summaries.push({sample:i+1,status:report.status,episodes:report.output.episodes.length,durationMs:report.durationMs,usage:report.usage,model:report.model});
  console.log(JSON.stringify(summaries.at(-1)));
}
await writeFile(join(root,'summary.json'),JSON.stringify(summaries,null,2),{mode:0o600});
const audit=await dockerScript(`import {openDatabase} from '@dota/persistence';import {coachHash,validateCoachOutput} from '@dota/jobs';
const pool=openDatabase();try{const rows=(await pool.query('SELECT input,result FROM dota.coach_runs WHERE id=ANY($1::uuid[])',[${JSON.stringify(reportIds)}])).rows;let evidenceCount=0;
if(rows.length!==3)throw Error('reports_missing');for(const row of rows){validateCoachOutput(row.result.output,row.input);const context=row.input.context;
const records=(await pool.query('SELECT payload FROM dota.records WHERE dataset_id=$1 AND id=ANY($2::text[])',[context.datasetId,context.evidence.map(e=>e.id)])).rows;
for(const e of context.evidence){const r=records.find(r=>r.payload.id===e.id)?.payload;if(!r||r.matchId!==context.matchId||coachHash(r)!==e.sha256)throw Error('evidence_mismatch');evidenceCount++;}}
console.log(JSON.stringify({reports:rows.length,evidenceCount,valid:true}));}finally{await pool.end();}`);
await writeFile(join(root,'evidence-audit.json'),JSON.stringify(audit,null,2),{mode:0o600});
console.log(JSON.stringify(audit));
console.log('Three reports saved locally for qualitative review.');
