"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { MatchSummary } from "@dota/persistence";
import { api } from "../../../lib/source-errors";
type Detail = { summary: MatchSummary | null; jobId: string | null; replay: { sizeBytes: number } | null };
type State = { artifactId: string | null; job: { status: string; limitations: string[]; error: { code: string } | null }; queueState: string | null; progress: { phase: string; bytes: number; totalBytes: number | null } | null };
const terminal = new Set(["ready", "unavailable", "failed", "cancelled"]);
const states: Record<string,string> = { queued:"В очереди",resolving:"Поиск реплея",downloading:"Подготовка реплея",parsing:"Проверка завершена",validating:"Проверка данных",analysing:"Анализ",ready:"Готово",unavailable:"Обработка недоступна",failed:"Ошибка обработки",cancelled:"Отменено" };
const phases: Record<string,string> = { receiving:"Получено",decompressing:"Распаковано",checking:"Проверка файла и участника",stored:"Файл сохранён" };
const errors: Record<string,string> = { replay_link_missing:"Источник не вернул ссылку на реплей.",replay_unavailable:"Реплей недоступен у источника.",invalid_replay:"Файл повреждён, имеет другой ID матча или не поддерживается парсером.",invalid_replay_format:"Файл не является поддерживаемым реплеем Dota 2.",replay_participant_mismatch:"Выбранный игрок не найден в реплее.",replay_match_mismatch:"ID матча не совпадает.",replay_size_limit:"Файл превышает допустимый размер.",replay_temporarily_unavailable:"Источник временно недоступен. Попробуйте позже.",provider_rate_limited:"Источник ограничил частоту запросов.",player_required:"Выберите профиль игрока.",replay_transfer_failed:"Не удалось получить или распаковать файл.",replay_transfer_timeout:"Превышено время загрузки.",bzip2_not_available:"На сервере не установлен bzip2.",analysis_not_connected:"Реплей готов. Расширенный анализ пока не подключён." };
const size = (bytes:number) => `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
export default function MatchReplay({ matchId }: { matchId: string }) {
  const [accountId,setAccountId]=useState("");const [detail,setDetail]=useState<Detail|null>(null);const [jobId,setJobId]=useState<string|null>(null);const [state,setState]=useState<State|null>(null);
  const [error,setError]=useState("");const [busy,setBusy]=useState(false);const [upload,setUpload]=useState<number|null>(null);const [file,setFile]=useState<File|null>(null);
  const xhr=useRef<XMLHttpRequest|null>(null);const inFlight=useRef(false);
  useEffect(()=>{setAccountId(new URLSearchParams(window.location.search).get("accountId")??"");return()=>xhr.current?.abort();},[]);
  const endpoint=`/api/replays/${encodeURIComponent(matchId)}?accountId=${encodeURIComponent(accountId)}`;
  const refresh=useCallback(async()=>{const result=await api<Detail>(endpoint);setDetail(result);setJobId(result.jobId);},[endpoint]);
  useEffect(()=>{if(accountId)void refresh().catch(e=>setError(e.message));},[accountId,refresh]);
  useEffect(()=>{
    if(!jobId)return;const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{
      try { const result=await api<State>(`/api/jobs/${jobId}`,{signal:controller.signal});if(controller.signal.aborted)return;setState(result);
        if(terminal.has(result.job.status)){await refresh();return;}timer=setTimeout(poll,1000);
      }catch(e){if(!controller.signal.aborted){setError(e instanceof Error?e.message:"Не удалось получить состояние.");timer=setTimeout(poll,3000);}}
    };void poll();return()=>{controller.abort();clearTimeout(timer);};
  },[jobId,refresh]);
  const active=Boolean(jobId&&(!state||!terminal.has(state.job.status)));
  async function start(){
    if(inFlight.current)return;inFlight.current=true;setBusy(true);setError("");
    try { const result=await api<{id:string}>("/api/jobs",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({matchId,accountId})});setState(null);setJobId(result.id); }
    catch(e){setError(e instanceof Error?e.message:"Не удалось запустить обработку.");}finally{inFlight.current=false;setBusy(false);}
  }
  async function cancel(){try{await api(`/api/jobs/${jobId}`,{method:"DELETE"});}catch(e){setError((e as Error).message);}}
  function importFile(){
    if(!file||inFlight.current)return;
    if(file.size>256*1024**2){setError("Максимальный размер входного файла — 256 MiB.");return;}
    inFlight.current=true;setBusy(true);setError("");setUpload(0);
    const request=new XMLHttpRequest();xhr.current=request;request.open("POST",endpoint);request.timeout=180000;request.setRequestHeader("Content-Type","application/octet-stream");
    request.upload.onprogress=event=>setUpload(event.loaded);
    request.onload=()=>{try{const result=JSON.parse(request.responseText);if(request.status!==202)throw Error(errors[result.error]??"Не удалось импортировать файл.");setState(null);setJobId(result.id);}catch(e){setError((e as Error).message);}};
    request.onerror=()=>setError("Не удалось передать файл.");request.ontimeout=()=>setError("Превышено время передачи файла.");
    request.onloadend=()=>{inFlight.current=false;setBusy(false);setUpload(null);xhr.current=null;};request.send(file);
  }
  const imported=Boolean(detail?.replay);
  return <main><Link href="/profile">← К истории матчей</Link><p className="eyebrow">РЕПЛЕЙ МАТЧА</p><h1>Матч {matchId}</h1>
    {!accountId?<p role="alert">Откройте матч из истории выбранного профиля.</p>:<>
      <p className="muted">Игрок {accountId}. Состояние сохраняется: можно закрыть страницу и вернуться позже.</p>
      {detail?.summary&&<section><h2>Статистика матча</h2><p>K / D / A: {detail.summary.kills??"—"} / {detail.summary.deaths??"—"} / {detail.summary.assists??"—"} · {detail.summary.won===null?"Результат неизвестен":detail.summary.won?"Победа":"Поражение"}</p></section>}
      {error&&<p className="notice error" role="alert">{error}</p>}
      <section aria-live="polite"><h2>{imported?"Реплей сохранён":state?states[state.job.status]:"Загрузка реплея"}</h2>
        {state?.job.error&&<p>{errors[state.job.error.code]??"Обработка не завершена. Можно повторить попытку или импортировать файл."}</p>}
        {state?.job.limitations.map(text=><p key={text}>{text}</p>)}
        {state?.queueState==="retry"&&<p>Ожидается автоматическая повторная попытка.</p>}
        {active&&state?.progress&&<p>{phases[state.progress.phase]}: {size(state.progress.bytes)}{state.progress.totalBytes===null?" · общий размер неизвестен":` / ${size(state.progress.totalBytes)}`}</p>}
        <div className="history-actions"><button disabled={busy||active} onClick={()=>void start()}>{state&&!active?"Повторить обработку":"Загрузить и разобрать"}</button>
          {active&&<button disabled={busy} onClick={()=>void cancel()}>Отменить обработку</button>}
          {imported&&<a href={`/api/replays/${encodeURIComponent(matchId)}/file?accountId=${encodeURIComponent(accountId)}`}>Скачать .dem{detail?.replay?` (${size(detail.replay.sizeBytes)})`:""}</a>}</div>
        {!active&&imported&&<p className="muted">Файл проверен. События и наблюдения героев сохраняются при успешном разборе. Карта и аналитический отчёт ещё не подключены.</p>}
      </section>
      <section><h2>Импорт своего реплея</h2><p>Если файл недоступен у источника, выберите .dem, .dem.bz2 или .dem.zst. До 256 MiB; содержимое, матч и участник будут проверены.</p>
        <label>Файл реплея <input type="file" accept=".dem,.bz2,.zst" disabled={busy||active} onChange={e=>setFile(e.target.files?.[0]??null)}/></label>
        <button disabled={!file||busy||active} onClick={importFile}>Импортировать</button>
        {upload!==null&&<p role="status">Передано {size(upload)} / {size(file?.size??0)} <button onClick={()=>xhr.current?.abort()}>Отменить передачу</button></p>}
      </section>
    </>}
  </main>;
}
