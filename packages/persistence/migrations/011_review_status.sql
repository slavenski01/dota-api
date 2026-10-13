-- Allow an explicit withdrawal of a review while keeping its immutable history.
ALTER TABLE dota.episode_reviews DROP CONSTRAINT episode_reviews_payload_check;
ALTER TABLE dota.episode_reviews ADD CONSTRAINT episode_reviews_status_check
  CHECK (payload->>'status' IN ('unreviewed','confirmed_error','justified','uncertain'));
