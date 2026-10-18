import type { HeroMotion, HeroState } from "@dota/contracts";
import { readMotionWindow, readStateWindow, type Pool, type Storage } from "@dota/persistence";
import { JobError } from "./index.js";
import { readEpisode } from "./analysis.js";
import { readEpisodeFrame, type EpisodeFrame } from "./episode-view.js";
import { readMatchExplorer, readMatchFrame, type MatchFrame, type ViewMode } from "./match-explorer.js";
import { episodeViewingWindow } from './episode-window.js';

export const PLAYBACK_VERSION = "playback-v1";
export const PLAYBACK_SECONDS = 30;
export interface PlaybackWindow {
  version: typeof PLAYBACK_VERSION; bucket: number; start: number; end: number;
  frame: MatchFrame | EpisodeFrame; states: HeroState[]; motion: HeroMotion[];
  motionAvailable: boolean;
}
export async function readPlaybackWindow(pool: Pool, storage: Storage, datasetId: string, accountId: string,
  mode: ViewMode, bucket: number, version: string, episodeId?: string): Promise<PlaybackWindow> {
  if (version !== PLAYBACK_VERSION || !Number.isSafeInteger(bucket) || !["retrospective","decision"].includes(mode)) throw new JobError("invalid_context_request");
  const view = await readMatchExplorer(pool, datasetId, accountId);
  const window = episodeId ? episodeViewingWindow((await readEpisode(pool,datasetId,accountId,episodeId)).episode,view.window) : view.window;
  const start = Math.max(window.startSeconds,bucket*PLAYBACK_SECONDS), end = Math.min(window.endSeconds,(bucket+1)*PLAYBACK_SECONDS);
  if (start > end || (bucket+1)*PLAYBACK_SECONDS <= window.startSeconds) throw new JobError("invalid_context_request");
  const frame = episodeId ? await readEpisodeFrame(pool,storage,datasetId,accountId,episodeId,mode,start)
    : await readMatchFrame(pool,storage,datasetId,accountId,mode,start);
  // Decision mode never reads the omniscient stores, even for a future/prefetch window.
  const [states,motion] = mode === "retrospective" ? await Promise.all([
    readStateWindow(pool,storage,datasetId,start-5,end,"omniscient"),
    readMotionWindow(pool,storage,datasetId,start-1,Math.min(window.endSeconds,end+0.3)),
  ]) : [[],[]];
  const result: PlaybackWindow = { version: PLAYBACK_VERSION,bucket,start,end,frame,states,motion,motionAvailable:view.motionAvailable };
  if (Buffer.byteLength(JSON.stringify(result)) > 4*1024**2) throw new JobError("playback_window_too_large");
  return result;
}
