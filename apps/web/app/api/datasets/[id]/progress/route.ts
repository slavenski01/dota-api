import { jobs } from "../../../../../lib/backend";
import { infrastructure, json, errorResponse, checkOrigin, readJson } from "../../../../../lib/infrastructure";
export const dynamic="force-dynamic";
function account(request:Request){const q=new URL(request.url).searchParams;if([...q.keys()].some(k=>k!=='accountId'||q.getAll(k).length!==1))throw new jobs.JobError('invalid_progress');return q.get('accountId')??'';}
export async function GET(request:Request,context:{params:Promise<{id:string}>}){
  try{const accountId=account(request),{pool}=await infrastructure();return json(await jobs.readPractice(pool,(await context.params).id,accountId));}catch(error){return errorResponse(error);}
}
export async function POST(request:Request,context:{params:Promise<{id:string}>}){
  try{checkOrigin(request);const accountId=account(request),v=await readJson(request) as {action:string;value:unknown};
    if(!v||typeof v!=='object'||Object.keys(v).some(k=>!['action','value'].includes(k))||!['create','observe'].includes(v.action))throw new jobs.JobError('invalid_progress');
    const {pool}=await infrastructure(),{id}=await context.params;
    return json(v.action==='create'?await jobs.createPractice(pool,id,accountId,v.value):await jobs.savePracticeObservation(pool,id,accountId,v.value));
  }catch(error){return errorResponse(error);}
}
