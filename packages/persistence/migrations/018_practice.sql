CREATE TABLE dota.practice_series (
  id uuid PRIMARY KEY,
  account_id dota.provider_id NOT NULL REFERENCES dota.profiles,
  dataset_id dota.internal_id NOT NULL REFERENCES dota.datasets,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX practice_by_player ON dota.practice_series(account_id,created_at DESC);
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON dota.practice_series
FOR EACH ROW EXECUTE FUNCTION dota.reject_snapshot_change();
CREATE TABLE dota.practice_observations (
  series_id uuid NOT NULL REFERENCES dota.practice_series,
  match_id dota.provider_id NOT NULL REFERENCES dota.matches,
  dataset_id dota.internal_id NOT NULL REFERENCES dota.datasets,
  version integer NOT NULL CHECK(version > 0),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(series_id,match_id,version)
);
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON dota.practice_observations
FOR EACH ROW EXECUTE FUNCTION dota.reject_snapshot_change();
