import { validateDataset, analysisContext, PLAYER_SLOTS } from '@dota/analysis';
export const provenance = { source: 'replay', acquiredAt: '2026-10-13T00:00:00.000Z', artifactId: 'replay', sourceVersion: 'normalized-v1/clarity-5.0.1/protobuf-7.1', inputIds: [] };
export const base = (kind, id) => ({ schemaVersion: '0.1.0', kind, id, matchId: '1', provenance });
const fields = { death: 'deaths', item: 'items', objective: 'objectives', fight: 'fights' };
export const event = (id, time, data) => ({ ...base('event', id), gameTimeSeconds: time, tick: null, coverageIds: [fields[data.type]], data });
export const death = (id, time, slot = 0, afterBuyback = false) => event(id, time, { type: 'death', victimSlot: slot, killerSlot: null, afterBuyback });
export const objective = (id, time, ownerTeam = 'radiant', beneficiaryTeam = 'dire', objectType = 'tower') => event(id, time, { type: 'objective', objectId: id, ownerTeam, beneficiaryTeam, objectType });
export function fixture(events = [], { playerSlot = 0, duration = 1200, complete = [] } = {}) {
  const match = { ...base('match', 'match'), startedAt: null, durationSeconds: duration, mode: null, patch: null, radiantWin: true };
  const players = PLAYER_SLOTS.map(slot => ({ ...base('participant', `player-${slot}`), playerSlot: slot, team: slot < 128 ? 'radiant' : 'dire', accountId: String(slot + 1), steamId64: null, heroId: '1', aspectId: null, role: null,
    statistics: { kills: 0, deaths: events.filter(e => e.data.type === 'death' && e.data.victimSlot === slot).length, assists: 0, lastHits: 0, denies: 0, gpm: 0, xpm: 0, heroDamage: 0, towerDamage: 0 } }));
  const coverage = ['deaths', 'items', 'objectives', 'fights', 'time', 'statistics'].map(field => {
    const ids = field === 'time' ? ['match'] : field === 'statistics' ? players.map(p => p.id) : [...(field === 'deaths' ? players.map(p => p.id) : []), ...events.filter(e => fields[e.data.type] === field).map(e => e.id)];
    return { ...base('coverage', field), datasetId: 'dataset', field, participantSlots: PLAYER_SLOTS, window: { startSeconds: field === 'statistics' ? duration : -60, endSeconds: duration },
      status: ['deaths', 'time', 'statistics'].includes(field) ? 'present' : 'unknown', evidenceIds: ids, reason: ['deaths', 'time', 'statistics'].includes(field) ? null : 'Partial fixture journal', resolutionSeconds: null };
  });
  const rows = [match, ...players, ...events, ...coverage];
  const report = validateDataset(rows, { datasetId: 'dataset', matchId: '1', artifactId: 'replay', inputSha256: 'a'.repeat(64), inputVerified: true, parserCompleted: true, parserVersion: 'normalized-v1/clarity-5.0.1' });
  // Simulates a future independently verified source. Production E05 never promotes these channels.
  for (const field of complete) { const c = report.coverage.find(c => c.field === field); c.status = 'present'; c.reason = null; if (!c.evidenceIds.length) c.evidenceIds = ['match']; }
  return analysisContext(rows, report, playerSlot);
}
