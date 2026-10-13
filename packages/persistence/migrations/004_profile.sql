CREATE TABLE dota.selected_profile (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  account_id dota.provider_id NOT NULL REFERENCES dota.profiles
);
