"use client";
import { useEffect, useState } from "react";
import type { MatchOverview } from "@dota/jobs";
import type { MatchSummary } from "@dota/persistence";
import { api } from "../../../lib/source-errors";
import { gameTime } from "../../../lib/game-time";
import heroes from "../../../lib/heroes.json";
const unknown = "неизвестно";
const date = (value: string | null) => value ? new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) + " МСК" : unknown;
const heroName = (id: string | number | null) => (heroes as Record<string, string>)[String(id)] ?? (id === null ? unknown : `Герой ${id}`);
export function Chart({ points, field, label }: { points: MatchOverview["series"]; field: "hp" | "mana"; label: string }) {
  const known = points.filter(p => p[field] !== null);
  if (!known.length) return <section><h3>{label}</h3><p>Наблюдения отсутствуют. Значения не восстановлены из итоговой статистики.</p></section>;
  const min = points[0]!.time, max = points.at(-1)!.time, ceiling = Math.max(1, ...known.map(p => p[field]!));
  const x = (t: number) => 60 + (t - min) / (max - min || 1) * 630;
  const y = (v: number) => 190 - v / ceiling * 150;
  return <figure className="metric-chart"><figcaption>{label} · единицы ресурса, наблюдения по полному реплею</figcaption>
    <div className="chart-canvas" tabIndex={0} aria-label={`График ${label}; прокрутка по горизонтали на узком экране`}><svg viewBox="0 0 740 235" role="img" aria-label={`${label}: от ${gameTime(min)} до ${gameTime(max)}. Таблица значений ниже.`}>
      <path d="M60 35V190H690" fill="none" stroke="currentColor"/><text x="5" y="45">{Math.ceil(ceiling)}</text><text x="30" y="195">0</text>
      <text x="60" y="220">{gameTime(min)}</text><text x="350" y="220" textAnchor="middle">Игровое время</text><text x="690" y="220" textAnchor="end">{gameTime(max)}</text>
      {points.map((p, i) => { const prev = points[i - 1], value = p[field]; if (value === null) return null; return <g key={p.evidenceId}>
        {prev && prev[field] !== null && p.time - prev.time <= 5 && <line x1={x(prev.time)} y1={y(prev[field]!)} x2={x(p.time)} y2={y(value)} stroke="#b4d78c"/>}
        <circle cx={x(p.time)} cy={y(value)} r="1.8" fill="#b4d78c"><title>{gameTime(p.time)} · {value}</title></circle>
      </g>; })}
    </svg></div>
    <p className="muted">Точки — реальные наблюдения; линия лишь соединяет соседние точки с интервалом до 5 секунд. Пропуски не заполняются, короткие изменения между точками могут быть пропущены.</p>
    <details><summary>Таблица наблюдений и оснований ({points.length})</summary><div className="chart-table"><table><thead><tr><th>Время, секунды</th><th>{label}</th><th>Основание</th></tr></thead><tbody>{points.map(p => <tr key={p.evidenceId}><td>{p.time.toFixed(3)}</td><td>{p[field] ?? unknown}</td><td>{p.evidenceId}</td></tr>)}</tbody></table></div></details>
  </figure>;
}
export default function Overview({ datasetId, accountId, summary, fetchedAt }: { datasetId: string | null; accountId: string; summary: MatchSummary | null; fetchedAt: string | null }) {
  const [loaded, setLoaded] = useState<MatchOverview | null>(null), [error, setError] = useState("");
  useEffect(() => {
    setLoaded(null); setError(""); if (!datasetId) return;
    const controller = new AbortController();
    void api<MatchOverview>(`/api/datasets/${encodeURIComponent(datasetId)}/overview?accountId=${encodeURIComponent(accountId)}`, { signal: controller.signal }).then(setLoaded).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [datasetId, accountId]);
  const data = loaded?.datasetId === datasetId && loaded.player.accountId === accountId ? loaded : null;
  const player = data?.player, match = data?.match;
  const stats = player?.statistics ?? summary;
  const duration = match ? match.durationSeconds : summary?.duration;
  const won = match && player ? match.radiantWin === null ? null : match.radiantWin === (player.team === "radiant") : summary?.won;
  const conflicts = data && summary ? ["kills", "deaths", "assists"].filter(key => {
    const k = key as "kills" | "deaths" | "assists";
    return summary[k] !== null && data.player.statistics[k] !== null && summary[k] !== data.player.statistics[k];
  }) : [];
  return <section className="match-overview"><h2>Паспорт матча</h2>
    <dl className="stat-grid"><div><dt>Игрок</dt><dd>{accountId}</dd></div><div><dt>Герой</dt><dd>{heroName(player ? player.heroId : summary?.heroId ?? null)}</dd></div>
      <div><dt>Результат</dt><dd>{won == null ? unknown : won ? "Победа" : "Поражение"}</dd></div><div><dt>Длительность</dt><dd>{duration == null ? unknown : gameTime(duration)}</dd></div>
      <div><dt>Начало</dt><dd>{date(match?.startedAt ?? summary?.startedAt ?? null)}{match && !match.startedAt && summary ? " (OpenDota)" : ""}</dd></div>
      <div><dt>Сторона</dt><dd>{player?.team ?? (summary?.playerSlot == null ? unknown : summary.playerSlot < 128 ? "radiant" : "dire")}</dd></div>
      <div><dt>Режим (код) / патч</dt><dd>{match?.mode ?? unknown} / {match?.patch ?? unknown}</dd></div>
      <div><dt>Роль / источник</dt><dd>{player?.role ? `${player.role.position} / ${player.role.source === "manual" ? "введено вручную" : "провайдер"}` : unknown}</dd></div>
      <div><dt>K / D / A</dt><dd>{stats?.kills ?? unknown} / {stats?.deaths ?? unknown} / {stats?.assists ?? unknown}</dd></div>
      {player && ([['lastHits','Добивания'],['denies','Денаи'],['gpm','Золото в минуту'],['xpm','Опыт в минуту'],['heroDamage','Урон героям'],['towerDamage','Урон строениям']] as const).map(([key,label]) => <div key={key}><dt>{label}</dt><dd>{player.statistics[key] ?? unknown}</dd></div>)}
    </dl>
    <p className="muted">Уровень данных: {data ? "события и частичный контекст реплея" : summary ? "сводка из истории матчей" : "данные ещё не получены"}. Роль и MMR не выводятся из героя или K/D/A.</p>
    {conflicts.length > 0 && <p className="notice">Источники расходятся: {conflicts.join(", ")}. Здесь показан реплей; история OpenDota: {summary!.kills ?? unknown} / {summary!.deaths ?? unknown} / {summary!.assists ?? unknown}. Причину расхождения нужно проверить.</p>}
    <p className="muted">Источник: {data ? `${player!.provenance.source}, ${player!.provenance.sourceVersion ?? "версия неизвестна"}; получено ${date(player!.provenance.acquiredAt)}` : summary ? `OpenDota, история; получено ${date(fetchedAt)}` : unknown}.</p>
    {error && <p role="alert">{error}</p>}
    {datasetId && !data && !error && <p role="status">Загрузка статистики реплея…</p>}
    {data ? <><h3>Изменение ресурсов во времени</h3><p>Полный ретроспективный обзор. Эти графики не показывают, что игрок знал в момент решения. Координаты доступны на приблизительной карте 7.40; командный обзор и применимость способностей пока не подтверждены.</p><Chart points={data.series} field="hp" label="Здоровье (HP)"/><Chart points={data.series} field="mana" label="Мана"/><p className="muted">Рядов золота, опыта и добиваний нет. GPM не является стоимостью имущества.</p></> : <p>Графики появятся после успешного разбора реплея при наличии наблюдений. Доступная сводка сохраняется и при недоступном реплее.</p>}
  </section>;
}
