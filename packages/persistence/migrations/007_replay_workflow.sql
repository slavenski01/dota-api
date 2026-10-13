ALTER TABLE dota.workflow_jobs ADD COLUMN account_id dota.provider_id;
ALTER TABLE dota.workflow_jobs ADD COLUMN upload_id dota.internal_id;
ALTER TABLE dota.workflow_jobs ADD COLUMN progress jsonb;
ALTER TABLE dota.workflow_jobs ADD FOREIGN KEY(upload_id,match_id) REFERENCES dota.artifacts(id,match_id);
ALTER TABLE dota.replay_sources ADD COLUMN checked_accounts jsonb NOT NULL DEFAULT '[]'::jsonb;
