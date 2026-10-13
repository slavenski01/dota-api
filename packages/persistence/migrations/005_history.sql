CREATE TABLE dota.player_matches (
  account_id dota.provider_id NOT NULL REFERENCES dota.profiles,
  match_id dota.provider_id NOT NULL REFERENCES dota.matches,
  started_at timestamptz NOT NULL,
  hero_id integer,
  won boolean,
  summary jsonb NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(account_id,match_id)
);
CREATE INDEX player_matches_order ON dota.player_matches(account_id,started_at DESC,match_id DESC);
CREATE TABLE dota.history_pages (
  account_id dota.provider_id NOT NULL REFERENCES dota.profiles,
  page_offset integer NOT NULL CHECK (page_offset >= 0),
  fetched_at timestamptz NOT NULL DEFAULT now(),
  row_count integer NOT NULL,
  PRIMARY KEY(account_id,page_offset)
);
CREATE TABLE dota.history_requests (
  id uuid PRIMARY KEY,
  account_id dota.provider_id NOT NULL REFERENCES dota.profiles,
  page_offset integer NOT NULL,
  status text NOT NULL CHECK(status IN ('queued','ready','failed')),
  error text,
  retry_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE UNIQUE INDEX history_one_active ON dota.history_requests(account_id) WHERE status='queued';
CREATE TABLE dota.provider_cooldowns (
  provider text PRIMARY KEY,
  retry_at timestamptz NOT NULL
);
