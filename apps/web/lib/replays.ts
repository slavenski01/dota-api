import { persistence } from "./backend";
export function replayStorage() { return new persistence.LocalStorage(persistence.configuredStorageRoot()); }
export function replayParams(request: Request, id: string) {
  const matchId = persistence.replayMatchId(id);
  const accountId = persistence.normalizePlayerId(new URL(request.url).searchParams.get("accountId"), "account").accountId;
  return { matchId, accountId };
}
