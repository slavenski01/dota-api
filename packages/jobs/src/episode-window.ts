import type { Episode } from '@dota/contracts';
import { JobError } from './index.js';

/** The review interval is a request, never proof that the recording extends that far. */
export function episodeViewingWindow(episode: Pick<Episode, 'window' | 'decisionTimeSeconds'>, recording: Episode['window']) {
  const window = { startSeconds: Math.max(episode.window.startSeconds, recording.startSeconds),
    endSeconds: Math.min(episode.window.endSeconds, recording.endSeconds) };
  if (window.startSeconds > window.endSeconds || episode.decisionTimeSeconds < window.startSeconds || episode.decisionTimeSeconds > window.endSeconds) throw new JobError('episode_view_unavailable');
  return window;
}
