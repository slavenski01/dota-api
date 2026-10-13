CREATE TABLE dota.analysis_runs (
  id dota.internal_id PRIMARY KEY,
  dataset_id dota.internal_id NOT NULL,
  match_id dota.provider_id NOT NULL,
  player_slot dota.slot NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (payload->>'id' = id AND payload->>'datasetId' = dataset_id
    AND payload->>'matchId' = match_id AND (payload->>'playerSlot')::smallint = player_slot),
  FOREIGN KEY(dataset_id, match_id) REFERENCES dota.datasets(id, match_id),
  FOREIGN KEY(match_id, player_slot) REFERENCES dota.participants(match_id, player_slot)
);
CREATE INDEX analysis_runs_player ON dota.analysis_runs(dataset_id, player_slot, created_at DESC, id);
CREATE TRIGGER immutable_analysis_run BEFORE UPDATE OR DELETE ON dota.analysis_runs
FOR EACH ROW EXECUTE FUNCTION dota.reject_snapshot_change();
