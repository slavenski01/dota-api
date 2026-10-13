"use client";
import { useCallback,useEffect,useRef,useState,type FormEvent } from "react";
import type { MatchListItem } from "@dota/persistence";
import { useRouter } from "next/navigation";
import heroData from "../../lib/heroes.json";
import { api,sourceError } from "../../lib/source-errors";
const heroes:Record<string,string>=heroData;
type Filters={from:string;to:string;heroId:string;result:string};
type Page={items:MatchListItem[];nextCursor:string|null};
type History={pages:{page_offset:number;row_count:number;fetched_at:string}[];sourceExhausted:boolean;latest:{id:string;status:string;error:string|null;retry_at:string|null}|null};
const reports:Record<string,string>={not_requested:"не запрошен",pending:"готовится",ready:"готов",failed:"недоступен"};
const blank:Filters={from:"",to:"",heroId:"",result:""};
const states:Record<string,string>={not_requested:"Не запрошена",queued:"В очереди",resolving:"Поиск реплея",downloading:"Скачивание",parsing:"Разбор",validating:"Проверка",analysing:"Анализ",ready:"Готово",failed:"Ошибка",cancelled:"Отменено",unavailable:"Недоступно"};
const levels:Record<string,string>={none:"Нет данных",summary:"Сводка",events:"События",replay_context:"Контекст реплея"};
function displayDate(value:string){return new Intl.DateTimeFormat("ru-RU",{timeZone:"UTC",dateStyle:"medium",timeStyle:"short"}).format(new Date(value));}
export default function MatchHistory({accountId}:{accountId:string}) {
  const router=useRouter();const [starting,setStarting]=useState<string|null>(null);const launching=useRef(false);
  async function startMatch(matchId:string){
    if(launching.current)return;launching.current=true;setStarting(matchId);setError("");
    try{await api("/api/jobs",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({matchId,accountId})});router.push(`/matches/${matchId}?accountId=${accountId}`);}
    catch(e){setError(e instanceof Error?e.message:"Не удалось запустить обработку.");}
    finally{launching.current=false;setStarting(null);}
  }
  const [filters,setFilters]=useState<Filters>(blank);const [ready,setReady]=useState(false);
  const [items,setItems]=useState<MatchListItem[]>([]);const [cursor,setCursor]=useState<string|null>(null);
  const [history,setHistory]=useState<History|null>(null);const [loading,setLoading]=useState(false);const [syncing,setSyncing]=useState(false);
  const [error,setError]=useState("");const [notice,setNotice]=useState("");const [retryMode,setRetryMode]=useState<"refresh"|"older"|null>(null);
  const generation=useRef(0);const active=useRef(true);const completed=useRef<string|null>(null);
  useEffect(()=>{active.current=true;return()=>{active.current=false;generation.current++;};},[]);
  useEffect(()=>{
    const restore=()=>{const p=new URLSearchParams(window.location.search);setFilters({from:p.get("from")??"",to:p.get("to")??"",heroId:p.get("heroId")??"",result:p.get("result")??""});setReady(true);};
    restore();window.addEventListener("popstate",restore);return()=>window.removeEventListener("popstate",restore);
  },[]);
  const load=useCallback(async(append=false,next:string|null=null)=>{
    const ticket=++generation.current;setLoading(true);setError("");
    const params=new URLSearchParams({accountId,...filters});if(next)params.set("cursor",next);
    try{
      const page=await api<Page>(`/api/matches?${params}`);
      if(!active.current||ticket!==generation.current)return;
      setItems(previous=>append?[...previous,...page.items.filter(item=>!previous.some(old=>old.matchId===item.matchId))]:page.items);setCursor(page.nextCursor);
    }catch(e){if(active.current&&ticket===generation.current)setError(e instanceof Error?e.message:"Не удалось прочитать матчи.");}
    finally{if(active.current&&ticket===generation.current)setLoading(false);}
  },[accountId,filters]);
  useEffect(()=>{if(ready){setItems([]);setCursor(null);void load();}},[ready,load]);
  useEffect(()=>{
    if(!ready)return;let cancelled=false;let timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{
      try{
        const state=await api<History>(`/api/history?accountId=${accountId}`);if(cancelled)return;
        setHistory(state);setSyncing(state.latest?.status==="queued");
        if(state.latest&&state.latest.status!=="queued"&&completed.current!==state.latest.id){
          completed.current=state.latest.id;
          if(state.latest.status==="ready"){setNotice("История обновлена. Показаны сохранённые матчи.");void load();}
        }
      }catch(e){if(!cancelled)setError(e instanceof Error?e.message:"Не удалось проверить обновление.");}
      if(!cancelled)timer=setTimeout(()=>void poll(),2000);
    };void poll();return()=>{cancelled=true;clearTimeout(timer);};
  },[accountId,ready,load]);
  function apply(event:FormEvent<HTMLFormElement>){
    event.preventDefault();const data=new FormData(event.currentTarget);const next={from:String(data.get("from")),to:String(data.get("to")),heroId:String(data.get("heroId")),result:String(data.get("result"))};
    const url=new URL(window.location.href);for(const [key,value]of Object.entries(next)){if(value)url.searchParams.set(key,value);else url.searchParams.delete(key);}window.history.pushState(null,"",url);setFilters(next);setRetryMode(null);
  }
  async function sync(mode:"refresh"|"older"){
    setSyncing(true);setError("");setNotice("");setRetryMode(mode);
    try{
      const result=await api<{cached:boolean}>("/api/history",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({accountId,mode})});
      if(!active.current)return;
      if(result.cached){setNotice("Доступна сохранённая страница. Повторное обновление источника — не чаще раза в минуту.");setSyncing(false);void load();}
      else setNotice("Обновление поставлено в очередь. Для выполнения должен быть запущен worker.");
    }catch(e){if(active.current){setError(e instanceof Error?e.message:"Не удалось обновить историю.");setSyncing(false);}}
  }
  return <section className="match-section" aria-labelledby="matches-title"><div className="section-heading"><div><p className="label">Сохранённая история</p><h2 id="matches-title">Матчи</h2></div><button disabled={syncing} onClick={()=>void sync("refresh")}>{syncing?"Обновление…":"Обновить последние"}</button></div>
    <p className="muted">Даты и период — UTC. Фильтры применяются к загруженной части истории.</p>
    <form className="filters" onSubmit={apply} key={JSON.stringify(filters)}><label>С даты<input name="from" type="date" defaultValue={filters.from}/></label><label>По дату включительно<input name="to" type="date" defaultValue={filters.to}/></label>
      <label>Герой<select name="heroId" defaultValue={filters.heroId}><option value="">Все герои</option>{filters.heroId&&!heroes[filters.heroId]&&<option value={filters.heroId}>Герой #{filters.heroId}</option>}{Object.entries(heroes).sort((a,b)=>a[1].localeCompare(b[1])).map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></label>
      <label>Результат<select name="result" defaultValue={filters.result}><option value="">Любой</option><option value="win">Победа</option><option value="loss">Поражение</option><option value="unknown">Неизвестен</option></select></label><button>Применить</button></form>
    {notice&&<p className="notice" role="status">{notice}</p>}
    {history?.latest?.status==="failed"&&<div className="notice error" role="alert"><p>{sourceError(history.latest.error??"")}{history.latest.retry_at?` Повтор доступен после ${displayDate(history.latest.retry_at)} UTC.`:""}</p><button disabled={syncing} onClick={()=>void sync(retryMode??"refresh")}>Повторить обновление</button></div>}
    {error&&<div className="notice error" role="alert"><p>{error}</p><button disabled={loading||syncing} onClick={()=>void(retryMode?sync(retryMode):load())}>Повторить запрос</button></div>}
    {loading&&<p role="status">Загрузка списка…</p>}
    {!loading&&!error&&items.length===0&&<p className="notice">{history?.pages.length?"В сохранённой истории нет матчей по этим фильтрам. Пустой ответ источника не доказывает отсутствие игр или приватность профиля.":"История ещё не загружена. Нажмите «Обновить последние»."}</p>}
    {items.length>0&&<div className="table-scroll"><table><caption>Матчи выбранного игрока · время UTC</caption><thead><tr><th>Дата / ID</th><th>Герой</th><th>Результат</th><th>Время</th><th>K / D / A</th><th>Данные и обработка</th><th>Действие</th></tr></thead><tbody>{items.map(item=><tr key={item.matchId}>
      <td>{displayDate(item.startedAt)}<small>{item.matchId}</small></td><td>{item.heroId===null?"Неизвестен":heroes[String(item.heroId)]??`Герой #${item.heroId}`}</td>
      <td className={item.won===null?"muted":item.won?"win":"loss"}>{item.won===null?"Неизвестен":item.won?"Победа":"Поражение"}</td><td>{item.duration===null?"—":`${Math.floor(item.duration/60)}:${String(item.duration%60).padStart(2,"0")}`}</td><td className="numbers">{item.kills??"—"} / {item.deaths??"—"} / {item.assists??"—"}</td>
      <td>{levels[item.dataLevel]??item.dataLevel} · {states[item.processing]??item.processing}<small>{item.storedArtifact?"Есть проверенный реплей":"Доступность реплея не подтверждена"}</small><small>Отчёт: {reports[item.reportStatus]??item.reportStatus}</small>{item.jobId&&<a href={`/jobs?job=${encodeURIComponent(item.jobId)}`}>Состояние задания</a>}</td>
      <td><button disabled={starting!==null} onClick={()=>void startMatch(item.matchId)}>{starting===item.matchId?"Запуск…":"Загрузить и разобрать"}</button><small><a href={`/matches/${item.matchId}?accountId=${accountId}`}>Открыть матч / импорт</a></small></td></tr>)}</tbody></table></div>}
    <div className="history-actions">{cursor&&<button disabled={loading||syncing} onClick={()=>void load(true,cursor)}>Показать ещё сохранённые</button>}<button disabled={syncing||history?.sourceExhausted===true} onClick={()=>void sync("older")}>Загрузить более ранние из источника</button></div>
    <p className="muted">{history?.sourceExhausted?"Достигнут конец доступной выдачи источника. Это не гарантия полной истории.":"Источник возвращает страницы по 50 матчей. Полнота всей истории не гарантируется."}</p>
  </section>;
}
