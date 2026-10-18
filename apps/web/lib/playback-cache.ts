import type { PlaybackWindow, MatchFrame } from "@dota/jobs";
import type { HeroState } from "@dota/contracts";

export const PLAYBACK_VERSION = "playback-v1";
export const WINDOW_SECONDS = 30;
export const CACHE_BYTES = 8*1024**2;
export const CACHE_WINDOWS = 4;
export const playbackScope = (dataset: string, account: string, mode: string, episode = "") => JSON.stringify([PLAYBACK_VERSION,dataset,account,mode,episode]);

/** One context per cache; stale asynchronous completions cannot repopulate it. */
export class PlaybackCache {
  private windows = new Map<number,{ value: PlaybackWindow; bytes: number }>();
  scope = "";
  generation = 0;
  bytes = 0;
  requests = 0;
  receivedBytes = 0;
  latencies: number[] = [];
  private pinned: number | null = null;
  pin(bucket: number) { this.pinned = bucket; }
  reset(scope: string) { if (this.scope !== scope) { this.scope = scope; this.generation++; this.windows.clear(); this.bytes=0; this.requests=0; this.receivedBytes=0; this.latencies=[]; } }
  get(bucket: number) {
    const entry = this.windows.get(bucket);
    if (entry) { this.windows.delete(bucket); this.windows.set(bucket,entry); }
    return entry?.value;
  }
  put(scope: string, generation: number, value: PlaybackWindow, bytes: number) {
    if (scope !== this.scope || generation !== this.generation) return false;
    if (value.version !== PLAYBACK_VERSION || !Number.isSafeInteger(bytes) || bytes > 4*1024**2 || bytes < 0) throw new Error("Недопустимый интервал просмотра.");
    const previous = this.windows.get(value.bucket);
    if (previous) this.bytes -= previous.bytes;
    this.windows.delete(value.bucket); this.windows.set(value.bucket,{ value,bytes }); this.bytes += bytes;
    while (this.windows.size > CACHE_WINDOWS || this.bytes > CACHE_BYTES) {
      const oldest = [...this.windows.keys()].find(k=>k!==this.pinned)!;
      this.bytes -= this.windows.get(oldest)!.bytes; this.windows.delete(oldest);
    }
    return true;
  }
  get size() { return this.windows.size; }
}

function point(state: HeroState | null) {
  if (!state || state.provenance.sourceVersion !== "normalized-v2/clarity-5.0.1/protobuf-7.1" || state.position.status !== "known" || state.position.observedAtSeconds !== state.gameTimeSeconds) return null;
  const x = (state.position.value.x+8192)/16256*100, y = (8064-state.position.value.y)/16256*100;
  return x >= 0 && x <= 100 && y >= 0 && y <= 100 ? {x,y} : null;
}
/** Actual observations only. Smoothing must never overwrite these state values. */
export function observedFrame(window: PlaybackWindow, time: number): MatchFrame {
  if (!Number.isFinite(time) || time < window.start || time > window.end) throw new Error("Время вне загруженного интервала.");
  const base = window.frame;
  if (base.mode === "decision") return { ...base,time,states:base.states.map(s=>({...s,state:s.state ? {...s.state,gameTimeSeconds:time} : null})) };
  return { ...base,time,states:base.heroes.map(hero=>{
    let latest: HeroState | null = null, duplicate = false;
    for (const state of window.states) if (state.playerSlot === hero.playerSlot && state.gameTimeSeconds <= time && state.gameTimeSeconds >= time-5) {
      if (!latest || state.gameTimeSeconds > latest.gameTimeSeconds) { latest=state; duplicate=false; }
      else if (state.gameTimeSeconds === latest.gameTimeSeconds) duplicate=true;
    }
    if (duplicate) latest=null;
    return {playerSlot:hero.playerSlot,state:latest,ageSeconds:latest ? time-latest.gameTimeSeconds : null,mapPosition:point(latest)};
  }) };
}
