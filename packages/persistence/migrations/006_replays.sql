-- URLs are server-only, short-lived candidates, never proof of a stored replay.
CREATE TABLE dota.replay_sources (
  match_id dota.provider_id PRIMARY KEY REFERENCES dota.matches,
  checked_at timestamptz NOT NULL,
  source text NOT NULL CHECK (source = 'opendota'),
  status text NOT NULL CHECK (status IN ('candidate','missing','unavailable')),
  url text,
  CHECK ((status = 'candidate') = (url IS NOT NULL))
);
