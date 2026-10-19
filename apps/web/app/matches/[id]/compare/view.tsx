"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { ComparisonContext, ComparisonField, ComparisonMatch } from "@dota/analysis";
import type { ComparisonView, readComparisonContext } from "@dota/jobs";
import { api } from "../../../../lib/source-errors";
import { heroName } from "../../../../lib/hero-catalog";
type ContextView = Awaited<ReturnType<typeof readComparisonContext>>;
const empty: ComparisonContext = { role:null,patch:null,aspect:null,party:null,plan:null,earlyLeave:null,dataGap:null };
const fields: Record<ComparisonField,string> = {heroId:'Герой',role:'Позиция',patch:'Патч',mode:'Режим',aspect:'Аспект',party:'Группа',plan:'План игры'};
const labels: Record<string,string> = {kills:'Убийства за матч',deaths:'Смерти за матч',assists:'Ассисты за матч',lastHits:'Добивания за матч',denies:'Денаи за матч',gpm:'GPM',xpm:'XPM',heroDamage:'Урон героям за матч',towerDamage:'Урон строениям за матч'};
const reasons: Record<string,string> = {different_player:'Другой игрок',current_match:'Текущий матч',duplicate_match:'Повтор матча',start_unknown:'Неизвестна дата начала',not_previous:'Матч не предшествует текущему',dataset_unavailable:'Нет проверенного набора',source_conflict:'Конфликт источников',early_leave:'Преждевременный уход',leave_unknown:'Уход не проверен',data_gap:'Существенный разрыв данных',gap_unknown:'Разрывы не проверены'};
for (const [key,label] of Object.entries(fields)) { reasons[`${key}_unknown`]=`${label}: неизвестно`;reasons[`${key}_different`]=`${label}: отличается`; }
const value = (n:number|null|undefined) => n == null ? '—' : new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2}).format(n);
export default function Comparison({matchId,datasetId,accountId}:{matchId:string;datasetId:string;accountId:string}) {
  const endpoint=`/api/datasets/${encodeURIComponent(datasetId)}/comparisons?${new URLSearchParams({accountId})}`;
  const [runs,setRuns]=useState<ComparisonView[]>([]),[selected,setSelected]=useState(''),[context,setContext]=useState<ContextView|null>(null);
  const [form,setForm]=useState<ComparisonContext>(empty),[author,setAuthor]=useState(''),[relaxed,setRelaxed]=useState<ComparisonField[]>([]),[additional,setAdditional]=useState<ComparisonField[]>([]);
  const [busy,setBusy]=useState(false),[loaded,setLoaded]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
  const run=runs.find(r=>r.id===selected)??runs[0];
  async function load() {
    const data=await api<{runs:ComparisonView[];context:ContextView}>(endpoint);setRuns(data.runs);setContext(data.context);
    const saved=data.context.current?.payload;setForm(saved?Object.fromEntries(Object.keys(empty).map(k=>[k,saved[k]])) as unknown as ComparisonContext:empty);setAuthor(saved?.author??'');setLoaded(true);
  }
  useEffect(()=>{let alive=true;api<{runs:ComparisonView[];context:ContextView}>(endpoint).then(data=>{if(!alive)return;setRuns(data.runs);setContext(data.context);const saved=data.context.current?.payload;setForm(saved?{...empty,...saved}:empty);setAuthor(saved?.author??'');setLoaded(true);}).catch(e=>{if(alive)setError(e.message);});return()=>{alive=false;};},[endpoint]);
  async function submit(action:'context'|'compare') {
    if(busy)return;setBusy(true);setError('');setMessage('');
    try {const input=action==='context'?{...Object.fromEntries(Object.keys(empty).map(k=>[k,form[k as keyof ComparisonContext]])),author,expectedVersion:context?.current?.version??0}:{relaxed,additional};
      const response=await api<ComparisonView>(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,value:input})});
      await load();if(action==='compare')setSelected(response.id);setMessage(action==='context'?'Контекст сохранён. Создайте сравнение, чтобы применить изменения.':'Сравнение сохранено.');
    } catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  function matchLink(m:ComparisonMatch) {return m.datasetId?<Link href={`/matches/${m.matchId}/compare?${new URLSearchParams({accountId,datasetId:m.datasetId})}`}>Матч {m.matchId}</Link>:<Link href={`/matches/${m.matchId}?${new URLSearchParams({accountId})}`}>Матч {m.matchId}</Link>;}
  return <main><Link href={`/matches/${matchId}?${new URLSearchParams({accountId})}`}>← К матчу</Link><p className="eyebrow">СОБСТВЕННАЯ БАЗА</p><h1>Сравнение матчей</h1>
    <p>Матч {matchId}. Сравниваются только сохранённые предыдущие игры выбранного игрока, включая победы и поражения.</p>
    {error&&<p role="alert" className="notice error">{error} <button disabled={busy} onClick={()=>void load().then(()=>setError('')).catch(e=>setError(e.message))}>Повторить загрузку</button></p>}
    {message&&<p role="status">{message}</p>}
    <section><h2>Подтверждённый контекст этой игры</h2><p>Укажите только проверенные сведения. Неизвестные роль и патч не считаются совпадением. Уход и существенные разрывы проверяются для каждой игры базы.</p>
      <fieldset disabled={!loaded||busy}><label>Позиция <select value={form.role??''} onChange={e=>setForm({...form,role:e.target.value?Number(e.target.value) as ComparisonContext['role']:null})}><option value="">Неизвестно</option>{[1,2,3,4,5].map(n=><option key={n} value={n}>{n}</option>)}</select></label>
      {(['patch','aspect','plan'] as const).map(key=><label key={key}>{fields[key]} <input value={form[key]??''} maxLength={key==='plan'?500:64} onChange={e=>setForm({...form,[key]:e.target.value||null})}/></label>)}
      <label>Группа <select value={form.party??''} onChange={e=>setForm({...form,party:e.target.value as ComparisonContext['party']||null})}><option value="">Неизвестно</option><option value="solo">Одиночная игра</option><option value="party">В группе</option></select></label>
      {(['earlyLeave','dataGap'] as const).map(key=><label key={key}>{key==='earlyLeave'?'Был преждевременный уход участника':'Был существенный разрыв данных'} <select value={form[key]===null?'':String(form[key])} onChange={e=>setForm({...form,[key]:e.target.value===''?null:e.target.value==='true'})}><option value="">Не проверено</option><option value="false">Нет, проверено</option><option value="true">Да</option></select></label>)}
      <label>Автор подтверждения <input value={author} maxLength={100} onChange={e=>setAuthor(e.target.value)}/></label><button disabled={!author.trim()} onClick={()=>void submit('context')}>Сохранить контекст</button></fieldset>
      {context?.current&&<p className="muted">Версия {context.current.version} · {context.current.payload.author} · {new Date(context.current.created_at).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})} МСК · источник: подтверждение пользователя.</p>}
    </section>
    <section><h2>Условия сравнения</h2><fieldset disabled={!loaded||busy}><p>По умолчанию совпадают герой, позиция, патч и режим.</p>
      {(['heroId','role','patch','mode'] as const).map(key=><label key={key}><input type="checkbox" checked={relaxed.includes(key)} onChange={e=>setRelaxed(e.target.checked?[...relaxed,key]:relaxed.filter(k=>k!==key))}/> Разрешить различия: {fields[key].toLowerCase()}</label>)}
      {(['aspect','party','plan'] as const).map(key=><label key={key}><input type="checkbox" checked={additional.includes(key)} onChange={e=>setAdditional(e.target.checked?[...additional,key]:additional.filter(k=>k!==key))}/> Дополнительно совпадает: {fields[key].toLowerCase()}</label>)}
      <button onClick={()=>void submit('compare')}>{busy?'Сохранение…':'Создать сравнение'}</button></fieldset>
    </section>
    {run&&<><section><h2>Сохранённое сравнение</h2><label>Версия <select value={run.id} onChange={e=>setSelected(e.target.value)}>{runs.map(r=><option key={r.id} value={r.id}>{new Date(r.createdAt).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})} МСК · {r.selection.included.length} игр</option>)}</select></label>
      <p>В базе {run.selection.included.length} игр; исключено {run.selection.excluded.length}. Размер выборки указан отдельно для каждого показателя.</p>
      <p>Ослабленные условия: {run.selection.filters.relaxed.map(f=>fields[f]).join(', ')||'нет'}. Дополнительные: {run.selection.filters.additional.map(f=>fields[f]).join(', ')||'нет'}.</p>
      {run.truncated&&<p className="notice">Проверены только последние {run.inspectedLimit} сохранённых игр; история больше этого лимита.</p>}
      <p className="notice">Это описательное сравнение. Итоговые показатели зависят от длительности и обстоятельств; малая выборка не задаёт норму качества игры.</p>
      <div className="table-scroll"><table><thead><tr><th>Показатель</th><th>Этот матч</th><th>n</th><th>Медиана</th><th>Q1–Q3</th><th>Минимум–максимум</th></tr></thead><tbody>{Object.entries(run.metrics).map(([key,m])=><tr key={key}><th>{labels[key]??key}</th><td>{value(m.current.value)}</td><td>{m.n}</td><td>{value(m.median)}</td><td>{value(m.q1)}–{value(m.q3)}</td><td>{value(m.min)}–{value(m.max)}</td></tr>)}</tbody></table></div>
    </section><section><h2>Состав выборки</h2><div className="table-scroll"><table><thead><tr><th>Матч</th><th>Герой</th><th>Результат</th><th>Контекст</th><th>Отбор</th></tr></thead><tbody>{[...run.selection.included.map(match=>({match,reasons:[]})),...run.selection.excluded].map(({match:m,reasons:why})=><tr key={m.matchId}><td>{matchLink(m)}</td><td>{heroName(m.heroId)}</td><td>{m.won===null?'Неизвестно':m.won?'Победа':'Поражение'}</td><td>Позиция {m.role??'—'}; патч {m.patch??'—'}; режим {m.mode??'—'}; версия {m.contextVersion}</td><td>{why.length?why.map(r=>reasons[r]??r).join('; '):'Включён'}</td></tr>)}</tbody></table></div><p className="muted">Откройте матч, чтобы уточнить его контекст. Сохранённые сравнения сохраняют прежние входные данные.</p></section></>}
  </main>;
}
