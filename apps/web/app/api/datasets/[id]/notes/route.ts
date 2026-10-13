import { jobs } from "../../../../../lib/backend";
import { infrastructure, json, errorResponse, checkOrigin, readJson } from "../../../../../lib/infrastructure";
export const dynamic = "force-dynamic";
function queryParams(request: Request, writing: boolean) {
  const query=new URL(request.url).searchParams;
  if ([...query.keys()].some(k=>!(writing?["accountId"]:["accountId","mode"]).includes(k)||query.getAll(k).length!==1||!query.get(k)?.trim())) throw new jobs.JobError("invalid_note");
  return query;
}
export async function GET(request: Request, context: {params: Promise<{id:string}>}): Promise<Response> {
  try {
    const query=queryParams(request,false),mode=query.get("mode")??"retrospective";
    if (!["decision","retrospective"].includes(mode)) throw new jobs.JobError("invalid_note");
    const {pool}=await infrastructure(),{id}=await context.params;
    return json({notes:await jobs.readMatchNotes(pool,id,query.get("accountId")??"",mode as "decision"|"retrospective")});
  } catch(error) {return errorResponse(error);}
}
export async function POST(request: Request, context: {params: Promise<{id:string}>}): Promise<Response> {
  try {
    checkOrigin(request);const query=queryParams(request,true),input=await readJson(request);
    const {pool}=await infrastructure(),{id}=await context.params;
    return json(await jobs.saveMatchNote(pool,id,query.get("accountId")??"",input));
  } catch(error) {return errorResponse(error);}
}
