CREATE TABLE dota.workflow_jobs (
  id dota.internal_id PRIMARY KEY,
  match_id dota.provider_id NOT NULL REFERENCES dota.matches,
  queue_job_id uuid UNIQUE NOT NULL,
  request_sha256 dota.sha256 NOT NULL,
  input_sha256 dota.sha256,
  artifact_id dota.internal_id,
  dataset_id dota.internal_id,
  versions jsonb NOT NULL,
  payload jsonb NOT NULL,
  status text GENERATED ALWAYS AS (payload->>'status') STORED NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (payload->>'id' = id AND payload->>'matchId' = match_id AND payload->>'kind' = 'job'),
  CHECK (status IN ('queued','resolving','downloading','parsing','validating','analysing','ready','unavailable','failed','cancelled')),
  CHECK (status <> 'ready' OR dataset_id IS NOT NULL),
  FOREIGN KEY(artifact_id, match_id) REFERENCES dota.artifacts(id, match_id),
  FOREIGN KEY(dataset_id, match_id) REFERENCES dota.datasets(id, match_id)
);
CREATE UNIQUE INDEX one_active_match_job ON dota.workflow_jobs(match_id)
  WHERE status IN ('queued','resolving','downloading','parsing','validating','analysing');
CREATE INDEX workflow_reuse ON dota.workflow_jobs(request_sha256, created_at DESC) WHERE status='ready';
CREATE TABLE dota.job_steps (
  job_id dota.internal_id NOT NULL REFERENCES dota.workflow_jobs,
  stage text NOT NULL CHECK (stage IN ('resolving','downloading','parsing','validating','analysing')),
  result jsonb NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(job_id,stage)
);
CREATE TABLE dota.job_history (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id dota.internal_id NOT NULL REFERENCES dota.workflow_jobs,
  payload jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_history_order ON dota.job_history(job_id,sequence);
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON dota.job_steps FOR EACH ROW EXECUTE FUNCTION dota.reject_snapshot_change();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON dota.job_history FOR EACH ROW EXECUTE FUNCTION dota.reject_snapshot_change();
