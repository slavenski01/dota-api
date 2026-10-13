ALTER TABLE dota.workflow_jobs ADD COLUMN analysis_options jsonb;
ALTER TABLE dota.workflow_jobs ADD CONSTRAINT analysis_options_shape CHECK (
  analysis_options IS NULL OR (jsonb_typeof(analysis_options) = 'object'
    AND jsonb_typeof(analysis_options->'keyItemId') = 'string'
    AND jsonb_typeof(analysis_options->'gamePlan') = 'string'
    AND analysis_options ? 'keyItemId' AND analysis_options ? 'gamePlan')
);
