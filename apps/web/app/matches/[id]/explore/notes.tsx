"use client";
import { useEffect, useRef, useState } from "react";
import type { MatchNote, NoteCoachReference, ViewMode } from "@dota/jobs";
import { api } from "../../../../lib/source-errors";
import { gameTime } from "../../../../lib/game-time";
import { coachReportLink } from '../../../../lib/coach-links';

export default function MatchNotes({datasetId,accountId,matchId,time,slot,mode,heroName,coach,reportVersion}:{datasetId:string;accountId:string;matchId:string;time:number;slot:number;mode:ViewMode;heroName:string;coach?:NoteCoachReference|undefined;reportVersion?:number|undefined}) {
  const [notes,setNotes]=useState<MatchNote[]|null>(null),[content,setContent]=useState(""),[error,setError]=useState(""),[notice,setNotice]=useState(""),[busy,setBusy]=useState(false),[retry,setRetry]=useState(0);
  const inFlight=useRef(false),pending=useRef<{key:string;id:string}|null>(null);
  const endpoint=`/api/datasets/${encodeURIComponent(datasetId)}/notes?accountId=${encodeURIComponent(accountId)}`;
  useEffect(()=>{
    const controller=new AbortController();setNotes(null);setError("");
    void api<{notes:MatchNote[]}>(`${endpoint}&mode=${mode}`,{signal:controller.signal}).then(r=>{if(!controller.signal.aborted)setNotes(r.notes);}).catch(e=>{if(!controller.signal.aborted)setError(e.message);});
    return()=>controller.abort();
  },[endpoint,mode,retry]);
  async function save() {
    if(inFlight.current||!content.trim())return;
    const payload={time,playerSlot:slot,mode,content:content.trim(),...(coach?{coach}:{})},key=JSON.stringify(payload);
    if(pending.current?.key!==key)pending.current={key,id:crypto.randomUUID()};
    inFlight.current=true;setBusy(true);setError("");setNotice("");
    try {
      const note=await api<MatchNote>(endpoint,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:pending.current.id,...payload})});
      setNotes(current=>[...(current??[]).filter(n=>n.id!==note.id),note].sort((a,b)=>a.time-b.time||a.id.localeCompare(b.id)));
      setContent("");pending.current=null;setRetry(n=>n+1);setNotice(`Заметка сохранена: ${gameTime(note.time)}.`);
    }catch(e){setError((e as Error).message);}finally{inFlight.current=false;setBusy(false);}
  }
  const visible=coach?notes?.filter(n=>n.coach?.reportId===coach.reportId&&n.coach.episodeId===coach.episodeId):notes;
  const link=(note:MatchNote)=>`/matches/${encodeURIComponent(matchId)}/${note.coach?`episodes/${encodeURIComponent(note.coach.episodeId)}`:'explore'}?${new URLSearchParams({accountId,datasetId,time:String(note.time),hero:String(note.playerSlot),mode:note.mode,...(note.coach?{analysisId:note.coach.analysisId,reportId:note.coach.reportId}:{})})}`;
  return <section className="review-editor"><h2>Мои заметки</h2><p>К моменту {gameTime(time)} · {heroName} · {mode==='retrospective'?'полный обзор':'перспектива команды'}. Заметка сохраняет текущие время, героя и перспективу.</p>
    {coach&&<p>Заметки этого эпизода к версии отчёта {reportVersion}. Они не меняют выводы отчёта и не передаются тренеру. Для обновления разбора сохраните ручную оценку и явно создайте новую версию.</p>}
    <p className="muted">Ваши наблюдения, без автоматической оценки ошибок. Здесь заметки выбранного набора и перспективы; после повторного разбора они остаются по старым ссылкам.</p>
    <form onSubmit={e=>{e.preventDefault();void save();}}><label>Текст заметки<textarea maxLength={2000} disabled={busy} value={content} onChange={e=>setContent(e.target.value)}/></label><button disabled={busy||!content.trim()}>{busy?'Сохранение…':'Сохранить заметку'}</button></form>
    {notice&&<p role="status">{notice}</p>}{error&&<p role="alert">{error} <button onClick={()=>setRetry(n=>n+1)}>Обновить список</button></p>}
    {notes===null&&!error?<p role="status">Загрузка заметок…</p>:visible?.length?<ul>{visible.map(note=><li key={note.id}><a href={link(note)}>{gameTime(note.time)} · слот {note.playerSlot}</a><p style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{note.content}</p><small>{new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',dateStyle:'short',timeStyle:'short'}).format(new Date(note.createdAt))} МСК</small>{note.coach&&<p><a href={coachReportLink(matchId,datasetId,note.coach.analysisId,accountId,note.coach.reportId)}>К связанной версии отчёта</a></p>}</li>)}</ul>:notes&&<p>Заметок в этой перспективе пока нет.</p>}
  </section>;
}
