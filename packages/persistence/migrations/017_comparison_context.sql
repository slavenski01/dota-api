CREATE TABLE dota.comparison_contexts (
  match_id dota.provider_id NOT NULL REFERENCES dota.matches,
  account_id dota.provider_id NOT NULL REFERENCES dota.profiles,
  version integer NOT NULL CHECK (version > 0),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(match_id,account_id,version)
);
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON dota.comparison_contexts
FOR EACH ROW EXECUTE FUNCTION dota.reject_snapshot_change();
CREATE TABLE dota.comparison_runs (
  id dota.internal_id PRIMARY KEY,
  dataset_id dota.internal_id NOT NULL REFERENCES dota.datasets,
  account_id dota.provider_id NOT NULL REFERENCES dota.profiles,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON dota.comparison_runs
FOR EACH ROW EXECUTE FUNCTION dota.reject_snapshot_change();
