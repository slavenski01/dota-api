"use client";
import { useEffect, useState, type FormEvent } from "react";
import type { ReviewHistory } from "@dota/jobs";
import type { Review } from "@dota/contracts";
import { api } from "../../../../../lib/source-errors";
const labels: Record<Review["status"],string> = { unreviewed: "Не проверено", confirmed_error: "Подтверждённая ошибка", justified: "Оправданное действие", uncertain: "Неопределённо" };
const materials: Record<Review["material"],string> = {timeline:"Таймлайн и состояния",map:"Карта",dota_client:"Клиент Dota 2"};
const stamp = (value: string) => new Intl.DateTimeFormat("ru-RU",{timeZone:"Europe/Moscow",dateStyle:"medium",timeStyle:"medium"}).format(new Date(value)) + " МСК";
export default function EpisodeReviews({ endpoint, accountId, playerSlot }: { endpoint: string; accountId: string; playerSlot: number }) {
  const [history,setHistory]=useState<ReviewHistory|null>(null),[error,setError]=useState(""),[notice,setNotice]=useState(""),[busy,setBusy]=useState(false);
  const [status,setStatus]=useState<Review["status"]>("unreviewed"),[explanation,setExplanation]=useState(""),[alternative,setAlternative]=useState(""),[author,setAuthor]=useState("");
  const [material,setMaterial]=useState<Review["material"]>("timeline"),[perspective,setPerspective]=useState("omniscient");
  const url=`${endpoint}/reviews?accountId=${encodeURIComponent(accountId)}`;
  function apply(value: ReviewHistory) {
    setHistory(value);const r=value.current;setStatus(r?.status??"unreviewed");setExplanation(r?.explanation??"");setAlternative(r?.alternative??"");setAuthor(r?.author??"");setMaterial(r?.material??"timeline");setPerspective(r?.perspective.mode??"omniscient");
  }
  useEffect(()=>{const controller=new AbortController();void api<ReviewHistory>(url,{signal:controller.signal}).then(value=>{if(!controller.signal.aborted)apply(value);}).catch(e=>{if(!controller.signal.aborted)setError(e.message);});return()=>controller.abort();},[url]);
  async function reload(){setBusy(true);setError("");setNotice("");try{apply(await api<ReviewHistory>(url));}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  async function save(event: FormEvent){
    event.preventDefault();if(busy||!history)return;setBusy(true);setError("");setNotice("");
    try{const value=await api<ReviewHistory>(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({expectedVersion:history.current?.version??0,status,explanation,alternative:alternative.trim()||null,author,material,
      perspective:perspective==="omniscient"?{mode:"omniscient"}:{mode:"team",team:playerSlot<128?"radiant":"dire"}})});apply(value);setNotice(`Оценка сохранена. Версия ${value.current!.version}.`);}
    catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  return <section className="review-editor"><h2>Ручная проверка</h2>
    <p>Текущий статус: <strong>{history ? labels[history.current?.status??"unreviewed"] : "загрузка…"}</strong>. Автоматический отбор этот статус не меняет.</p>
    <p className="muted">Оценка относится к этой версии эпизода и данных. После повторного разбора новая версия требует отдельной проверки. Укажите фактический источник и пределы своей проверки.</p>
    {material === "map" && <p className="notice">Карта использует приблизительную подложку 7.40. Проверка по ней относится к полному обзору и не подтверждает, что игрок видел угрозу, или что нарисованный путь был проходим.</p>}
    {error&&<p role="alert" className="notice error">{error}</p>}{notice&&<p role="status" className="notice">{notice}</p>}
    <form onSubmit={event=>void save(event)}><fieldset disabled={busy||!history}>
      <label>Результат проверки <select value={status} onChange={e=>setStatus(e.target.value as Review["status"])}>{Object.entries(labels).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
      <label>Пояснение и основания <textarea required maxLength={2000} value={explanation} onChange={e=>setExplanation(e.target.value)} placeholder="Что проверено, какие сведения подтверждают оценку и что осталось неизвестным"/></label>
      <label>Выполнимая альтернатива {status==="confirmed_error"?"(обязательно)":"(если установлена)"}<textarea required={status==="confirmed_error"} maxLength={2000} value={alternative} onChange={e=>setAlternative(e.target.value)} placeholder="Какое действие было доступно и почему его можно было выполнить"/></label>
      <label>Источник проверки <select value={material} onChange={e=>{setMaterial(e.target.value as Review["material"]);if(e.target.value === "map")setPerspective("omniscient");}}><option value="timeline">Таймлайн и состояния в сервисе</option><option value="map" disabled={!history?.mapAvailable}>Приблизительная карта 7.40{history?.mapAvailable ? "" : " — нет позиций в наборе"}</option><option value="dota_client">Просмотр в клиенте Dota 2</option></select></label>
      <label>Перспектива проверки <select value={perspective} onChange={e=>setPerspective(e.target.value)}><option value="omniscient">Полный ретроспективный обзор</option><option value="team" disabled={material === "map"}>Команда выбранного игрока</option></select></label>
      <label>Автор оценки <input required maxLength={120} value={author} onChange={e=>setAuthor(e.target.value)}/></label>
      <button type="submit">{busy?"Сохранение…":"Сохранить проверку"}</button>
    </fieldset></form>
    <button disabled={busy} onClick={()=>void reload()}>Загрузить актуальную оценку</button>
    {history&&history.reviews.length>0&&<details><summary>История оценок ({history.reviews.length})</summary><ol>{history.reviews.map(r=><li key={r.version}>
      <h3>Версия {r.version} · {labels[r.status]}</h3><p>{r.explanation}</p>{r.alternative&&<p>Альтернатива: {r.alternative}</p>}
      <p className="muted">{r.author} · {stamp(r.reviewedAt)} · {materials[r.material]} · {r.perspective.mode==="omniscient"?"полный обзор":`команда ${r.perspective.team}`}</p>
      {r.mapContext && <p className="muted">Приблизительная подложка {r.mapContext.backgroundVersion} · проекция {r.mapContext.projectionVersion}</p>}
    </li>)}</ol></details>}
  </section>;
}
