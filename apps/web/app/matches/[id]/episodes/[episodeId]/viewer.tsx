"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import type { EpisodeFrame, ViewerState } from "@dota/jobs";
import { api } from "../../../../../lib/source-errors";
import { gameTime } from "../../../../../lib/game-time";
import heroes from "../../../../../lib/heroes.json";
import resources from "../../../../../../../services/replay-parser/src/main/resources/resource-ids.json";
import EpisodeReviews from "./reviews";
import EpisodeMap from "./map";
const names = new Map(Object.entries(resources.items).map(([name,id]) => [id, name.replace(/^item_/, "").replaceAll("_", " ")]));
const hero = (id: string | null) => (heroes as Record<string,string>)[String(id)] ?? (id ? `Герой ${id}` : "Герой неизвестен");
const numeric = (field: ViewerState["hp"] | undefined) => field?.status === "known" ? new Intl.NumberFormat("ru-RU",{maximumFractionDigits:1}).format(field.value) : "неизвестно";
export default function EpisodeViewer({ matchId, datasetId, episodeId, accountId, initialMode, initialTime }: { matchId: string; datasetId: string; episodeId: string; accountId: string; initialMode: string; initialTime: string }) {
  const [mode, setMode] = useState(initialMode || "decision"), [time, setTime] = useState<number | null>(initialTime ? Number(initialTime) : null);
  const [response, setResponse] = useState<{ key: string; frame: EpisodeFrame } | null>(null), [error, setError] = useState("");
  const [retry, setRetry] = useState(0), [selectedSlot, setSelectedSlot] = useState<number | null>(null);
  const endpoint = `/api/datasets/${encodeURIComponent(datasetId)}/episodes/${encodeURIComponent(episodeId)}`;
  const key = `${endpoint}:${accountId}:${mode}:${time}`;
  const frame = response?.key === key ? response.frame : null;
  useEffect(() => {
    const controller = new AbortController(); setError("");
    const query = new URLSearchParams({ accountId, mode }); if (time !== null) query.set("time", String(time));
    void api<EpisodeFrame>(`${endpoint}/view?${query}`, {signal:controller.signal}).then(value => {
      if (controller.signal.aborted) return;
      if (value.matchId !== matchId) throw new Error("Эпизод относится к другому матчу.");
      setResponse({ key, frame: value });
    }).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [endpoint,accountId,mode,time,matchId,key,retry]);
  function navigate(nextMode: string, nextTime: number | null) {
    setMode(nextMode); setTime(nextTime);
    const url = new URL(window.location.href); url.searchParams.set("mode", nextMode); if(nextTime === null)url.searchParams.delete("time");else url.searchParams.set("time", String(nextTime)); window.history.replaceState(null,"",url);
  }
  const last = response?.frame;
  const slot = selectedSlot ?? frame?.playerSlot;
  const observation = frame?.states.find(s => s.playerSlot === slot), state = observation?.state;
  const back = `/matches/${encodeURIComponent(matchId)}?accountId=${encodeURIComponent(accountId)}`;
  return <main className="episode-page"><Link href={back}>← К матчу {matchId}</Link><p className="eyebrow">ПРОВЕРКА ЭПИЗОДА</p><h1>Контекст решения</h1>
    <p>Игрок {accountId}. Автоматический отбор — повод для проверки, не подтверждение ошибки.</p>
    {error && <p className="notice error" role="alert">{error} <button onClick={() => setRetry(n=>n+1)}>Повторить загрузку</button></p>}
    <section><label>Перспектива <select aria-label="Перспектива" value={mode} onChange={e => navigate(e.target.value,time ?? last?.time ?? null)}><option value="decision">Команда выбранного игрока</option><option value="retrospective">Полный ретроспективный обзор</option></select></label>
      {last && <><p>Окно {gameTime(last.window.startSeconds)}–{gameTime(last.window.endSeconds)} · момент решения {gameTime(last.decisionTimeSeconds)}</p>
        <label htmlFor="episode-time">Игровое время: {time === null ? gameTime(last.time) : gameTime(time)}</label>
        <input id="episode-time" type="range" min={last.window.startSeconds} max={last.window.endSeconds} step="any" value={time ?? last.time} onChange={e=>navigate(mode,Number(e.target.value))} onKeyDown={e=>{ const delta = e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : 0; if(delta){e.preventDefault();navigate(mode,Math.max(last.window.startSeconds,Math.min(last.window.endSeconds,(time??last.time)+delta)));} }} aria-valuetext={gameTime(time ?? last.time)}/>
        <div className="history-actions"><button onClick={()=>navigate(mode,Math.max(last.window.startSeconds,(time??last.time)-1))}>−1 сек</button><button onClick={()=>navigate(mode,last.decisionTimeSeconds)}>К решению</button><button onClick={()=>navigate(mode,Math.min(last.window.endSeconds,(time??last.time)+1))}>+1 сек</button></div>
      </>}
    </section>
    {!frame && !error && <p role="status">Загрузка контекста…</p>}
    {frame && <>
      <p className="notice">{frame.limitations[0]}</p>
      <div className="episode-context"><EpisodeMap frame={frame} selectedSlot={slot} select={setSelectedSlot}/>
        <section><h2>Состояние героя</h2><label>Герой <select aria-label="Герой для просмотра" value={slot} onChange={e=>setSelectedSlot(Number(e.target.value))}>{frame.heroes.map(h=><option key={h.playerSlot} value={h.playerSlot}>{hero(h.heroId)} · {h.playerSlot < 128 ? "Radiant" : "Dire"}{h.playerSlot === frame.playerSlot ? " · выбранный игрок" : ""}</option>)}</select></label>
          <p>{observation?.ageSeconds == null ? "Подтверждённого наблюдения нет." : `Наблюдение ${state!.gameTimeSeconds.toFixed(3)} сек; возраст ${observation.ageSeconds.toFixed(3)} сек.`}</p>
          <p>Координаты мира: {state?.position.status === "known" ? `${state.position.value.x.toFixed(1)}, ${state.position.value.y.toFixed(1)}` : "неизвестно"}.</p>
          <dl className="stat-grid"><div><dt>HP</dt><dd>{numeric(state?.hp)}</dd></div><div><dt>Мана</dt><dd>{numeric(state?.mana)}</dd></div><div><dt>Жизнь</dt><dd>{state?.alive.status === "known" ? state.alive.value ? "жив" : "умирает / мёртв" : "неизвестно"}</dd></div><div><dt>Видимость</dt><dd>{state?.visibility.status === "known" ? state.visibility.value === "visible" ? "виден" : "скрыт" : "неизвестно"}</dd></div></dl>
          <p>Последняя известная позиция: {state?.lastKnownPosition ? `${state.lastKnownPosition.position.x}, ${state.lastKnownPosition.position.y} в ${gameTime(state.lastKnownPosition.observedAtSeconds)} (историческое наблюдение)` : "неизвестно"}.</p>
          <h3>Предметы по слотам</h3>{state?.inventory.status === "known" ? state.inventory.value.length ? <ul>{state.inventory.value.map(i=><li key={i.slot}>Слот {i.slot}: {names.get(i.itemId) ?? `предмет ${i.itemId}`} · заряды {i.charges ?? "неизвестно"}</li>)}</ul> : <p>Подтверждённо пусто.</p> : <p>Неизвестно.</p>}
          <p>Готовность и применимость способностей не подтверждены.</p>
        </section></div>
      {frame.limitations.slice(1).map(l=><p className="muted" key={l}>{l}</p>)}
      {mode === "retrospective" && <section><h2>События окна и основания отбора</h2>{frame.facts.map(f=><p key={f}>{f}</p>)}<p className="muted">События всех участников и исход эпизода доступны в полном ретроспективном обзоре. Частичный журнал не доказывает отсутствие событий.</p>
        <ul className="event-list">{frame.events.map(e=><li key={e.id}><button onClick={()=>navigate(mode,e.gameTimeSeconds)}>{gameTime(e.gameTimeSeconds)} · {e.data.type === "death" ? `смерть, слот ${e.data.victimSlot}` : e.data.type === "item" ? `${e.data.action === "purchased" ? "покупка" : e.data.action === "used" ? "применение" : e.data.action === "received" ? "получение" : "сборка"}: ${names.get(e.data.itemId) ?? e.data.itemId}` : e.data.type === "objective" ? `объект: ${e.data.objectId}` : "бой"}</button></li>)}</ul>
        <a href={`${endpoint}?accountId=${encodeURIComponent(accountId)}`}>Исходные основания и версии эпизода</a>
      </section>}
    </>}
    {last && <EpisodeReviews endpoint={endpoint} accountId={accountId} playerSlot={last.playerSlot}/>}
  </main>;
}
