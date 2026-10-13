"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
const labels: Record<string,string> = { queued:"В очереди", resolving:"Поиск реплея", downloading:"Подготовка файла", parsing:"Разбор реплея", validating:"Проверка данных", analysing:"Анализ", ready:"Данные готовы", unavailable:"Обработка недоступна", failed:"Ошибка обработки", cancelled:"Отменено" };
const levels: Record<string,string> = {none:"Пока нет данных",summary:"Основная статистика",events:"События матча",replay_context:"Контекст реплея"};
const reports: Record<string,string> = {not_requested:"Отчёт не запрошен",pending:"Отчёт готовится",ready:"Отчёт готов",failed:"Текстовый отчёт недоступен"};
type State = { job:{status:string;dataLevel:string;reportStatus:string;limitations:string[];error:{message:string}|null}; queueState:string|null; attempt:number };
const terminal = new Set(["ready","unavailable","failed","cancelled"]);
export default function JobsPage() {
  const [matchId,setMatchId]=useState(""); const [jobId,setJobId]=useState<string|null>(null);
  const [state,setState]=useState<State|null>(null); const [error,setError]=useState(""); const [busy,setBusy]=useState(false);
  useEffect(()=>{ const saved=new URLSearchParams(window.location.search).get("job"); if(saved)setJobId(saved); },[]);
  useEffect(()=>{
    if(!jobId)return;
    const controller=new AbortController(); let timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{
      try {
        const response=await fetch(`/api/jobs/${encodeURIComponent(jobId)}`,{cache:"no-store",signal:controller.signal});
        if(!response.ok)throw new Error("Не удалось получить состояние. Проверьте запуск базы и worker.");
        const data:State=await response.json();setState(data);setError("");
        if(!terminal.has(data.job.status))timer=setTimeout(poll,1000);
      } catch(err) { if(!controller.signal.aborted){setError((err as Error).message);timer=setTimeout(poll,3000);} }
    };
    void poll();return()=>{controller.abort();clearTimeout(timer);};
  },[jobId]);
  async function start(event:React.FormEvent) {
    event.preventDefault();setBusy(true);setError("");
    try {
      const response=await fetch("/api/jobs",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({matchId})});
      if(!response.ok)throw new Error("Не удалось запустить обработку. Проверьте ID матча и подключение базы.");
      const result=await response.json();if(result.id!==jobId){setState(null);setJobId(result.id);}
      window.history.replaceState(null,"",`?job=${encodeURIComponent(result.id)}`);
    } catch(err){setError((err as Error).message);}finally{setBusy(false);}
  }
  async function cancel() {
    if(!jobId)return;setBusy(true);
    try { const response=await fetch(`/api/jobs/${encodeURIComponent(jobId)}`,{method:"DELETE"});if(!response.ok)throw new Error("Не удалось отменить обработку."); }
    catch(err){setError((err as Error).message);}finally{setBusy(false);}
  }
  const active=state&&!terminal.has(state.job.status);
  return <main>
    <Link href="/">← На главную</Link><p className="eyebrow">ОБРАБОТКА МАТЧА</p><h1>Состояние обработки</h1>
    <p>Можно закрыть вкладку и вернуться по этому адресу. Получение реплеев и анализ подключаются на следующих этапах разработки.</p>
    <form onSubmit={start}><label htmlFor="match-id">ID матча</label><br/>
      <input id="match-id" value={matchId} onChange={event=>setMatchId(event.target.value)} pattern="(0|[1-9][0-9]{0,19})" required inputMode="numeric" maxLength={20}/>{" "}
      <button disabled={busy||Boolean(active)} type="submit">Запустить обработку</button>
    </form>
    {error&&<p role="alert">{error}</p>}
    <section aria-live="polite">{state?<>
      <h2>{labels[state.job.status]??state.job.status}</h2><p>{levels[state.job.dataLevel]} · {reports[state.job.reportStatus]}</p>
      {state.queueState==="retry"&&<p>Ожидается повторная попытка.</p>}
      {state.job.error&&<p>{state.job.error.message}</p>}
      {state.job.limitations.length>0&&<ul>{state.job.limitations.map(text=><li key={text}>{text}</li>)}</ul>}
      {active&&<button onClick={cancel} disabled={busy} type="button">Отменить обработку</button>}
    </>:jobId?<p>Получаем состояние…</p>:<p>Введите ID матча для запуска.</p>}</section>
  </main>;
}
