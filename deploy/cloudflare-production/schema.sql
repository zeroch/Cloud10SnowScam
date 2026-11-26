CREATE TABLE IF NOT EXISTS production_attempts (
  slot INTEGER NOT NULL, provider TEXT NOT NULL, source_key TEXT NOT NULL,
  request_ms INTEGER, status INTEGER, outcome TEXT NOT NULL,
  retry_after TEXT, retry_until INTEGER, detail TEXT,
  PRIMARY KEY (slot, source_key)
);
CREATE INDEX IF NOT EXISTS production_source_slot ON production_attempts(source_key,slot DESC);
CREATE INDEX IF NOT EXISTS production_provider_retry ON production_attempts(provider,retry_until);
CREATE TABLE IF NOT EXISTS production_clock (id INTEGER PRIMARY KEY CHECK (id=1), scheduled_ms INTEGER NOT NULL);
