CREATE TABLE dota.state_segments (
  id dota.internal_id PRIMARY KEY,
  dataset_id dota.internal_id NOT NULL,
  match_id dota.provider_id NOT NULL,
  artifact_id dota.internal_id NOT NULL,
  perspective text NOT NULL CHECK (perspective IN ('omniscient','radiant','dire')),
  start_seconds double precision NOT NULL,
  end_seconds double precision NOT NULL,
  record_count integer NOT NULL CHECK (record_count > 0),
  CHECK (start_seconds <= end_seconds AND end_seconds - start_seconds <= 30),
  UNIQUE(dataset_id, perspective, start_seconds),
  FOREIGN KEY(dataset_id, match_id) REFERENCES dota.datasets(id, match_id),
  FOREIGN KEY(artifact_id, match_id) REFERENCES dota.artifacts(id, match_id)
);
CREATE INDEX segments_window ON dota.state_segments(dataset_id, perspective, start_seconds, end_seconds);
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON dota.state_segments FOR EACH ROW EXECUTE FUNCTION dota.reject_snapshot_change();
