"use client";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import type { MatchExplorer, MatchFrame, MatchOverview, ViewerState } from "@dota/jobs";
import type { GameEvent } from "@dota/contracts";
import { api } from "../../../../lib/source-errors";
import { gameTime } from "../../../../lib/game-time";
import { heroName as hero } from "../../../../lib/hero-catalog";
import HeroPortrait, { HeroPreloads } from "../../../components/hero-portrait";
import resources from "../../../../../../services/replay-parser/src/main/resources/resource-ids.json";
import EpisodeMap from "../episodes/[episodeId]/map";
import { Chart } from "../overview";
import MatchNotes from "./notes";

const itemNames = new Map(Object.entries(resources.items).map(([name,id]) => [id,name.replace(/^item_/, "").replaceAll("_", " ")]));
const actions = { purchased: "покупка", assembled: "сборка", received: "получение", used: "применение" };
function useRead<T>(url: string | null, retry: number) {
  const [result,setResult] = useState<{ url: string; value?: T; error?: string } | null>(null);
  useEffect(() => {
    if (!url) return;
    const controller = new AbortController(); setResult(null);
    void api<T>(url,{signal:controller.signal}).then(value => { if (!controller.signal.aborted) setResult({url,value}); })
      .catch(e => { if (!controller.signal.aborted) setResult({url,error:e.message}); });
    return () => controller.abort();
  },[url,retry]);
  return result?.url === url ? result : null;
}
export default function Explorer({ matchId }: { matchId: string }) {
  const search = useSearchParams(), [retry,setRetry] = useState(0), [copied,setCopied] = useState("");
  const accountId = search.get("accountId") ?? "", datasetId = search.get("datasetId") ?? "";
  const endpoint = `/api/datasets/${encodeURIComponent(datasetId)}/explore`;
  const url = (resource: string, params: Record<string,string> = {}) => `${endpoint}?${new URLSearchParams({accountId,resource,...params})}`;
  const meta = useRead<MatchExplorer>(datasetId && accountId ? url("match") : null,retry);
  const view = meta?.value?.match.matchId === matchId ? meta.value : undefined;
  const mode = search.get("mode") ?? "retrospective", rawTime = search.get("time"), rawSlot = search.get("hero");
  const time = rawTime === null ? 0 : rawTime.trim() ? Number(rawTime) : NaN;
  const slot = rawSlot === null ? view?.player.playerSlot : rawSlot.trim() ? Number(rawSlot) : NaN;
  const valid = view && ["decision","retrospective"].includes(mode) && Number.isFinite(time) && time >= view.window.startSeconds && time <= view.window.endSeconds && view.players.some(p=>p.playerSlot===slot);
  const frameRead = useRead<MatchFrame>(valid ? url("frame",{mode,time:String(time)}) : null,retry);
  const frame = frameRead?.value;
  const eventType = search.get("eventType") ?? "", eventPlayer = search.get("eventPlayer") ?? "", cursor = search.get("cursor") ?? "";
  const eventsRead = useRead<{ events: GameEvent[]; nextCursor: string | null; limitation: string }>(valid ? url("events",{mode,...(eventType?{type:eventType}:{}),...(eventPlayer?{playerSlot:eventPlayer}:{}),...(cursor?{cursor}:{})}) : null,retry);
  const seriesRead = useRead<{ series: MatchOverview["series"] }>(valid ? url("series",{mode,playerSlot:String(slot)}) : null,retry);
  function navigate(changes: Record<string,string | null>) {
    const next = new URL(window.location.href);
    for (const [key,value] of Object.entries(changes)) { if(value===null)next.searchParams.delete(key);else next.searchParams.set(key,value); }
    window.history.replaceState(null,"",next); setCopied("");
  }
  const go = (next: number) => { if(view)navigate({time:String(Math.max(view.window.startSeconds,Math.min(view.window.endSeconds,next)))}); };
  const selected = view?.players.find(p=>p.playerSlot===slot), observation = frame?.states.find(s=>s.playerSlot===slot), state = observation?.state;
  const namedSlot = (value: number | null) => value === null ? "неизвестно" : hero(view?.players.find(p=>p.playerSlot===value)?.heroId);
  const label = (event: GameEvent) => {
    const data=event.data;
    if(data.type==='death')return `Смерть: ${namedSlot(data.victimSlot)} · убийца: ${namedSlot(data.killerSlot)}${data.afterBuyback ? " · после выкупа" : ""}`;
    if(data.type==='item')return `${namedSlot(data.playerSlot)} · ${actions[data.action]}: ${itemNames.get(data.itemId) ?? data.itemId}`;
    if(data.type==='objective')return `Объект: ${data.objectId} · ${data.ownerTeam ?? "сторона неизвестна"} → ${data.beneficiaryTeam ?? "сторона неизвестна"}`;
    return `Бой: ${gameTime(data.window.startSeconds)}–${gameTime(data.window.endSeconds)}`;
  };
  const errors = [meta?.error,frameRead?.error,eventsRead?.error,seriesRead?.error].filter(Boolean);
  const numeric = (value: ViewerState["hp"] | undefined) => value?.status === "known" ? value.value : "неизвестно";
  return <main className="episode-page explorer-page"><Link href={`/matches/${encodeURIComponent(matchId)}?accountId=${encodeURIComponent(accountId)}`}>← К матчу</Link>
    <p className="eyebrow">ИССЛЕДОВАНИЕ ВСЕЙ ИГРЫ</p><h1>Матч {matchId}</h1><p>Выбирайте время, изучайте героев и события. Автоматические эпизоды для просмотра не требуются.</p>
    {!accountId || !datasetId ? <p role="alert">Откройте просмотр из карточки разобранного матча: в ссылке нужны игрок и набор данных.</p> : !meta && <p role="status">Загрузка матча…</p>}
    {meta?.value && !view && <p role="alert">Набор относится к другому матчу.</p>}
    {errors.length>0 && <p className="notice error" role="alert">{[...new Set(errors)].join(" ")} <button onClick={()=>setRetry(n=>n+1)}>Повторить загрузку</button></p>}
    {view && <>
      <HeroPreloads heroIds={view.players.map(p => p.heroId)}/>
      <p className="muted">Игрок {accountId} · {view.match.radiantWin===null ? "результат неизвестен" : view.match.radiantWin ? "Победа Radiant" : "Победа Dire"} · длительность {view.match.durationSeconds===null?"неизвестна":gameTime(view.match.durationSeconds)} · патч {view.match.patch ?? "неизвестен"}. {view.limitations.join(" ")}</p>
      {!valid && <p role="alert">Некорректные время, герой или перспектива в ссылке. <button onClick={()=>navigate({time:"0",hero:String(view.player.playerSlot),mode:"retrospective"})}>Открыть начало игры</button></p>}
      <section className="explorer-controls"><h2>Время и перспектива</h2><div className="filters">
        <label>Перспектива<select value={mode} onChange={e=>navigate({mode:e.target.value,cursor:null})}><option value="retrospective">Полный ретроспективный обзор</option><option value="decision">Команда выбранного игрока</option></select></label>
        <label>Герой<select value={slot ?? ""} onChange={e=>navigate({hero:e.target.value})}>{view.players.map(p=><option key={p.playerSlot} value={p.playerSlot}>{hero(p.heroId)} · {p.team === "radiant" ? "Radiant" : "Dire"} · слот {p.playerSlot}</option>)}</select></label>
        <label>Время, игровые секунды<input aria-label="Время, игровые секунды" type="number" step="any" min={view.window.startSeconds} max={view.window.endSeconds} value={Number.isFinite(time)?time:""} onChange={e=>{if(e.target.value.trim())navigate({time:e.target.value});}}/></label>
      </div>
      <label htmlFor="match-time">{Number.isFinite(time)?gameTime(time):"Время не задано"} · весь матч: {gameTime(view.window.startSeconds)}–{gameTime(view.window.endSeconds)}</label>
      <input id="match-time" type="range" min={view.window.startSeconds} max={view.window.endSeconds} step="any" value={Number.isFinite(time)?time:0} aria-valuetext={Number.isFinite(time)?gameTime(time):"Неизвестно"} onChange={e=>go(Number(e.target.value))} onKeyDown={e=>{const d=e.key==='ArrowRight'||e.key==='ArrowUp'?1:e.key==='ArrowLeft'||e.key==='ArrowDown'?-1:0;if(d){e.preventDefault();go(time+d);}}}/>
      <div className="history-actions"><button onClick={()=>go(view.window.startSeconds)}>Начало записи</button><button disabled={!valid} onClick={()=>go(time-30)}>−30 сек</button><button disabled={!valid} onClick={()=>go(time-1)}>−1 сек</button><button disabled={!valid} onClick={()=>go(time+1)}>+1 сек</button><button disabled={!valid} onClick={()=>go(time+30)}>+30 сек</button><button onClick={()=>go(view.window.endSeconds)}>Конец записи</button></div>
      <button disabled={!valid} onClick={()=>{ const link=new URL(window.location.href);link.searchParams.set('time',String(time));link.searchParams.set('hero',String(slot));link.searchParams.set('mode',mode);void navigator.clipboard.writeText(link.href).then(()=>setCopied("Ссылка скопирована.")).catch(()=>setCopied("Скопируйте адрес из строки браузера.")); }}>Скопировать ссылку на момент</button><p role="status">{copied}</p>
      </section>
      {valid && !frame && !frameRead?.error && <p role="status">Загрузка состояния…</p>}
      {frame && <><p className="notice">{frame.limitations.join(" ")}</p><div className="episode-context"><EpisodeMap frame={frame} selectedSlot={slot} select={s=>navigate({hero:String(s)})}/>
        <section><h2>Состояние: {hero(selected?.heroId)}</h2><p>{observation?.ageSeconds==null ? "Подтверждённого наблюдения нет." : `Наблюдение ${gameTime(state!.gameTimeSeconds)}; возраст ${observation.ageSeconds.toFixed(3)} сек.`}</p>
          <dl className="stat-grid"><div><dt>Здоровье</dt><dd>{numeric(state?.hp)}</dd></div><div><dt>Мана</dt><dd>{numeric(state?.mana)}</dd></div><div><dt>Жизнь</dt><dd>{state?.alive.status==='known'?state.alive.value?'жив':'умирает / мёртв':'неизвестно'}</dd></div><div><dt>Видимость</dt><dd>{state?.visibility.status==='known'?state.visibility.value==='visible'?'виден':'скрыт':'неизвестно'}</dd></div></dl>
          <p>Координаты: {state?.position.status==='known'?`${state.position.value.x.toFixed(1)}, ${state.position.value.y.toFixed(1)}`:'неизвестно'}.</p>
          <h3>Предметы</h3>{state?.inventory.status==='known'?state.inventory.value.length?<ul>{state.inventory.value.map(i=><li key={i.slot}>Слот {i.slot}: {itemNames.get(i.itemId)??i.itemId} · заряды {i.charges??'неизвестно'}</li>)}</ul>:<p>Подтверждённо пустой инвентарь.</p>:<p>Неизвестно.</p>}<p>Готовность и применимость способностей пока не подтверждены.</p>
        </section></div></>}
      {valid && slot!==undefined && <MatchNotes key={`${datasetId}:${accountId}:${mode}`} datasetId={datasetId} accountId={accountId} matchId={matchId} time={time} slot={slot} mode={mode as "decision"|"retrospective"} heroName={hero(selected?.heroId)}/>}
      <section><h2>События всей игры</h2><div className="filters"><label>Тип события<select value={eventType} onChange={e=>navigate({eventType:e.target.value||null,cursor:null})}><option value="">Все события</option><option value="death">Смерти</option><option value="item">Предметы</option><option value="objective">Объекты</option><option value="fight">Бои</option></select></label>
        <label>Участник событий<select value={eventPlayer} onChange={e=>navigate({eventPlayer:e.target.value||null,cursor:null})}><option value="">Все участники</option>{view.players.map(p=><option key={p.playerSlot} value={p.playerSlot}>{hero(p.heroId)} · слот {p.playerSlot}</option>)}</select></label></div>
        {eventsRead?.value ? <><p className="muted">{eventsRead.value.limitation}</p>{eventsRead.value.events.length ? <ul className="event-list">{eventsRead.value.events.map(e=><li key={e.id}><button onClick={()=>go(e.gameTimeSeconds)}>{gameTime(e.gameTimeSeconds)} · {label(e)}</button></li>)}</ul>:<p>Доступных событий на этой странице нет. Это не доказывает их отсутствие в игре.</p>}
          <div className="history-actions">{cursor&&<button onClick={()=>navigate({cursor:null})}>С начала журнала</button>}{eventsRead.value.nextCursor&&<button onClick={()=>navigate({cursor:eventsRead.value!.nextCursor})}>Следующие события</button>}</div></>:valid&&!eventsRead?.error&&<p role="status">Загрузка событий…</p>}
      </section>
      {mode==='retrospective' && <><section><h2>Статистика десяти игроков</h2><p>Итог матча, не оценка качества решений. Выбор строки переключает героя на карте и графиках.</p><div className="table-scroll" tabIndex={0}><table><caption>Полный ретроспективный обзор · неизвестные значения не заменяются нулями</caption><thead><tr><th>Герой / команда</th><th>K / D / A</th><th>Добивания / денаи</th><th>GPM / XPM</th><th>Урон героям</th><th>Урон строениям</th><th>Роль</th></tr></thead><tbody>{view.players.map(p=><tr key={p.playerSlot} aria-selected={slot===p.playerSlot}><td><button className={`hero-choice ${p.team}`} aria-pressed={slot===p.playerSlot} onClick={()=>navigate({hero:String(p.playerSlot)})}><HeroPortrait heroId={p.heroId}/><span>{hero(p.heroId)}</span></button><small>{p.team} · слот {p.playerSlot}{p.playerSlot===view.player.playerSlot?' · выбранный игрок':''}</small></td><td>{p.statistics.kills??'—'} / {p.statistics.deaths??'—'} / {p.statistics.assists??'—'}</td><td>{p.statistics.lastHits??'—'} / {p.statistics.denies??'—'}</td><td>{p.statistics.gpm??'—'} / {p.statistics.xpm??'—'}</td><td>{p.statistics.heroDamage??'—'}</td><td>{p.statistics.towerDamage??'—'}</td><td>{p.role?`${p.role.position} (${p.role.source})`:'неизвестно'}</td></tr>)}</tbody></table></div></section>
      <section><h2>Ресурсы: {hero(selected?.heroId)}</h2>{seriesRead?.value?<><Chart points={seriesRead.value.series} field="hp" label="Здоровье (HP)"/><Chart points={seriesRead.value.series} field="mana" label="Мана"/></>:valid&&!seriesRead?.error&&<p role="status">Загрузка графиков…</p>}<p className="muted">Рядов золота, опыта и добиваний пока нет. Покупка предмета не означает доставку герою.</p></section></>}
    </>}
  </main>;
}
