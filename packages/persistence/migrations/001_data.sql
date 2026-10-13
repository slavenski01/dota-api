CREATE SCHEMA dota;
CREATE DOMAIN dota.provider_id AS text CHECK (VALUE ~ '^(0|[1-9][0-9]{0,19})$');
CREATE DOMAIN dota.internal_id AS text CHECK (VALUE ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$');
CREATE DOMAIN dota.sha256 AS text CHECK (VALUE ~ '^[a-f0-9]{64}$');
CREATE DOMAIN dota.slot AS smallint CHECK (VALUE BETWEEN 0 AND 4 OR VALUE BETWEEN 128 AND 132);

CREATE TABLE dota.profiles (
  account_id dota.provider_id PRIMARY KEY,
  steam_id64 dota.provider_id UNIQUE,
  fetched_at timestamptz,
  source jsonb
);
CREATE TABLE dota.matches (
  match_id dota.provider_id PRIMARY KEY,
  started_at timestamptz
);
CREATE INDEX matches_time ON dota.matches(started_at DESC, match_id);
CREATE TABLE dota.participants (
  match_id dota.provider_id REFERENCES dota.matches NOT NULL,
  player_slot dota.slot NOT NULL,
  account_id dota.provider_id REFERENCES dota.profiles,
  PRIMARY KEY(match_id, player_slot)
);
CREATE INDEX participants_player_match ON dota.participants(account_id, match_id);
CREATE TABLE dota.artifacts (
  id dota.internal_id PRIMARY KEY,
  match_id dota.provider_id REFERENCES dota.matches NOT NULL,
  storage_key text NOT NULL CHECK (storage_key ~ '^[a-f0-9]{2}/[a-f0-9]{64}$'),
  sha256 dota.sha256 NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  media_type text NOT NULL,
  source jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id, match_id)
);
CREATE TABLE dota.parser_runs (
  id dota.internal_id PRIMARY KEY,
  match_id dota.provider_id NOT NULL REFERENCES dota.matches,
  artifact_id dota.internal_id NOT NULL,
  parser_version text NOT NULL,
  parameters jsonb NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('complete','failed')),
  diagnostics jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id, match_id),
  FOREIGN KEY(artifact_id, match_id) REFERENCES dota.artifacts(id, match_id)
);
CREATE TABLE dota.datasets (
  id dota.internal_id PRIMARY KEY,
  match_id dota.provider_id NOT NULL REFERENCES dota.matches,
  parser_run_id dota.internal_id,
  normalization_version text NOT NULL,
  input_sha256 dota.sha256 NOT NULL,
  versions jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id, match_id),
  FOREIGN KEY(parser_run_id, match_id) REFERENCES dota.parser_runs(id, match_id)
);

-- The original validated contract is the immutable snapshot. Generated columns
-- make indexed facts and foreign keys agree with that snapshot by construction.
CREATE TABLE dota.records (
  dataset_id dota.internal_id NOT NULL,
  payload jsonb NOT NULL,
  id dota.internal_id GENERATED ALWAYS AS (payload->>'id') STORED NOT NULL,
  match_id dota.provider_id GENERATED ALWAYS AS (payload->>'matchId') STORED NOT NULL,
  kind text GENERATED ALWAYS AS (payload->>'kind') STORED NOT NULL,
  player_slot dota.slot GENERATED ALWAYS AS ((payload->>'playerSlot')::smallint) STORED,
  game_time_seconds double precision GENERATED ALWAYS AS ((payload->>'gameTimeSeconds')::double precision) STORED,
  PRIMARY KEY(dataset_id, id),
  UNIQUE(dataset_id, id, kind),
  CHECK (kind IN ('match','participant','event','hero_state','coverage','episode','report')),
  CHECK ((payload->>'schemaVersion') IS NOT DISTINCT FROM '0.1.0'),
  CHECK (NOT payload ? 'datasetId' OR payload->>'datasetId' = dataset_id),
  CHECK (kind NOT IN ('participant','hero_state','episode','report') OR player_slot IS NOT NULL),
  CHECK (kind NOT IN ('event','hero_state') OR game_time_seconds IS NOT NULL),
  FOREIGN KEY(dataset_id, match_id) REFERENCES dota.datasets(id, match_id),
  FOREIGN KEY(match_id, player_slot) REFERENCES dota.participants(match_id, player_slot)
);
CREATE UNIQUE INDEX one_match_snapshot ON dota.records(dataset_id) WHERE kind = 'match';
CREATE UNIQUE INDEX versioned_analysis_id ON dota.records(id) WHERE kind IN ('episode','report');
CREATE UNIQUE INDEX one_participant_snapshot ON dota.records(dataset_id, player_slot) WHERE kind = 'participant';
CREATE INDEX events_match_time ON dota.records(match_id, game_time_seconds, dataset_id) WHERE kind = 'event';
CREATE INDEX states_match_time ON dota.records(match_id, game_time_seconds, player_slot, dataset_id) WHERE kind = 'hero_state';
CREATE TABLE dota.record_participants (
  dataset_id dota.internal_id NOT NULL,
  record_id dota.internal_id NOT NULL,
  match_id dota.provider_id NOT NULL,
  player_slot dota.slot NOT NULL,
  PRIMARY KEY(dataset_id, record_id, player_slot),
  FOREIGN KEY(dataset_id, record_id) REFERENCES dota.records(dataset_id, id),
  FOREIGN KEY(dataset_id, match_id) REFERENCES dota.datasets(id, match_id),
  FOREIGN KEY(match_id, player_slot) REFERENCES dota.participants(match_id, player_slot)
);
CREATE TABLE dota.episode_reviews (
  dataset_id dota.internal_id NOT NULL,
  episode_id dota.internal_id NOT NULL,
  kind text NOT NULL DEFAULT 'episode' CHECK (kind = 'episode'),
  version integer NOT NULL CHECK (version > 0),
  payload jsonb NOT NULL,
  PRIMARY KEY(dataset_id, episode_id, version),
  CHECK ((payload->>'version')::integer = version),
  CHECK (payload->>'status' IN ('confirmed_error','justified','uncertain')),
  CHECK (payload->>'status' <> 'confirmed_error' OR coalesce(length(payload->>'alternative'), 0) > 0),
  FOREIGN KEY(dataset_id, episode_id, kind) REFERENCES dota.records(dataset_id, id, kind)
);
CREATE TABLE dota.report_episodes (
  dataset_id dota.internal_id NOT NULL,
  report_id dota.internal_id NOT NULL,
  report_kind text NOT NULL DEFAULT 'report' CHECK (report_kind = 'report'),
  episode_id dota.internal_id NOT NULL,
  episode_kind text NOT NULL DEFAULT 'episode' CHECK (episode_kind = 'episode'),
  PRIMARY KEY(dataset_id, report_id, episode_id),
  FOREIGN KEY(dataset_id, report_id, report_kind) REFERENCES dota.records(dataset_id, id, kind),
  FOREIGN KEY(dataset_id, episode_id, episode_kind) REFERENCES dota.records(dataset_id, id, kind)
);
CREATE TABLE dota.report_reviews (
  dataset_id dota.internal_id NOT NULL,
  report_id dota.internal_id NOT NULL,
  episode_id dota.internal_id NOT NULL,
  review_version integer NOT NULL,
  PRIMARY KEY(dataset_id, report_id, episode_id),
  FOREIGN KEY(dataset_id, report_id, episode_id) REFERENCES dota.report_episodes,
  FOREIGN KEY(dataset_id, episode_id, review_version) REFERENCES dota.episode_reviews
);
CREATE FUNCTION dota.reject_snapshot_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'immutable_snapshot' USING ERRCODE = '23514'; END $$;
DO $$ DECLARE name text; BEGIN
  FOREACH name IN ARRAY ARRAY['artifacts','parser_runs','datasets','records','record_participants','episode_reviews','report_episodes','report_reviews'] LOOP
    EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON dota.%I FOR EACH ROW EXECUTE FUNCTION dota.reject_snapshot_change()', name);
  END LOOP;
END $$;
CREATE VIEW dota.match_snapshots AS SELECT * FROM dota.records WHERE kind = 'match';
CREATE VIEW dota.participant_snapshots AS SELECT * FROM dota.records WHERE kind = 'participant';
CREATE VIEW dota.events AS SELECT * FROM dota.records WHERE kind = 'event';
CREATE VIEW dota.coverage AS SELECT * FROM dota.records WHERE kind = 'coverage';
CREATE VIEW dota.episodes AS SELECT * FROM dota.records WHERE kind = 'episode';
CREATE VIEW dota.reports AS SELECT * FROM dota.records WHERE kind = 'report';
