CREATE TABLE dota.dataset_checks (
  dataset_id dota.internal_id PRIMARY KEY REFERENCES dota.datasets(id),
  version text NOT NULL CHECK (version = 'coverage-v1'),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (payload->>'datasetId' = dataset_id),
  CHECK (payload->>'version' = version)
);

CREATE TRIGGER immutable_dataset_check BEFORE UPDATE OR DELETE ON dota.dataset_checks
FOR EACH ROW EXECUTE FUNCTION dota.reject_snapshot_change();
