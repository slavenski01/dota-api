import Explorer from "./viewer";
export default async function ExplorerPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params;
  await searchParams;
  return <Explorer matchId={id}/>;
}
