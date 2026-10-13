"use client";
import { useEffect, useState, type FormEvent } from "react";
import type { PlayerProfile } from "@dota/persistence";
export default function ProfilePage() {
  const [profile, setProfile] = useState<PlayerProfile | null>(null);
  const [busy, setBusy] = useState(true); const [error, setError] = useState("");
  async function load() {
    setBusy(true); setError("");
    try { const r = await fetch("/api/profile"); const data = await r.json(); if (!r.ok) throw new Error(data.error); setProfile(data.profile); }
    catch (e) { setError(e instanceof Error ? e.message : "service_unavailable"); }
    finally { setBusy(false); }
  }
  useEffect(() => { void load(); }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget); setBusy(true); setError("");
    try {
      const r = await fetch("/api/profile", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: form.get("id"), kind: form.get("kind") }) });
      const data = await r.json(); if (!r.ok) throw new Error(data.error); setProfile(data.profile);
    } catch (e) { setError(e instanceof Error ? e.message : "service_unavailable"); }
    finally { setBusy(false); }
  }
  return <main><a href="/">Главная</a><h1>Профиль игрока</h1>
    <form onSubmit={submit}><label>Тип ID <select name="kind"><option value="account">Dota account ID</option><option value="steam">SteamID64</option></select></label>{" "}
      <label>ID <input name="id" inputMode="numeric" required maxLength={20} /></label>{" "}<button disabled={busy}>Выбрать профиль</button></form>
    {busy && <p role="status">Загрузка профиля…</p>}
    {error && <p role="alert">Не удалось получить профиль: {error}. <button onClick={() => void load()}>Повторить чтение</button></p>}
    {profile && <section><h2>{profile.name ?? "Имя недоступно"}</h2>{profile.avatar && <img src={profile.avatar} width={64} height={64} alt="Аватар игрока" referrerPolicy="no-referrer" />}<p>Account ID: {profile.accountId}<br />SteamID64: {profile.steamId64}</p>
      <p>{profile.access === "limited" ? "Источник сообщает об ограниченном доступе к истории." : profile.access === "unknown" ? "Доступность истории пока неизвестна." : "Профиль доступен. Полнота истории не гарантируется."}</p></section>}
  </main>;
}
