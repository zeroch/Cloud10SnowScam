CREATE TABLE IF NOT EXISTS pilot_window (id INTEGER PRIMARY KEY CHECK (id = 1), start_ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS pilot_cycles (slot INTEGER PRIMARY KEY CHECK (slot BETWEEN 0 AND 47), scheduled_ms INTEGER NOT NULL, finished_ms INTEGER);
CREATE TABLE IF NOT EXISTS pilot_attempts (slot INTEGER NOT NULL, provider TEXT NOT NULL, source_key TEXT NOT NULL, request_ms INTEGER, status INTEGER, outcome TEXT NOT NULL, retry_after TEXT, retry_until INTEGER, detail TEXT, PRIMARY KEY (slot, source_key));
CREATE INDEX IF NOT EXISTS pilot_attempts_by_source_slot ON pilot_attempts (source_key, slot DESC);
CREATE TABLE IF NOT EXISTS pilot_latest (source_key TEXT PRIMARY KEY, slot INTEGER NOT NULL, fetched_ms INTEGER NOT NULL, payload TEXT NOT NULL);
