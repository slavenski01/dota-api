export const dynamic = "force-dynamic";

export function GET(): Response {
  // Liveness only: the scaffold does not connect to PostgreSQL or the queue.
  return Response.json(
    { service: "web", status: "ok", mode: "scaffold" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
