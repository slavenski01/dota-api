import { jobs } from "../../../../../lib/backend";
import { infrastructure, json, errorResponse, checkOrigin, readJson } from "../../../../../lib/infrastructure";
export const dynamic = "force-dynamic";
function parameters(request:Request) {
  const q=new URL(request.url).searchParams;
  if([...q.keys()].some(k=>!['accountId','analysisId'].includes(k)||q.getAll(k).length!==1)||!q.get('accountId')||!q.get('analysisId')) throw new jobs.JobError('coach_invalid_request');
  return {accountId:q.get('accountId')!,analysisId:q.get('analysisId')!};
}
export async function GET(request:Request, context:{params:Promise<{id:string}>}):Promise<Response> {
  try {
    const {accountId,analysisId}=parameters(request),{pool,boss}=await infrastructure();
    return json({reports:await jobs.readCoachReports(pool,boss,(await context.params).id,accountId,analysisId)});
  }catch(error){return errorResponse(error);}
}
export async function POST(request:Request, context:{params:Promise<{id:string}>}):Promise<Response> {
  try {
    checkOrigin(request);const {accountId,analysisId}=parameters(request),body=await readJson(request),{pool,boss}=await infrastructure();
    return json(await jobs.requestCoachReport(pool,boss,(await context.params).id,accountId,analysisId,body),202);
  }catch(error){return errorResponse(error);}
}
