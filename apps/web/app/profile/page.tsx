"use client";
import { useEffect, useState, type FormEvent } from "react";
import type { PlayerProfile } from "@dota/persistence";
import { api } from "../../lib/source-errors";
import MatchHistory from "./match-history";
export default function ProfilePage() {
  const [profile,setProfile]=useState<PlayerProfile|null>(null);
  const [busy,setBusy]=useState(true);const [error,setError]=useState("");
  const [lastInput,setLastInput]=useState<{id:string;kind:string}|null>(null);
  async function load() {
    setBusy(true);setError("");
    try {setProfile((await api<{profile:PlayerProfile|null}>("/api/profile")).profile);}
    catch(e){setError(e instanceof Error?e.message:"Не удалось загрузить профиль.");}
    finally{setBusy(false);}
  }
  useEffect(()=>{void load();},[]);
  async function select(input:{id:string;kind:string}) {
    setLastInput(input);setBusy(true);setError("");
    try {setProfile((await api<{profile:PlayerProfile}>("/api/profile",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(input)})).profile);}
    catch(e){setError(e instanceof Error?e.message:"Не удалось выбрать профиль.");}
    finally{setBusy(false);}
  }
  function submit(event:FormEvent<HTMLFormElement>){event.preventDefault();const form=new FormData(event.currentTarget);void select({id:String(form.get("id")),kind:String(form.get("kind"))});}
  return <main className="profile-page"><nav><a href="/">Главная</a><a href="/jobs">Обработка матчей</a></nav>
    <p className="eyebrow">DOTA / МОИ МАТЧИ</p><h1>История игрока</h1>
    <p className="intro">Выберите профиль и загрузите доступные матчи. История сохраняется на этом компьютере.</p>
    <form className="profile-form" onSubmit={submit}><label>Тип ID<select name="kind" disabled={busy}><option value="account">Dota account ID</option><option value="steam">SteamID64</option></select></label>
      <label>ID игрока<input name="id" inputMode="numeric" required maxLength={20} disabled={busy} placeholder="Введите числовой ID" /></label><button disabled={busy}>Выбрать профиль</button></form>
    {busy&&<p role="status">Загрузка профиля…</p>}
    {error&&<div className="notice error" role="alert"><p>{error}</p><button disabled={busy} onClick={()=>void(lastInput?select(lastInput):load())}>Повторить</button></div>}
    {!busy&&!profile&&!error&&<p className="notice">Профиль ещё не выбран. Укажите ID, чтобы открыть историю.</p>}
    {profile&&<><section className="profile-card"><div>{profile.avatar&&<img src={profile.avatar} width={64} height={64} alt="Аватар игрока" referrerPolicy="no-referrer" />}<h2>{profile.name??"Имя недоступно"}</h2></div>
      <p>Account ID: {profile.accountId} · SteamID64: {profile.steamId64}</p><p>{profile.access==="limited"?"Источник сообщает об ограниченном доступе к истории. Сохранённые матчи доступны ниже.":profile.access==="unknown"?"Доступность истории пока неизвестна. Отсутствие имени не означает отсутствие матчей.":"Профиль доступен. Полнота истории не гарантируется."}</p></section>
      <MatchHistory key={profile.accountId} accountId={profile.accountId}/></>}
  </main>;
}
