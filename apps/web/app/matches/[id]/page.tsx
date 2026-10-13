import MatchReplay from "./replay";
export default async function MatchPage({ params }: { params: Promise<{ id: string }> }) {
  return <MatchReplay matchId={(await params).id}/>;
}
