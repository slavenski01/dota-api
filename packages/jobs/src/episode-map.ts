import type { HeroState } from "@dota/contracts";

export const EPISODE_MAP = {
  status: "approximate" as const,
  backgroundVersion: "7.40",
  projectionVersion: "opendota-740-v1",
  image: "/maps/dota-7.40.webp",
  imageSha256: "cceee8cea4e7137a3274d89a443c1983d8c18261d6222f1bd4be7e9b125b11dc",
  reason: "Приблизительная подложка 7.40. В контрольном реплее отдельные ориентиры смещены до 9% ширины карты; рельеф и проходимость могут отличаться.",
};
export const POSITION_SOURCE_VERSION = "normalized-v2/clarity-5.0.1/protobuf-7.1";
export interface MapPoint { x: number; y: number }

/** Percent coordinates on the original uncropped square. Never clamp off-map points. */
export function projectWorldPosition(x: number, y: number): MapPoint | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const point = { x: (x + 8192) / 16256 * 100, y: (8064 - y) / 16256 * 100 };
  return point.x >= 0 && point.x <= 100 && point.y >= 0 && point.y <= 100 ? point : null;
}
export function episodeMapPoint(state: HeroState | null): MapPoint | null {
  if (!state || state.provenance.sourceVersion !== POSITION_SOURCE_VERSION ||
      state.position.status !== "known" || state.position.observedAtSeconds !== state.gameTimeSeconds) return null;
  return projectWorldPosition(state.position.value.x, state.position.value.y);
}
