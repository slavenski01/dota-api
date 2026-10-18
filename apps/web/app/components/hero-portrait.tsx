"use client";
import { useState } from "react";
import { preload } from "react-dom";
import { getHero, heroName } from "../../lib/hero-catalog";

// Avoid retrying a missing file every time the map remounts during a seek.
// A document reload retries; a new catalog uses a different content hash/URL.
const failedIcons = new Set<string>();

export function HeroPreloads({ heroIds }: { heroIds: (string | number | null | undefined)[] }) {
  const icons = new Set(heroIds.map(id => getHero(id)?.icon).filter((icon): icon is string => !!icon));
  for (const icon of icons) if (!failedIcons.has(icon)) preload(icon, { as: "image" });
  return null;
}

export default function HeroPortrait({ heroId }: { heroId: string | number | null | undefined }) {
  const icon = getHero(heroId)?.icon;
  const [failedIcon, setFailedIcon] = useState<string>();
  return <span className="hero-portrait" title={heroName(heroId)} aria-hidden="true">
    {icon && failedIcon !== icon && !failedIcons.has(icon)
      ? <img key={icon} src={icon} width={32} height={32} alt="" draggable={false} onError={() => { failedIcons.add(icon); setFailedIcon(icon); }}/>
      : <span className="hero-fallback">{heroId ?? "?"}</span>}
  </span>;
}
