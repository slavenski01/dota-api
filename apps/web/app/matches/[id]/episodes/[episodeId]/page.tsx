import EpisodeViewer from "./viewer";
export default async function EpisodePage({ params, searchParams }: { params: Promise<{ id: string; episodeId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const route = await params, query = await searchParams;
  const single = (key: string) => typeof query[key] === "string" ? query[key] as string : "";
  return <EpisodeViewer key={`${route.id}:${route.episodeId}:${single("datasetId")}:${single("accountId")}`} matchId={route.id} episodeId={route.episodeId} datasetId={single("datasetId")} accountId={single("accountId")} initialMode={single("mode")} initialTime={single("time")}/>;
}
