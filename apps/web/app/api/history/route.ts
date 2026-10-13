import { persistence, jobs } from "../../../lib/backend";
import { infrastructure, json, errorResponse, checkOrigin, readJson } from "../../../lib/infrastructure";
export const dynamic = "force-dynamic";
export async function GET(request: Request): Promise<Response> {
  try {
    const accountId = new URL(request.url).searchParams.get("accountId") ?? "";
    persistence.normalizePlayerId(accountId,"account");
    const {pool,boss}=await infrastructure();
    return json(await jobs.getHistoryStatus(pool,boss,accountId));
  } catch(error) {return errorResponse(error);}
}
export async function POST(request: Request): Promise<Response> {
  try {
    checkOrigin(request);
    const input=await readJson(request) as {accountId?:unknown;mode?:unknown}|null;
    const {accountId}=persistence.normalizePlayerId(input?.accountId,"account");
    const {pool,boss}=await infrastructure();
    const result=await jobs.requestHistory(pool,boss,accountId,input?.mode);
    return json(result,result.cached?200:202);
  } catch(error) {return errorResponse(error);}
}
