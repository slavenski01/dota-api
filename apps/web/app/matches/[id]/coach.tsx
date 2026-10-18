"use client";
import {useEffect,useRef,useState} from 'react';
import {useSearchParams} from 'next/navigation';
import type {CoachReportView,CoachSettings} from '@dota/jobs';
import {api,sourceError} from '../../../lib/source-errors';
import {coachReportLink} from '../../../lib/coach-links';
const time=(s:number)=>`${s<0?'−':''}${Math.floor(Math.abs(s)/60)}:${String(Math.floor(Math.abs(s)%60)).padStart(2,'0')}`;
const reviewLabels={unreviewed:'Не проверено',confirmed_error:'Ошибка подтверждена автором оценки',justified:'Оправдано по ручной оценке',uncertain:'Вывод неопределён'};
const goals={overview:'Общий разбор',deaths_trades:'Смерти и размены',objectives:'Потери объектов',item_timing:'После ключевого предмета'};
export default function MatchCoach({matchId,datasetId,analysisId,accountId,pinned=false}:{matchId:string;datasetId:string;analysisId:string;accountId:string;pinned?:boolean}) {
  const search=useSearchParams(),selected=pinned?search.get('reportId')??'':'';
  const [reports,setReports]=useState<CoachReportView[]>([]),[error,setError]=useState(''),[loadError,setLoadError]=useState(''),[loading,setLoading]=useState(true),[sending,setSending]=useState(false);
  const [role,setRole]=useState(''),[goal,setGoal]=useState<CoachSettings['goal']>('overview');
  const pending=useRef<{key:string;settings:CoachSettings}|null>(null);
  const endpoint=`/api/datasets/${encodeURIComponent(datasetId)}/coach?${new URLSearchParams({accountId,analysisId})}`;
  async function refresh(signal?:AbortSignal) {
    const options=signal?{signal}:undefined;
    const response=await api<{reports:CoachReportView[]}>(endpoint,options);
    const exact=selected?await api<{reports:CoachReportView[]}>(`${endpoint}&${new URLSearchParams({reportId:selected})}`,options):null;
    const rows=exact?[...response.reports.filter(r=>r.id!==selected),...exact.reports].sort((a,b)=>b.version-a.version):response.reports;
    if(rows.some(r=>r.context.matchId!==matchId))throw new Error('Отчёт относится к другому матчу.');
    setReports(rows);setLoading(false);
  }
  useEffect(()=>{
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{try{await refresh(controller.signal);setLoadError('');}catch(e){if(!controller.signal.aborted){setLoadError((e as Error).message);setLoading(false);}}finally{if(!controller.signal.aborted)timer=setTimeout(poll,2500);}};
    void poll();return()=>{controller.abort();clearTimeout(timer);};
  },[endpoint,selected,matchId]);
  function select(id:string){window.location.assign(coachReportLink(matchId,datasetId,analysisId,accountId,id));}
  async function start() {
    if(sending)return;setSending(true);setError('');
    const settings:CoachSettings={role:role?Number(role) as CoachSettings['role']:null,goal};
    if(!pending.current||JSON.stringify(pending.current.settings)!==JSON.stringify(settings))pending.current={key:crypto.randomUUID(),settings};
    try {
      const response=await api<{id:string}>(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestKey:pending.current.key,settings})});
      pending.current=null;select(response.id);
    }catch(e){setError((e as Error).message);}finally{setSending(false);}
  }
  const active=reports.some(r=>['queued','running'].includes(r.status));
  const report=selected?reports.find(r=>r.id===selected):reports[0];
  const facts=new Map(report?.context.facts.map(f=>[f.id,f])??[]);
  const output=report?.output;
  const episodeLink=(id:string)=>`/matches/${encodeURIComponent(matchId)}/episodes/${encodeURIComponent(id)}?${new URLSearchParams({datasetId,accountId,analysisId,reportId:report!.id,time:String(report!.context.episodes.find(e=>e.id===id)!.time),hero:String(report!.context.playerSlot),mode:'retrospective'})}`;
  return <section className="coach-report" aria-label="AI-тренер"><h2>AI-тренер</h2>
    <p>Разбор по доступным фактам с вопросами к просмотру. Использует общий лимит вашей подписки Codex.</p>
    <div className="coach-form"><label>Подтверждённая позиция в этом матче<select value={role} onChange={e=>setRole(e.target.value)} disabled={sending||active}>
      <option value="">Неизвестна</option>{[1,2,3,4,5].map(r=><option key={r} value={r}>Позиция {r}</option>)}</select></label>
      <label>Цель разбора<select value={goal} onChange={e=>setGoal(e.target.value as CoachSettings['goal'])} disabled={sending||active}>{Object.entries(goals).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
      <button onClick={()=>void start()} disabled={loading||sending||active}>{sending?'Отправка…':active?'Разбор выполняется…':reports.length?'Создать новую версию':'Получить разбор'}</button></div>
    {goal==='item_timing'&&<p className="muted">Используется ключевой предмет и план, выбранные при обработке матча. Если они не заданы, это направление будет пропущено.</p>}
    {(error||loadError)&&<p role="alert">{error||loadError}</p>}{loading&&<p role="status">Загрузка отчётов…</p>}
    {reports.length>0&&report&&<label>Версия отчёта<select value={report.id} onChange={e=>select(e.target.value)}>{reports.map(r=><option key={r.id} value={r.id}>Версия {r.version} · {new Date(r.createdAt).toLocaleString('ru-RU')} · {r.status==='ready'?'Готово':r.status==='failed'?'Не завершена':r.status==='queued'?'В очереди':'Выполняется'}</option>)}</select></label>}
    {report&&<p><a href={coachReportLink(matchId,datasetId,analysisId,accountId,report.id)}>Постоянная ссылка на версию {report.version}</a></p>}
    {report&&<><p className="muted">{goals[report.context.settings.goal]} · {report.context.settings.role===null?'Позиция неизвестна':`Позиция ${report.context.settings.role}, указана вами`} · Рейтинг неизвестен</p>
      {report.stale&&<p className="notice">Ручная оценка или методика изменились. Этот отчёт сохранён с прежними входами; создайте новую версию для обновления.</p>}
      {['queued','running'].includes(report.status)&&<p role="status">{report.status==='queued'?'Задание в очереди.':'Codex готовит разбор.'} Можно закрыть страницу; результат сохранится.</p>}
      {report.status==='failed'&&<p role="alert">{sourceError(report.error??'coach_provider_failed')} Статистика и эпизоды доступны ниже.</p>}
      {output&&<><h3>Сводка по фактам</h3><ul>{output.summaryFactIds.map(id=><li key={id}>{facts.get(id)?.text}</li>)}</ul>
        {report.context.outcome!=='candidates'&&<p>{report.context.outcome==='no_candidates'?'Проверенные правила не нашли кандидатов.':'Для части правил данных недостаточно; кандидаты не найдены.'} Это не доказывает отсутствие ошибок.</p>}
        {output.episodes.map(e=>{const context=report.context.episodes.find(x=>x.id===e.episodeId)!;return <article key={e.episodeId}>
          <h3>{time(context.time)} · Эпизод для проверки</h3><ul>{e.factIds.map(id=><li key={id}>{facts.get(id)?.text}</li>)}</ul>
          <p><strong>Гипотеза:</strong> {e.hypothesis}</p><p><strong>Вопрос к просмотру:</strong> {e.question}</p>
          <p>Ручная проверка: {context.review?`${reviewLabels[context.review.status]} (версия ${context.review.version})`:'Не выполнена'}.</p>
          {context.review&&<details><summary>Оценка, использованная в отчёте</summary><p>{context.review.explanation}</p>{context.review.alternative&&<p>Альтернатива автора: {context.review.alternative}</p>}</details>}
          <a href={episodeLink(e.episodeId)}>Открыть эпизод</a><details><summary>Основания и ограничения</summary>{context.limitations.map((text,i)=><p key={i}>{text}</p>)}<p>Обзор, готовность ресурсов и выполнимость альтернатив не установлены.</p><ul>{e.factIds.map(id=><li key={id}>{id}: {facts.get(id)?.evidenceIds.join(', ')}</li>)}</ul></details>
        </article>;})}
        <h3>{output.nextAction.kind==='experiment'?'Следующее действие — эксперимент':'Следующее действие — проверка'}</h3><p>{output.nextAction.text}</p>
        {output.nextAction.kind==='review'&&<p className="muted">Обзор команды и готовность способностей в этом просмотрщике не подтверждены. Если для проверки они нужны, используйте доступный материал из клиента игры; без него оставьте вывод неопределённым.</p>}
        {output.nextAction.episodeId&&<a href={episodeLink(output.nextAction.episodeId)}>Перейти к выбранному эпизоду</a>}
      </>}
      <details><summary>Что ограничивает выводы</summary>{report.context.limitations.map((text,i)=><p key={i}>{text}</p>)}
        {report.context.skipped.map((s,i)=><p key={i}>{s.ruleId}: {s.reasons.join('; ')}</p>)}</details>
      <details><summary>Данные запуска</summary><p>Модель: {report.model} · {report.reasoning}. {report.durationMs===null?'Длительность неизвестна':`${(report.durationMs/1000).toFixed(1)} с`}.</p>
        <p>{report.usage?`Токены: ${report.usage.inputTokens} входных (${report.usage.cachedInputTokens} из кэша), ${report.usage.outputTokens} выходных.`:'Расход токенов неизвестен.'} Стоимость в деньгах не предоставлена; используется подписка.</p>
        <p>Версия формата: {report.versions.schema}. CLI: {report.cliVersion??'неизвестна'}.</p><p className="coach-hash">Хеш контекста: {report.versions.contextSha256}<br/>Хеш методики: {report.versions.skillSha256}</p></details>
    </>}
  </section>;
}
