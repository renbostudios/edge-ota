-- EdgeOTA D1 Schema (Cloudflare Worker)
-- Apply with: wrangler d1 execute edge-ota-db --file=schema.sql

CREATE TABLE IF NOT EXISTS updates (
  id              TEXT PRIMARY KEY,
  created_at      TEXT NOT NULL,
  runtime_version TEXT NOT NULL,
  channel         TEXT NOT NULL,
  bundle_hash     TEXT NOT NULL,
  platform        TEXT NOT NULL DEFAULT 'all',
  metadata        TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_updates_runtime_channel
  ON updates (runtime_version, channel, created_at DESC);

-- Deployment channels with rollout and platform targeting
CREATE TABLE IF NOT EXISTS channels (
  id                TEXT PRIMARY KEY,
  env               TEXT NOT NULL DEFAULT 'Production',
  status            TEXT NOT NULL DEFAULT 'Active',
  rollout           INTEGER NOT NULL DEFAULT 100,
  runtime           TEXT NOT NULL DEFAULT '',
  active_release_id TEXT,
  target_platform   TEXT NOT NULL DEFAULT 'all',
  created_at        TEXT NOT NULL
);

-- Seed default channels
INSERT OR IGNORE INTO channels (id, env, status, rollout, runtime, active_release_id, target_platform, created_at)
VALUES
  ('production',   'Production', 'Active',  100, '', NULL, 'all', datetime('now')),
  ('staging',      'Staging',    'Active',  100, '', NULL, 'all', datetime('now')),
  ('experimental', 'Staging',    'Testing',  10, '', NULL, 'all', datetime('now'));
