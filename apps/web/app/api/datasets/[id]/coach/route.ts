import { jobs } from "../../../../../lib/backend";
import { infrastructure, json, errorResponse, checkOrigin, readJson } from "../../../../../lib/infrastructure";
export const dynamic = "force-dynamic";
function parameters(request:Request, reading=false) {
  const q=new URL(request.url).searchParams;
  if([...q.keys()].some(k=>!['accountId','analysisId',...(reading?['reportId','episodeId','mode']:[])].includes(k)||q.getAll(k).length!==1||!q.get(k))||!q.get('accountId')||!q.get('analysisId')||q.has('episodeId')&&!q.has('reportId')) throw new jobs.JobError('coach_invalid_request');
  return {accountId:q.get('accountId')!,analysisId:q.get('analysisId')!,reportId:q.get('reportId')??undefined,episodeId:q.get('episodeId'),mode:q.get('mode')??'decision'};
}
export async function GET(request:Request, context:{params:Promise<{id:string}>}):Promise<Response> {
  try {
    const {accountId,analysisId,reportId,episodeId,mode}=parameters(request,true),{pool,boss}=await infrastructure(),datasetId=(await context.params).id;
    if(episodeId) return json(await jobs.readCoachEpisode(pool,boss,datasetId,accountId,analysisId,reportId!,episodeId,mode as 'decision'|'retrospective'));
    return json({reports:await jobs.readCoachReports(pool,boss,datasetId,accountId,analysisId,reportId)});
  }catch(error){return errorResponse(error);}
}
export async function POST(request:Request, context:{params:Promise<{id:string}>}):Promise<Response> {
  try {
    checkOrigin(request);const {accountId,analysisId}=parameters(request),body=await readJson(request),{pool,boss}=await infrastructure();
    return json(await jobs.requestCoachReport(pool,boss,(await context.params).id,accountId,analysisId,body),202);
  }catch(error){return errorResponse(error);}
}
