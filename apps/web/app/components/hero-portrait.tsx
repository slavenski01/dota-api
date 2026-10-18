"use client";
import { useState } from "react";
import { getHero, heroName } from "../../lib/hero-catalog";

export default function HeroPortrait({ heroId }: { heroId: string | number | null | undefined }) {
  const icon = getHero(heroId)?.icon;
  const [failedIcon, setFailedIcon] = useState<string>();
  return <span className="hero-portrait" title={heroName(heroId)} aria-hidden="true">
    {icon && failedIcon !== icon
      ? <img key={icon} src={icon} width={32} height={32} alt="" draggable={false} onError={() => setFailedIcon(icon)}/>
      : <span className="hero-fallback">{heroId ?? "?"}</span>}
  </span>;
}
