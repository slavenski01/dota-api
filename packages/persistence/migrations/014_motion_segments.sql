CREATE TABLE dota.motion_segments (
  id dota.internal_id PRIMARY KEY,
  dataset_id dota.internal_id NOT NULL,
  match_id dota.provider_id NOT NULL,
  artifact_id dota.internal_id NOT NULL,
  start_seconds double precision NOT NULL,
  end_seconds double precision NOT NULL,
  format_version text NOT NULL CHECK (format_version = 'motion-v1'),
  CHECK (start_seconds <= end_seconds AND end_seconds - start_seconds < 30),
  UNIQUE(dataset_id, start_seconds),
  FOREIGN KEY(dataset_id, match_id) REFERENCES dota.datasets(id, match_id),
  FOREIGN KEY(artifact_id, match_id) REFERENCES dota.artifacts(id, match_id)
);
CREATE INDEX motion_window ON dota.motion_segments(dataset_id, start_seconds, end_seconds);
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON dota.motion_segments FOR EACH ROW EXECUTE FUNCTION dota.reject_snapshot_change();
