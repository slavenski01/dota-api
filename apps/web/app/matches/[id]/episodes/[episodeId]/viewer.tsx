"use client";
import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useLocalTime } from "../../../../../lib/use-local-time";
import { visualPositions } from "../../../../../lib/visual-motion";
import type { EpisodeFrame, ViewerState } from "@dota/jobs";
import { usePlaybackFrame } from "../../../../../lib/use-playback-frame";
import { useFrame } from "../../../../../lib/use-frame";
import { gameTime } from "../../../../../lib/game-time";
import { heroName as hero } from "../../../../../lib/hero-catalog";
import { HeroPreloads } from "../../../../components/hero-portrait";
import resources from "../../../../../../../services/replay-parser/src/main/resources/resource-ids.json";
import EpisodeReviews from "./reviews";
import EpisodeMap from "./map";
const names = new Map(Object.entries(resources.items).map(([name,id]) => [id, name.replace(/^item_/, "").replaceAll("_", " ")]));
const numeric = (field: ViewerState["hp"] | undefined) => field?.status === "known" ? new Intl.NumberFormat("ru-RU",{maximumFractionDigits:1}).format(field.value) : "неизвестно";
export default function EpisodeViewer({ matchId, datasetId, episodeId, accountId, initialMode, initialTime }: { matchId: string; datasetId: string; episodeId: string; accountId: string; initialMode: string; initialTime: string }) {
  const search=useSearchParams(),mode=search.get("mode") ?? (initialMode || "decision");
  const [retry,setRetry]=useState(0);
  const endpoint = `/api/datasets/${encodeURIComponent(datasetId)}/episodes/${encodeURIComponent(episodeId)}`;
  const query = new URLSearchParams({ accountId, mode });
  const bootstrap = useFrame<EpisodeFrame>(`${endpoint}/view?${query}`, JSON.stringify([matchId,datasetId,episodeId,accountId,mode]), matchId, retry);
  const last = bootstrap.frame;
  const rawTime=search.get("time") ?? initialTime;
  const timeline=useLocalTime(search.has("time") && !rawTime.trim() ? NaN : rawTime ? Number(rawTime) : last?.decisionTimeSeconds ?? NaN,JSON.stringify([matchId,datasetId,episodeId,accountId,mode]));
  const time=timeline.time;
  const rawSlot=search.get("hero"),slot=rawSlot===null ? last?.playerSlot : rawSlot.trim() ? Number(rawSlot) : NaN;
  const valid=!!last && Number.isFinite(time) && time>=last.window.startSeconds && time<=last.window.endSeconds && last.heroes.some(h=>h.playerSlot===slot);
  const playback = usePlaybackFrame<EpisodeFrame>({datasetId,accountId,matchId,episodeId,mode,time,retry,enabled:valid});
  const frame = playback.frame, error = bootstrap.error ?? playback.error, pending = bootstrap.pending || playback.pending;
  function navigate(nextMode: string, nextTime: number | null, nextSlot=slot) {
    const value=nextTime ?? last?.decisionTimeSeconds ?? NaN;
    if(Number.isFinite(value))timeline.set(value);
    const url = new URL(window.location.href);url.searchParams.set("mode",nextMode);
    if(Number.isFinite(value))url.searchParams.set("time",String(value));
    if(nextSlot!==undefined)url.searchParams.set("hero",String(nextSlot));
    if(url.href!==window.location.href)window.history.pushState(null,"",url);
  }
  const setSelectedSlot=(slot:number)=>navigate(mode,time,slot);
  const commitScrub=()=>navigate(mode,timeline.finish());
  const observation = frame?.states.find(s => s.playerSlot === slot), state = observation?.state;
  const back = `/matches/${encodeURIComponent(matchId)}?accountId=${encodeURIComponent(accountId)}`;
  return <main className="episode-page"><Link href={back}>← К матчу {matchId}</Link><p className="eyebrow">ПРОВЕРКА ЭПИЗОДА</p><h1>Контекст решения</h1>
    <p>Игрок {accountId}. Автоматический отбор — повод для проверки, не подтверждение ошибки.</p>
    <section><label>Перспектива <select aria-label="Перспектива" value={mode} onChange={e => navigate(e.target.value,time ?? last?.time ?? null)}><option value="decision">Команда выбранного игрока</option><option value="retrospective">Полный ретроспективный обзор</option></select></label>
      {last && <><p>Окно {gameTime(last.window.startSeconds)}–{gameTime(last.window.endSeconds)} · момент решения {gameTime(last.decisionTimeSeconds)}</p>
        <label htmlFor="episode-time">Игровое время: {time === null ? gameTime(last.time) : gameTime(time)}</label>
        <input id="episode-time" type="range" min={last.window.startSeconds} max={last.window.endSeconds} step="any" value={time ?? last.time} onChange={e=>timeline.scrub(Number(e.target.value))} onPointerUp={commitScrub} onPointerCancel={commitScrub} onBlur={commitScrub} onKeyUp={commitScrub} onKeyDown={e=>{ const delta = e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : 0; if(delta){e.preventDefault();navigate(mode,Math.max(last.window.startSeconds,Math.min(last.window.endSeconds,(time??last.time)+delta)));} }} aria-valuetext={gameTime(time ?? last.time)}/>
        <div className="history-actions"><button onClick={()=>navigate(mode,Math.max(last.window.startSeconds,(time??last.time)-1))}>−1 сек</button><button onClick={()=>navigate(mode,last.decisionTimeSeconds)}>К решению</button><button onClick={()=>navigate(mode,Math.min(last.window.endSeconds,(time??last.time)+1))}>+1 сек</button></div>
      </>}
    </section>
    {last && !valid && <p role="alert">Некорректное время или герой в ссылке. <button onClick={()=>navigate(mode,last.decisionTimeSeconds,last.playerSlot)}>К решению</button></p>}
    <p className="frame-status" role="status">{error && <>{error} <button onClick={()=>setRetry(n=>n+1)}>Повторить загрузку</button> </>}{pending ? `Загрузка ${time === null ? "контекста" : gameTime(time)}… ${frame ? `Показан кадр ${gameTime(frame.time)}.` : "Ожидание кадра."}` : frame ? `Показан кадр ${gameTime(frame.time)}.` : "Кадр недоступен."}</p>
      <HeroPreloads heroIds={frame?.heroes.map(h => h.heroId) ?? []}/>
      <div className="episode-context"><EpisodeMap frame={frame} motion={visualPositions(playback.window,frame?.time ?? time)} selectedSlot={slot} select={setSelectedSlot}/>
        <section><h2>Состояние героя</h2><label>Герой <select aria-label="Герой для просмотра" value={slot} onChange={e=>setSelectedSlot(Number(e.target.value))}>{frame?.heroes.map(h=><option key={h.playerSlot} value={h.playerSlot}>{hero(h.heroId)} · {h.playerSlot < 128 ? "Radiant" : "Dire"}{h.playerSlot === frame.playerSlot ? " · выбранный игрок" : ""}</option>)}</select></label>
          <p>{observation?.ageSeconds == null ? "Подтверждённого наблюдения нет." : `Наблюдение ${state!.gameTimeSeconds.toFixed(3)} сек; возраст ${observation.ageSeconds.toFixed(3)} сек.`}</p>
          <p>Координаты мира: {state?.position.status === "known" ? `${state.position.value.x.toFixed(1)}, ${state.position.value.y.toFixed(1)}` : "неизвестно"}.</p>
          <dl className="stat-grid"><div><dt>HP</dt><dd>{numeric(state?.hp)}</dd></div><div><dt>Мана</dt><dd>{numeric(state?.mana)}</dd></div><div><dt>Жизнь</dt><dd>{state?.alive.status === "known" ? state.alive.value ? "жив" : "умирает / мёртв" : "неизвестно"}</dd></div><div><dt>Видимость</dt><dd>{state?.visibility.status === "known" ? state.visibility.value === "visible" ? "виден" : "скрыт" : "неизвестно"}</dd></div></dl>
          <p>Последняя известная позиция: {state?.lastKnownPosition ? `${state.lastKnownPosition.position.x}, ${state.lastKnownPosition.position.y} в ${gameTime(state.lastKnownPosition.observedAtSeconds)} (историческое наблюдение)` : "неизвестно"}.</p>
          <h3>Предметы по слотам</h3>{state?.inventory.status === "known" ? state.inventory.value.length ? <ul>{state.inventory.value.map(i=><li key={i.slot}>Слот {i.slot}: {names.get(i.itemId) ?? `предмет ${i.itemId}`} · заряды {i.charges ?? "неизвестно"}</li>)}</ul> : <p>Подтверждённо пусто.</p> : <p>Неизвестно.</p>}
          <p>Готовность и применимость способностей не подтверждены.</p>
        </section></div>
    {frame && <>
      {frame.limitations.map(l=><p className="muted" key={l}>{l}</p>)}
      {mode === "retrospective" && <section><h2>События окна и основания отбора</h2>{frame.facts.map(f=><p key={f}>{f}</p>)}<p className="muted">События всех участников и исход эпизода доступны в полном ретроспективном обзоре. Частичный журнал не доказывает отсутствие событий.</p>
        <ul className="event-list">{frame.events.map(e=><li key={e.id}><button onClick={()=>navigate(mode,e.gameTimeSeconds)}>{gameTime(e.gameTimeSeconds)} · {e.data.type === "death" ? `смерть, слот ${e.data.victimSlot}` : e.data.type === "item" ? `${e.data.action === "purchased" ? "покупка" : e.data.action === "used" ? "применение" : e.data.action === "received" ? "получение" : "сборка"}: ${names.get(e.data.itemId) ?? e.data.itemId}` : e.data.type === "objective" ? `объект: ${e.data.objectId}` : "бой"}</button></li>)}</ul>
        <a href={`${endpoint}?accountId=${encodeURIComponent(accountId)}`}>Исходные основания и версии эпизода</a>
      </section>}
    </>}
    {last && <EpisodeReviews endpoint={endpoint} accountId={accountId} playerSlot={last.playerSlot}/>}
  </main>;
}
