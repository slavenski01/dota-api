CREATE INDEX dataset_events_time ON dota.records(dataset_id, game_time_seconds, id COLLATE "C") WHERE kind='event';
CREATE INDEX dataset_states_player_time ON dota.records(dataset_id, player_slot, game_time_seconds) WHERE kind='hero_state';
