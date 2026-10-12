ALTER TABLE uploads ADD COLUMN error TEXT;
CREATE TABLE legacy_jobs(id TEXT PRIMARY KEY, source TEXT NOT NULL, disposition TEXT NOT NULL);
CREATE TABLE legacy_rate_limits(id TEXT PRIMARY KEY, source TEXT NOT NULL);
