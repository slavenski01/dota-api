import { persistence } from "../../../lib/backend";
import { infrastructure, json, errorResponse } from "../../../lib/infrastructure";
export const dynamic = "force-dynamic";
export async function GET(request: Request): Promise<Response> {
  try {
    const filters=persistence.parseMatchFilters(new URL(request.url).searchParams);
    return json(await persistence.listMatches((await infrastructure()).pool,filters));
  } catch(error) {return errorResponse(error);}
}
