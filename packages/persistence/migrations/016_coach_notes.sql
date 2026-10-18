ALTER TABLE dota.coach_runs ADD UNIQUE(id,dataset_id,analysis_id);
ALTER TABLE dota.match_notes
  ADD COLUMN coach_report_id uuid,
  ADD COLUMN coach_analysis_id dota.internal_id,
  ADD COLUMN episode_id dota.internal_id,
  ADD CONSTRAINT note_coach_reference CHECK (
    (coach_report_id IS NULL AND coach_analysis_id IS NULL AND episode_id IS NULL) OR
    (coach_report_id IS NOT NULL AND coach_analysis_id IS NOT NULL AND episode_id IS NOT NULL)),
  ADD FOREIGN KEY(coach_report_id,dataset_id,coach_analysis_id) REFERENCES dota.coach_runs(id,dataset_id,analysis_id),
  ADD FOREIGN KEY(dataset_id,episode_id) REFERENCES dota.records(dataset_id,id);
CREATE INDEX match_notes_coach ON dota.match_notes(coach_report_id,episode_id) WHERE coach_report_id IS NOT NULL;
