"use client";
import {useEffect,useRef,useState} from 'react';
import Link from 'next/link';
import type {ComparisonField} from '@dota/analysis';
import type {PracticeView,CoachReportView} from '@dota/jobs';
import {api} from '../../../../lib/source-errors';
const fields:Record<ComparisonField,string>={heroId:'герой',role:'позиция',patch:'патч',mode:'режим',aspect:'аспект',party:'группа',plan:'план'};
const reasons:Record<string,string>={before_experiment:'Игра началась до создания эксперимента',current_match:'Это исходный матч эксперимента',different_player:'Другой игрок',start_unknown:'Дата начала неизвестна',dataset_unavailable:'Нет проверенного набора или есть конфликт',leave_unknown_or_early:'Не подтверждено отсутствие ухода',gap_unknown_or_present:'Не подтверждено отсутствие существенных разрывов'};
for(const [key,label] of Object.entries(fields))reasons[`${key}_mismatch`]=`Не совпадает или неизвестен параметр: ${label}`;
export default function Progress({datasetId,accountId,matchId,analysisId}:{datasetId:string;accountId:string;matchId:string;analysisId:string|null}) {
  const endpoint=`/api/datasets/${encodeURIComponent(datasetId)}/progress?${new URLSearchParams({accountId})}`;
  const [rows,setRows]=useState<PracticeView[]>([]),[selected,setSelected]=useState(''),[reports,setReports]=useState<CoachReportView[]>([]);
  const [action,setAction]=useState(''),[scope,setScope]=useState(''),[author,setAuthor]=useState(''),[reportId,setReportId]=useState<string|null>(null),[relaxed,setRelaxed]=useState<ComparisonField[]>([]);
  const [done,setDone]=useState('0'),[missed,setMissed]=useState('0'),[uncertain,setUncertain]=useState('0'),[note,setNote]=useState(''),[mmr,setMmr]=useState('');
  const [busy,setBusy]=useState(false),[loaded,setLoaded]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
  const pending=useRef<{key:string;body:string}|null>(null);
  const view=rows.find(r=>r.series.id===selected)??rows[0],observation=view?.observations.find(r=>r.matchId===matchId);
  async function refresh(){const next=await api<PracticeView[]>(endpoint);setRows(next);setLoaded(true);}
  useEffect(()=>{const c=new AbortController();api<PracticeView[]>(endpoint,{signal:c.signal}).then(r=>{setRows(r);setLoaded(true);}).catch(e=>{if(!c.signal.aborted)setError(e.message);});return()=>c.abort();},[endpoint]);
  useEffect(()=>{if(!analysisId){setReports([]);return;}const c=new AbortController();api<{reports:CoachReportView[]}>(`/api/datasets/${datasetId}/coach?${new URLSearchParams({accountId,analysisId})}`,{signal:c.signal}).then(r=>setReports(r.reports.filter(r=>r.status==='ready'&&r.output))).catch(()=>setReports([]));return()=>c.abort();},[datasetId,accountId,analysisId]);
  useEffect(()=>{setDone(String(observation?.done??0));setMissed(String(observation?.missed??0));setUncertain(String(observation?.uncertain??0));setNote(observation?.note??'');setMmr(observation?.mmr==null?'':String(observation.mmr));},[view?.series.id,observation?.version]);
  async function submit(kind:'create'|'observe') {
    if(busy)return;setBusy(true);setError('');setMessage('');
    try {
      let value:unknown;
      if(kind==='create') {const input={action,scope,author,reportId,filters:{relaxed,additional:[]}},body=JSON.stringify(input);if(pending.current?.body!==body)pending.current={key:crypto.randomUUID(),body};value={...input,id:pending.current.key};}
      else value={seriesId:view!.series.id,expectedVersion:observation?.version??0,done:Number(done),missed:Number(missed),uncertain:Number(uncertain),note,author,mmr:mmr===''?null:Number(mmr)};
      const saved=await api<{id?:string}>(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:kind,value})});
      if(kind==='create'){pending.current=null;setSelected(saved.id!);}await refresh();setMessage(kind==='create'?'Эксперимент сохранён. Отмечайте следующие подходящие игры на их страницах сравнения.':'Наблюдение сохранено.');
    }catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  const countsValid=[done,missed,uncertain].every(s=>/^\d+$/.test(s)&&Number(s)<=10000);
  return <section aria-label="Наблюдение за действием"><h2>Одно действие в пяти играх</h2><p>Выберите наблюдаемое действие и укажите, когда оно применимо. Это личный эксперимент; он не доказывает причину изменения побед или MMR.</p>
    {error&&<p role="alert">{error} <button disabled={busy} onClick={()=>void refresh().then(()=>setError('')).catch(e=>setError(e.message))}>Обновить наблюдения</button></p>}{message&&<p role="status">{message}</p>}
    <details><summary>Начать новый эксперимент</summary><fieldset disabled={!loaded||busy}>
      {reports.length>0&&<label>Взять действие из отчёта <select value={reportId??''} onChange={e=>{const r=reports.find(r=>r.id===e.target.value);setReportId(r?.id??null);if(r?.output)setAction(r.output.nextAction.text);}}><option value="">Своё действие</option>{reports.map(r=><option key={r.id} value={r.id}>Версия {r.version}: {r.output!.nextAction.text}</option>)}</select></label>}
      <label>Наблюдаемое действие <textarea value={action} maxLength={1000} onChange={e=>setAction(e.target.value)} placeholder="Перед входом в бой проверить, могут ли союзники продолжить"/></label>
      <label>Когда возникает подходящая возможность <textarea value={scope} maxLength={1000} onChange={e=>setScope(e.target.value)} placeholder="Перед добровольным входом в бой, когда есть время оценить союзников"/></label>
      <p>По умолчанию серия требует того же героя, позиции, патча и режима. Неизвестные обязательные сведения сначала подтвердите в контексте матча.</p>
      {(['heroId','role','patch','mode'] as const).map(f=><label key={f}><input type="checkbox" checked={relaxed.includes(f)} onChange={e=>setRelaxed(e.target.checked?[...relaxed,f]:relaxed.filter(k=>k!==f))}/>Разрешить различия: {fields[f]}</label>)}
      <button disabled={action.trim().length<8||scope.trim().length<8||!author.trim()} onClick={()=>void submit('create')}>Начать серию из пяти игр</button>
    </fieldset></details>
    <label>Автор наблюдений <input value={author} maxLength={100} onChange={e=>setAuthor(e.target.value)}/></label>
    {view&&<><label>Эксперимент <select value={view.series.id} onChange={e=>setSelected(e.target.value)}>{rows.map(r=><option key={r.series.id} value={r.series.id}>{r.series.action} · {r.observations.length}/5</option>)}</select></label>
      <h3>{view.series.action}</h3><p>Область применения: {view.series.scope}</p><p>Ослабленные условия: {view.series.filters.relaxed.map(f=>fields[f]).join(', ')||'нет'}. Начало: {new Date(view.series.createdAt).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})} МСК.</p>
      <p>{view.observations.length}/5 игр · просмотрено возможностей {view.totals.reviewed} · выполнено {view.totals.done} · пропущено {view.totals.missed} · неопределённо {view.totals.uncertain}.</p>
      <p>Доля выполнения среди определённых случаев: {view.totals.rate===null?'не определена':`${(view.totals.rate*100).toFixed(1)}%`} ({view.totals.done}/{view.totals.known}). Игр без возможностей: {view.totals.noOpportunityGames}; это не успех и не провал.</p>
      {view.complete&&<p className="notice">Пять игр отмечены. Итог описывает наблюдаемое действие; связь с победами и рейтингом не установлена.</p>}
      <div className="table-scroll"><table><thead><tr><th>Игра</th><th>Выполнено / пропущено / неопределённо</th><th>Контекст результата</th><th>Наблюдение</th></tr></thead><tbody>{view.observations.map(o=><tr key={o.matchId}><td><Link href={`/matches/${o.matchId}/compare?${new URLSearchParams({accountId,datasetId:o.datasetId})}`}>{o.matchId}</Link></td><td>{o.done} / {o.missed} / {o.uncertain}</td><td>{o.match.won===null?'Исход неизвестен':o.match.won?'Победа':'Поражение'} · MMR {o.mmr??'неизвестен'}</td><td>{o.note} · {o.author} · версия {o.version}</td></tr>)}</tbody></table></div>
      {view.eligibility.length>0?<p>Для этой игры запись недоступна: {view.eligibility.map(r=>reasons[r]??r).join('; ')}.</p>:(!view.complete||observation)&&<fieldset disabled={busy}>
        <legend>Наблюдение в матче {matchId}</legend><p>Считайте только просмотренные подходящие возможности. Если их не было, оставьте три нуля и поясните это в заметке.</p>
        {([['Выполнено',done,setDone],['Пропущено',missed,setMissed],['Неопределённо',uncertain,setUncertain]] as const).map(([label,v,set])=><label key={label}>{label} <input type="number" min="0" max="10000" step="1" value={v} onChange={e=>set(e.target.value)}/></label>)}
        <label>Что просмотрено и на чём основаны счётчики <textarea maxLength={2000} value={note} onChange={e=>setNote(e.target.value)}/></label>
        <label>MMR после этой игры, если известен <input type="number" min="0" max="30000" value={mmr} onChange={e=>setMmr(e.target.value)}/></label>
        <button disabled={!countsValid||!note.trim()||!author.trim()} onClick={()=>void submit('observe')}>{observation?'Сохранить исправление':'Сохранить наблюдение'}</button>
      </fieldset>}
      <details><summary>История исправлений ({view.history.length})</summary><ul>{view.history.map(o=><li key={`${o.matchId}:${o.version}`}>Матч {o.matchId}, версия {o.version}: {o.done}/{o.missed}/{o.uncertain}; {o.note} — {o.author}, {new Date(o.recordedAt).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})} МСК. MMR указан автором: {o.mmr??'неизвестен'}.</li>)}</ul></details>
    </>}
  </section>;
}
