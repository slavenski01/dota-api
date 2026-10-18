"use client";
import type { usePlayback } from "../../lib/use-playback";
export default function PlaybackControls({control,enabled,ready,end,diagnostics,cache}:{
  control:ReturnType<typeof usePlayback>;enabled:boolean;ready:boolean;end:boolean;diagnostics:boolean;
  cache:{size:number;bytes:number;requests:number;receivedBytes:number;latencies:number[]};
}) {
  const stats=control.stats,latencies=[...cache.latencies].sort((a,b)=>a-b);
  return <div className="playback-controls">
    <div className="history-actions"><button disabled={!enabled || end && !control.playing} onClick={control.toggle}>{control.playing ? "Пауза" : "Воспроизвести"}</button>
      <label>Скорость <select aria-label="Скорость воспроизведения" value={control.speed} onChange={e=>control.setSpeed(Number(e.target.value))}>{[0.5,1,2,4].map(n=><option key={n} value={n}>{String(n).replace('.',',')}×</option>)}</select></label>
      <span role="status">{control.playing ? ready ? "Воспроизведение" : "Буферизация…" : end ? "Конец записи" : "На паузе"}</span>
    </div>
    {diagnostics && <details open><summary>Замеры просмотра</summary><output className="playback-metrics">
      rAF: {stats.elapsedMs ? ((stats.frames-1)*1000/stats.elapsedMs).toFixed(1) : "—"} кадров/с; максимум между кадрами: {stats.maxFrameMs.toFixed(1)} мс; буферизация: {stats.bufferMs.toFixed(0)} мс;
      запросов интервалов: {cache.requests}; получено: {cache.receivedBytes} байт; HTTP p95: {(latencies[Math.floor(latencies.length*.95)]??0).toFixed(1)} мс;
      кэш: {cache.size} окон / {cache.bytes} сериализованных байт.
    </output></details>}
  </div>;
}
