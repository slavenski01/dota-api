CREATE TABLE dota.coach_runs (
  id uuid PRIMARY KEY,
  request_key uuid UNIQUE NOT NULL,
  queue_job_id uuid UNIQUE NOT NULL,
  dataset_id dota.internal_id NOT NULL REFERENCES dota.datasets(id),
  analysis_id dota.internal_id NOT NULL REFERENCES dota.analysis_runs(id),
  player_slot dota.slot NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','ready','failed')),
  input jsonb NOT NULL,
  config jsonb NOT NULL,
  result jsonb,
  usage jsonb,
  error_code text,
  duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE(dataset_id,player_slot,version)
);
CREATE UNIQUE INDEX coach_one_active ON dota.coach_runs(dataset_id,player_slot) WHERE status IN ('queued','running');
CREATE INDEX coach_history ON dota.coach_runs(dataset_id,player_slot,version DESC);
CREATE FUNCTION dota.guard_coach_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status IN ('ready','failed') OR
    (NEW.id,NEW.request_key,NEW.queue_job_id,NEW.dataset_id,NEW.analysis_id,NEW.player_slot,NEW.version,NEW.input,NEW.config,NEW.created_at)
    IS DISTINCT FROM
    (OLD.id,OLD.request_key,OLD.queue_job_id,OLD.dataset_id,OLD.analysis_id,OLD.player_slot,OLD.version,OLD.input,OLD.config,OLD.created_at)
  THEN RAISE EXCEPTION 'immutable coach snapshot'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_coach_snapshot BEFORE UPDATE OR DELETE ON dota.coach_runs
FOR EACH ROW EXECUTE FUNCTION dota.guard_coach_snapshot();
