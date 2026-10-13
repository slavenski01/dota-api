CREATE TABLE dota.match_notes (
  id dota.internal_id PRIMARY KEY,
  dataset_id dota.internal_id NOT NULL,
  match_id dota.provider_id NOT NULL,
  account_id dota.provider_id NOT NULL REFERENCES dota.profiles,
  player_slot dota.slot NOT NULL,
  game_time_seconds double precision NOT NULL CHECK (game_time_seconds > '-Infinity'::float8 AND game_time_seconds < 'Infinity'::float8),
  mode text NOT NULL CHECK (mode IN ('decision','retrospective')),
  content text NOT NULL CHECK (length(btrim(content)) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(dataset_id,match_id) REFERENCES dota.datasets(id,match_id),
  FOREIGN KEY(match_id,player_slot) REFERENCES dota.participants(match_id,player_slot)
);
CREATE INDEX match_notes_owner ON dota.match_notes(dataset_id,account_id,mode,game_time_seconds,id);
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON dota.match_notes FOR EACH ROW EXECUTE FUNCTION dota.reject_snapshot_change();
