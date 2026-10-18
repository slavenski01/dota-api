import catalog from "./hero-catalog.json";

type HeroId = string | number | null | undefined;
type Hero = { id: number; name: string; icon: string };
const heroes: Record<string, Hero> = catalog.heroes;

export function getHero(id: HeroId): Hero | undefined {
  const key = String(id);
  return Object.hasOwn(heroes, key) ? heroes[key] : undefined;
}

export function heroName(id: HeroId): string {
  return getHero(id)?.name ?? (id === null || id === undefined || id === "" ? "Герой неизвестен" : `Герой ${id}`);
}
