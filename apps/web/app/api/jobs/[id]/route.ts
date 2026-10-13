import { jobs } from "../../../../lib/backend";
const { getWorkflow, cancelWorkflow } = jobs;
import { infrastructure, json, errorResponse, checkOrigin } from "../../../../lib/infrastructure";
export const dynamic = "force-dynamic";
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { pool, boss } = await infrastructure();
    return json(await getWorkflow(pool, boss, (await context.params).id));
  } catch (error) { return errorResponse(error); }
}
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    checkOrigin(request);
    const { pool, boss } = await infrastructure();
    await cancelWorkflow(pool, boss, (await context.params).id);
    return json({ cancelled: true });
  } catch (error) { return errorResponse(error); }
}
