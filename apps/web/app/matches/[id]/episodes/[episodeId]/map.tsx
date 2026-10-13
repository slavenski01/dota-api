"use client";
import { useState } from "react";
import type { EpisodeFrame } from "@dota/jobs";
import { gameTime } from "../../../../../lib/game-time";
import heroes from "../../../../../lib/heroes.json";

export default function EpisodeMap({ frame, selectedSlot, select }: { frame: EpisodeFrame; selectedSlot: number | undefined; select: (slot: number) => void }) {
  const [failed, setFailed] = useState(false);
  const points = frame.states.filter(s => s.mapPosition !== null);
  const label = (slot: number) => {
    const id = frame.heroes.find(h => h.playerSlot === slot)?.heroId;
    return (heroes as Record<string,string>)[String(id)] ?? (id ? `Герой ${id}` : "Герой неизвестен");
  };
  const number = (slot: number) => slot < 128 ? slot + 1 : slot - 128 + 6;
  return <section className="episode-map" aria-label="Карта эпизода"><h2>Карта · {gameTime(frame.time)}</h2>
    <p className="muted">{frame.map.reason}</p>
    {failed ? <p role="alert">Не удалось загрузить подложку. Состояния героев доступны в соседней панели.</p> : <div className="map-surface">
      <img src={frame.map.image} width={900} height={900} alt={`Приблизительная карта Dota 2, подложка ${frame.map.backgroundVersion}`} onError={() => setFailed(true)}/>
      {points.map(row => {
        const dead = row.state?.alive.status === "known" && !row.state.alive.value;
        const description = `${label(row.playerSlot)} · ${row.playerSlot < 128 ? "Radiant" : "Dire"} · наблюдение ${gameTime(row.state!.gameTimeSeconds)}${dead ? " · умирает / мёртв" : ""}`;
        return <button key={row.playerSlot} type="button" className={`map-marker ${row.playerSlot < 128 ? "radiant" : "dire"}${dead ? " dead" : ""}`}
          style={{left:`${row.mapPosition!.x}%`,top:`${row.mapPosition!.y}%`}} data-map-slot={row.playerSlot}
          aria-label={description} aria-pressed={selectedSlot === row.playerSlot} title={description} onClick={() => select(row.playerSlot)}>{dead ? "×" : number(row.playerSlot)}</button>;
      })}
    </div>}
    <p className="map-legend"><span className="radiant-label">● Radiant: 1–5</span> · <span className="dire-label">● Dire: 6–10</span> · × умирает / мёртв</p>
    <p>{frame.mode === "decision" ? "Позиции неизвестны: командный обзор не подтверждён. Маркеры полного обзора здесь не показываются." : `На карте ${points.length} из ${frame.heroes.length} героев. Показаны последние наблюдения возрастом до 5 секунд, без интерполяции.`}</p>
    {frame.mode === "retrospective" && points.length === 0 && <p className="muted">Нет пригодных позиций в этом кадре: пропуск, выход за границы подложки или старый набор. Для старого набора запустите повторный разбор на странице матча.</p>}
    <div className="map-roster" aria-label="Герои на карте">{frame.heroes.map(h => <button key={h.playerSlot} type="button" aria-pressed={h.playerSlot === selectedSlot} onClick={() => select(h.playerSlot)}>
      {number(h.playerSlot)}. {label(h.playerSlot)}{h.playerSlot === frame.playerSlot ? " · ваш игрок" : ""}{points.some(p => p.playerSlot === h.playerSlot) ? "" : " · нет позиции"}
    </button>)}</div>
    <p className="muted">Туман войны не восстановлен. Полный обзор не доказывает, что игрок видел угрозу. Подложка: <a href="https://github.com/odota/web/blob/7ccb42bd73bba450d3768ddf38aabc0e6ad9cb0c/public/assets/images/dota2/map/detailed_740.webp">OpenDota 7.40</a> · Dota 2 © Valve.</p>
  </section>;
}
