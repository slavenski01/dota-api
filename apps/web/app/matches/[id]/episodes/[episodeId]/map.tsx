"use client";
import type { VisualPosition } from "../../../../../lib/visual-motion";
import { useState } from "react";
import type { EpisodeFrame } from "@dota/jobs";
import { gameTime } from "../../../../../lib/game-time";
import { heroName } from "../../../../../lib/hero-catalog";
import HeroPortrait from "../../../../components/hero-portrait";

export default function EpisodeMap({ frame, selectedSlot, select, motion }: { frame: Pick<EpisodeFrame, "states" | "heroes" | "time" | "map" | "mode" | "playerSlot"> | null; selectedSlot: number | undefined; select: (slot: number) => void; motion?: VisualPosition[] | undefined }) {
  const [failed, setFailed] = useState(false);
  const points = (motion ?? frame?.states.map(s=>({playerSlot:s.playerSlot,mapPosition:s.mapPosition,observedTime:s.state?.gameTimeSeconds ?? frame.time,alive:s.state?.alive.status === "known" ? s.state.alive.value : null,interpolated:false})) ?? []).filter(s=>s.mapPosition!==null);
  const label = (slot: number) => {
    const id = frame?.heroes.find(h => h.playerSlot === slot)?.heroId;
    return heroName(id);
  };
  return <section className="episode-map" aria-label="Карта эпизода"><h2>Карта · {frame ? gameTime(frame.time) : "—"}</h2>
    <p className="muted">{frame?.map.reason ?? "Приблизительная подложка 7.40. В контрольном реплее отдельные ориентиры смещены до 9% ширины карты; рельеф и проходимость могут отличаться."}</p>
    {failed ? <p role="alert">Не удалось загрузить подложку. Состояния героев доступны в соседней панели.</p> : <div className="map-surface">
      <img src={frame?.map.image ?? "/maps/dota-7.40.webp"} width={900} height={900} alt="Приблизительная карта Dota 2, подложка 7.40" onError={() => setFailed(true)}/>
      {points.map(row => {
        const dead = row.alive === false;
        const description = `${label(row.playerSlot)} · ${row.playerSlot < 128 ? "Radiant" : "Dire"} · наблюдение ${gameTime(row.observedTime)}${dead ? " · умирает / мёртв" : ""}${row.interpolated ? " · визуально сглажено" : ""}`;
        return <button key={row.playerSlot} type="button" className={`map-marker ${row.playerSlot < 128 ? "radiant" : "dire"}${dead ? " dead" : ""}`}
          style={{left:`${row.mapPosition!.x}%`,top:`${row.mapPosition!.y}%`}} data-map-slot={row.playerSlot}
          aria-label={description} aria-pressed={selectedSlot === row.playerSlot} title={description} onClick={() => select(row.playerSlot)}>
          <HeroPortrait heroId={frame?.heroes.find(h => h.playerSlot === row.playerSlot)?.heroId}/>
          {dead && <span className="map-death" aria-hidden="true">×</span>}
        </button>;
      })}
    </div>}
    <p className="map-legend"><span className="radiant-label">○ Radiant: круглая рамка</span> · <span className="dire-label">□ Dire: квадратная рамка</span> · × умирает / мёртв · белая обводка — выбранный герой</p>
    <p className="muted">Если герои перекрываются, выберите нужного в списке под картой. Маркеры и список доступны с клавиатуры.</p>
    <p>{!frame ? "Подтверждённый кадр ещё не загружен." : frame.mode === "decision" ? "Позиции неизвестны: командный обзор не подтверждён. Маркеры полного обзора здесь не показываются." : `На карте ${points.length} из ${frame.heroes.length} героев. ${motion ? "Координаты наблюдаются примерно раз в 250 мс; обычное движение визуально сглажено. Разрывы не достраиваются." : "Последние редкие наблюдения возрастом до 5 секунд, без сглаживания."}`}</p>
    {frame?.mode === "retrospective" && points.length === 0 && <p className="muted">Нет пригодных позиций в этом кадре: пропуск, выход за границы подложки или старый набор. Для старого набора запустите повторный разбор на странице матча.</p>}
    <div className="map-roster" aria-label="Герои на карте">{frame?.heroes.map(h => <button key={h.playerSlot} type="button" className={`hero-choice ${h.playerSlot < 128 ? "radiant" : "dire"}`} aria-pressed={h.playerSlot === selectedSlot} onClick={() => select(h.playerSlot)}>
      <HeroPortrait heroId={h.heroId}/><span>{label(h.playerSlot)}<small>{h.playerSlot < 128 ? "Radiant" : "Dire"} · слот {h.playerSlot}{h.playerSlot === frame.playerSlot ? " · ваш игрок" : ""}{points.some(p => p.playerSlot === h.playerSlot) ? "" : " · нет позиции"}</small></span>
    </button>)}</div>
    <p className="muted">Туман войны не восстановлен. Полный обзор не доказывает, что игрок видел угрозу. Подложка: <a href="https://github.com/odota/web/blob/7ccb42bd73bba450d3768ddf38aabc0e6ad9cb0c/public/assets/images/dota2/map/detailed_740.webp">OpenDota 7.40</a> · Dota 2 © Valve.</p>
  </section>;
}
