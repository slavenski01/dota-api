"use client";
import { useEffect, useState } from "react";
import type { AnalysisRun } from "@dota/analysis";
import { api } from "../../../lib/source-errors";
const time = (seconds: number) => `${seconds < 0 ? "−" : ""}${Math.floor(Math.abs(seconds) / 60)}:${String(Math.floor(Math.abs(seconds) % 60)).padStart(2, "0")}`;
const titles = { D01: "Смерть без ближайшего размена", D02: "Смерть перед потерей объекта", I01: "Хронология после покупки", F01: "Бой с преимуществом по потерям героев", L01: "Показатели линии" };
export default function MatchAnalysis({ datasetId, analysisId, accountId, items }: { datasetId: string; analysisId: string; accountId: string; items: { id: string; name: string }[] }) {
  const [run, setRun] = useState<AnalysisRun | null>(null), [error, setError] = useState("");
  const endpoint = `/api/datasets/${encodeURIComponent(datasetId)}/analysis?accountId=${encodeURIComponent(accountId)}&analysisId=${encodeURIComponent(analysisId)}`;
  useEffect(() => {
    const controller = new AbortController(); setRun(null); setError("");
    void api<AnalysisRun>(endpoint, { signal: controller.signal }).then(setRun).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [endpoint]);
  if (error) return <p role="alert">{error}</p>;
  if (!run) return <p role="status">Загрузка результатов анализа…</p>;
  const skipped = [...new Set(run.results.filter(r => r.status === "skipped").map(r => r.ruleId))];
  const episodeLink = (id: string) => `/matches/${encodeURIComponent(run.matchId)}/episodes/${encodeURIComponent(id)}?datasetId=${encodeURIComponent(datasetId)}&accountId=${encodeURIComponent(accountId)}`;
  const rate = run.metrics.deathsPerTenMinutes?.value, participation = run.metrics.killParticipation?.value;
  const itemNames = new Map(items.map(item => [item.id, item.name]));
  return <section className="analysis-results"><h2>Эпизоды для проверки</h2>
    <p>Смертей на 10 минут: {rate == null ? "неизвестно" : rate.toFixed(2)} · Участие в убийствах команды: {participation == null ? "неизвестно" : `${(participation * 100).toFixed(1)}%`}</p>
    <p className="muted">Это частота смертей и доля (убийства + ассисты) / убийства команды. Они не оценивают качество игры.</p>
    {run.outcome === "no_candidates" && <p>По проверенным правилам кандидатов нет.</p>}
    {run.outcome === "insufficient_data" && <p>Кандидаты не найдены; данных или выбранных параметров недостаточно для полного отбора.</p>}
    {run.completeness === "partial" && <p>Часть правил или окон имеет ограничения данных. Отсутствие эпизода не доказывает отсутствие события.</p>}
    {run.episodes.filter(e => run.primaryEpisodeIds.includes(e.episode.id)).map(e => <article key={e.episode.id}>
      <h3>{time(e.episode.decisionTimeSeconds)} · {e.episode.signals.map(s => titles[s.ruleId]).join(" / ")}</h3>
      <p>Просмотр: {time(e.episode.window.startSeconds)}–{time(e.episode.window.endSeconds)}{e.results.some(r => r.viewClipped) ? " (ограничен доступной записью)" : ""}</p>
      {[...new Set(e.results.flatMap(r => r.facts))].map(f => <p key={f}>{f}</p>)}
      <a href={episodeLink(e.episode.id)}>Открыть эпизод</a>
      <details><summary>Основания и ограничения</summary>{[...new Set(e.results.flatMap(r => r.limitations))].map(l => <p key={l}>{l}</p>)}</details>
    </article>)}
    {run.episodes.length > 3 && <details><summary>Остальные эпизоды ({run.episodes.length - 3})</summary><ul>{run.episodes.filter(e => !run.primaryEpisodeIds.includes(e.episode.id)).map(e => <li key={e.episode.id}><a href={episodeLink(e.episode.id)}>{time(e.episode.decisionTimeSeconds)} · {e.episode.signals.map(s => titles[s.ruleId]).join(" / ")}</a></li>)}</ul></details>}
    {skipped.length > 0 && <details><summary>Что не удалось проверить</summary><ul>{skipped.map(id => <li key={id}>{titles[id]}: {id === "I01" && !run.options ? "не выбраны ключевой предмет и план игры" : id === "F01" ? "не подтверждены границы боя или полные потери команд" : "не хватает подтверждённых событий, сторон или полного временного окна"}.</li>)}</ul></details>}
    <details><summary>Известные покупки ({run.purchases.length})</summary><p>Журнал может быть неполным. Покупка не означает получение предмета героем.</p><ul>{run.purchases.map(p => <li key={p.id}>{time(p.gameTimeSeconds)} · {p.data.type === "item" ? itemNames.get(p.data.itemId) ?? `Предмет ${p.data.itemId}` : ""}</li>)}</ul></details>
    {run.limitations.map(l => <p className="muted" key={l}>{l}</p>)}
    <a href={endpoint}>Полный результат с причинами пропуска</a>
  </section>;
}
