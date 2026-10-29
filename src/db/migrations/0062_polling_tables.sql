-- Polling tables for inbound event polling (replacing webhooks in environments
-- without inbound internet access).

-- Watermarks for incremental polling. Each (project, provider, resource_type,
-- resource_id) tuple tracks the last-seen timestamp or cursor so subsequent
-- polls only fetch newer items. resource_id is typically empty but allows
-- per-PR or per-issue tracking when needed.
CREATE TABLE polling_watermarks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL DEFAULT '',
  watermark TIMESTAMP WITH TIME ZONE NOT NULL,
  etag TEXT,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  CONSTRAINT polling_watermarks_unique
    UNIQUE (project_id, provider, resource_type, resource_id)
);

-- Processed events ledger for deduplication. Each event is keyed by a dedup_key
-- that encodes enough context to identify the event uniquely (e.g. run ID for
-- workflow runs, history ID for Jira changelog entries). event_type can be
-- 'check_suite', 'status_changed', 'pr_review', 'merged_pr', or 'ignored' (for
-- events that were filtered out but need to be remembered to avoid re-processing).
CREATE TABLE polling_processed_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  event_type TEXT NOT NULL,
  dedup_key TEXT NOT NULL,
  processed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  CONSTRAINT polling_processed_events_unique
    UNIQUE (project_id, provider, dedup_key)
);

-- Index for cleanup job (retention policy based on processed_at)
CREATE INDEX idx_polling_processed_events_processed_at
  ON polling_processed_events (processed_at);

-- Down migration (for rollback)
-- DROP INDEX IF EXISTS idx_polling_processed_events_processed_at;
-- DROP TABLE IF EXISTS polling_processed_events;
-- DROP TABLE IF EXISTS polling_watermarks;
