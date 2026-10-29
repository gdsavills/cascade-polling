/**
 * Polling configuration.
 *
 * All values are read from environment variables with sensible defaults.
 * POLLING_ENABLED is the master switch; when false, the scheduler is not started.
 */

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
	if (value === undefined || value === '') return defaultValue;
	return value.toLowerCase() === 'true' || value === '1';
}

function parseNumber(value: string | undefined, defaultValue: number): number {
	if (value === undefined || value === '') return defaultValue;
	const parsed = Number(value);
	return Number.isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Polling configuration object. All values are resolved at module load time.
 */
export const pollingConfig = {
	/** Master switch for polling. When false, the scheduler is not started. */
	enabled: parseBoolean(process.env.POLLING_ENABLED, false),

	/** Polling interval in milliseconds. Default: 60 seconds. */
	intervalMs: parseNumber(process.env.POLLING_INTERVAL_MS, 60_000),

	/** Overlap window for JIRA queries in minutes. Default: 2 minutes. */
	jiraOverlapMinutes: parseNumber(process.env.POLLING_JIRA_OVERLAP_MINUTES, 2),

	/** Fixed lookback window for GitHub workflow runs in milliseconds. Default: 6 hours. */
	githubLookbackMs: parseNumber(process.env.POLLING_GITHUB_LOOKBACK_MS, 6 * 60 * 60 * 1000),

	/** Max PRs per repo to check for reviews. Default: 30. */
	githubPrBatchSize: parseNumber(process.env.POLLING_GITHUB_PR_BATCH_SIZE, 30),

	/** Dedup ledger retention in days. Default: 30 days. */
	dedupRetentionDays: parseNumber(process.env.POLLING_DEDUP_RETENTION_DAYS, 30),

	/** Maximum pagination pages for workflow runs (safety limit). Default: 10. */
	maxPaginationPages: parseNumber(process.env.POLLING_MAX_PAGINATION_PAGES, 10),
} as const;

/** Type for the polling config object. */
export type PollingConfig = typeof pollingConfig;
