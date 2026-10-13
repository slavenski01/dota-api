import MatchReplay from "./replay";
import resources from "../../../../../services/replay-parser/src/main/resources/resource-ids.json";
const items = Object.entries(resources.items).filter(([name]) => !name.startsWith("item_recipe_")).map(([name, id]) => ({ id, name: name.replace(/^item_/, "").replaceAll("_", " ") })).sort((a, b) => a.name.localeCompare(b.name));
export default async function MatchPage({ params }: { params: Promise<{ id: string }> }) {
  return <MatchReplay matchId={(await params).id} items={items}/>;
}
