-- =================================================================
--  Souqi Deploy — schema
--  -----------------------------------------------------------------
--  Postgres, separate from the main app's Mongo. These two stores
--  answer different questions and have different failure modes: the
--  builder can be down while deployed apps keep serving, and this
--  schema needs real transactions and foreign keys for the container
--  lifecycle, which is exactly what Mongo is worst at.
-- =================================================================

CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  email        TEXT UNIQUE NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS projects (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  framework    TEXT,                        -- detected or declared; see framework/detect.js
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS projects_user_idx ON projects(user_id, updated_at DESC);

-- Deployment status is a strict forward-only machine; see worker/pipeline.js.
--   QUEUED -> BUILDING -> STARTING -> RUNNING
--   any    -> FAILED
--   RUNNING -> STOPPED -> STARTING (restart)
--   any    -> DELETED
DO $$ BEGIN
  CREATE TYPE deployment_status AS ENUM
    ('QUEUED','BUILDING','STARTING','RUNNING','STOPPED','FAILED','DELETED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS deployments (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status         deployment_status NOT NULL DEFAULT 'QUEUED',
  framework      TEXT NOT NULL,
  container_name TEXT,
  image_name     TEXT,
  domain         TEXT UNIQUE,
  internal_port  INTEGER,                   -- port INSIDE the container; never published to the host
  host_id        TEXT NOT NULL DEFAULT 'local',   -- which VM runs it; the scheduler's future key
  cpu_limit      NUMERIC(4,2) NOT NULL DEFAULT 0.5,
  memory_mb      INTEGER      NOT NULL DEFAULT 512,
  pids_limit     INTEGER      NOT NULL DEFAULT 100,
  source_key     TEXT,                      -- object-storage key of the source archive
  error          TEXT,
  -- stop | start | restart | destroy, claimed by the worker.
  -- Lifecycle actions CANNOT run in the API: the api container has no Docker
  -- socket (deliberately), so a docker command issued there fails silently
  -- and the caller is told the container stopped when it is still running.
  pending_action TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Idempotent add for databases created before pending_action existed.
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS pending_action TEXT;

-- Container facts, observed by the worker and written here.
-- The API serves these from the database because it has no Docker socket to
-- ask with: it is the worker that can see Docker, so it is the worker that
-- records what it saw, and container_seen_at says how long ago that was.
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS container_state     TEXT;
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS container_exit_code INTEGER;
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS container_restarts  INTEGER;
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS container_seen_at   TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS deployments_project_idx ON deployments(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS deployments_user_idx    ON deployments(user_id, created_at DESC);
-- The worker claims work with this; partial index keeps it small as the
-- table grows, since only QUEUED rows are ever polled.
CREATE INDEX IF NOT EXISTS deployments_queue_idx   ON deployments(created_at) WHERE status = 'QUEUED';
CREATE INDEX IF NOT EXISTS deployments_action_idx  ON deployments(updated_at) WHERE pending_action IS NOT NULL;
CREATE INDEX IF NOT EXISTS deployments_host_idx    ON deployments(host_id) WHERE status IN ('RUNNING','STARTING');

CREATE TABLE IF NOT EXISTS deployment_logs (
  id            BIGSERIAL PRIMARY KEY,
  deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  phase         TEXT NOT NULL,              -- build | runtime | system
  stream        TEXT NOT NULL DEFAULT 'stdout',
  line          TEXT NOT NULL,
  at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS deployment_logs_idx ON deployment_logs(deployment_id, id);

CREATE TABLE IF NOT EXISTS domains (
  domain        TEXT PRIMARY KEY,
  deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  is_custom     BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Secrets are per PROJECT, not per deployment: a redeploy must inherit the
-- env the last one had, or every publish would silently drop the app's
-- config. Values are encrypted at rest (see src/secrets.js) and never
-- selected into any API response or log line.
CREATE TABLE IF NOT EXISTS project_env (
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  value_enc   TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, key)
);

-- Hosts the scheduler can place work on. One row ('local') in Phase 1;
-- the table exists now so Phase 5 is a data change, not a migration.
CREATE TABLE IF NOT EXISTS hosts (
  id            TEXT PRIMARY KEY,
  provider      TEXT NOT NULL DEFAULT 'local',
  public_ip     TEXT,
  cpu_cores     INTEGER,
  memory_mb     INTEGER,
  disk_gb       INTEGER,
  status        TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- The worker's heartbeat. It is the only process that can see Docker, so it
-- reports the version here and stamps the time; /health reads both. A stale
-- worker_seen_at is the signal that the worker has died — a failure the API
-- previously had no way to notice at all.
ALTER TABLE hosts ADD COLUMN IF NOT EXISTS docker_version  TEXT;
ALTER TABLE hosts ADD COLUMN IF NOT EXISTS worker_seen_at  TIMESTAMPTZ;

INSERT INTO hosts (id, provider, status) VALUES ('local','local','ACTIVE')
  ON CONFLICT (id) DO NOTHING;
