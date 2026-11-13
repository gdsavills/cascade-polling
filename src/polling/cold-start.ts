/**
 * Cold start handler for polling.
 *
 * On first startup (no watermarks exist for a repo), seeds the ledger with
 * all discoverable run IDs WITHOUT dispatching. This prevents historical
 * events from triggering agents on first poll.
 *
 * Per FINAL-PLAN-v2 corrections:
 * - Cold start is per-repo, not just per-project
 * - Guard against empty arrays in inserts
 * - Use same conclusion mapping as the poller
 */

import type { Octokit } from '@octokit/rest';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { pollingWatermarks } from '../db/schema/polling.js';
import { logger } from '../utils/logging.js';
import { pollingConfig } from './config.js';
import { batchRecordWithoutDispatch, type PollingEventType } from './dispatch.js';
import {
	buildCheckSuiteDedupKey,
	type GitHubWorkflowRun,
	type GitHubWorkflowRunsResponse,
	shouldEmitWorkflowRun,
} from './providers/github/types.js';
import type { JiraApiClient } from './providers/jira/status-changed-poller.js';
import {
	buildJiraStatusChangedDedupKey,
	filterStatusChangeHistories,
	type JiraIssue,
} from './providers/jira/types.js';

/**
 * Check if a repo has any watermarks (indicating it's been polled before).
 */
async function hasRepoWatermarks(projectId: string, repoFullName: string): Promise<boolean> {
	const db = getDb();
	const result = await db.query.pollingWatermarks.findFirst({
		where: and(
			eq(pollingWatermarks.projectId, projectId),
			eq(pollingWatermarks.provider, 'github'),
			eq(pollingWatermarks.resourceId, repoFullName),
		),
	});
	return result !== undefined;
}

/**
 * Handle cold start for a single GitHub repository.
 * Seeds the ledger with existing workflow runs without dispatching.
 */
export async function handleGitHubRepoColdStart(
	projectId: string,
	owner: string,
	repo: string,
	octokit: Octokit,
): Promise<{ seeded: number; skipped: number }> {
	const repoFullName = `${owner}/${repo}`;
	const result = { seeded: 0, skipped: 0 };

	// Check if this repo has been polled before
	const hasWatermarks = await hasRepoWatermarks(projectId, repoFullName);
	if (hasWatermarks) {
		logger.debug('Repo already has watermarks, skipping cold start', {
			projectId,
			repoFullName,
		});
		return result;
	}

	logger.info('Cold start detected for repo, seeding ledger without dispatch', {
		projectId,
		repoFullName,
	});

	// Fetch workflow runs within lookback window
	const lookbackMs = pollingConfig.githubLookbackMs;
	const createdAfter = new Date(Date.now() - lookbackMs).toISOString();

	const runs: GitHubWorkflowRun[] = [];
	let page = 1;
	const perPage = 100;
	const maxPages = 10; // Same hardcoded limit as poller

	try {
		while (page <= maxPages) {
			const response = await octokit.actions.listWorkflowRunsForRepo({
				owner,
				repo,
				status: 'completed',
				created: `>=${createdAfter}`,
				per_page: perPage,
				page,
			});

			const data = response.data as GitHubWorkflowRunsResponse;
			runs.push(...data.workflow_runs);

			if (data.workflow_runs.length < perPage) {
				break;
			}
			page++;
		}
	} catch (error) {
		logger.error('Failed to fetch workflow runs for cold start', {
			projectId,
			repoFullName,
			error: String(error),
		});
		return result;
	}

	if (runs.length === 0) {
		// Initialize watermarks even with no runs
		await initializeRepoWatermarks(projectId, repoFullName);
		return result;
	}

	// Build dedup keys for all runs using same conclusion mapping as poller
	const events: Array<{ eventType: PollingEventType; dedupKey: string }> = [];

	for (const run of runs) {
		const emitResult = shouldEmitWorkflowRun(run);
		if (emitResult.emit) {
			// Emittable runs: record with their conclusion
			const dedupKey = buildCheckSuiteDedupKey(owner, repo, run, emitResult.conclusion);
			events.push({ eventType: 'check_suite', dedupKey });
		} else {
			// Skipped conclusions: record as ignored with same format as poller
			const ignoredDedupKey = `github:${repoFullName}:ignored:${run.id}:${emitResult.reason}`;
			events.push({ eventType: 'ignored', dedupKey: ignoredDedupKey });
			result.skipped++;
		}
	}

	// Batch record all events (guards against empty array internally)
	const recorded = await batchRecordWithoutDispatch(projectId, 'github', events);
	result.seeded = recorded;

	// Initialize watermarks
	await initializeRepoWatermarks(projectId, repoFullName);

	logger.info('Cold start complete for repo', {
		projectId,
		repoFullName,
		totalRuns: runs.length,
		seeded: result.seeded,
		skipped: result.skipped,
	});

	return result;
}

/**
 * Initialize watermarks for a repo to NOW.
 */
async function initializeRepoWatermarks(projectId: string, repoFullName: string): Promise<void> {
	const db = getDb();
	const now = new Date();

	// Initialize watermarks for PR reviews and merged PRs
	// (check_suite uses fixed lookback, doesn't need a watermark)
	await db
		.insert(pollingWatermarks)
		.values([
			{
				projectId,
				provider: 'github',
				resourceType: 'pr_reviews',
				resourceId: repoFullName,
				watermark: now,
			},
			{
				projectId,
				provider: 'github',
				resourceType: 'merged_prs',
				resourceId: repoFullName,
				watermark: now,
			},
		])
		.onConflictDoNothing();
}

/**
 * Check if a Jira project has watermarks (indicating it's been polled before).
 */
async function hasJiraWatermarks(projectId: string, jiraProjectKey: string): Promise<boolean> {
	const db = getDb();
	const result = await db.query.pollingWatermarks.findFirst({
		where: and(
			eq(pollingWatermarks.projectId, projectId),
			eq(pollingWatermarks.provider, 'jira'),
			eq(pollingWatermarks.resourceId, jiraProjectKey),
		),
	});
	return result !== undefined;
}

/**
 * Handle cold start for a single Jira project.
 * Seeds the ledger with existing status changes without dispatching.
 */
export async function handleJiraColdStart(
	projectId: string,
	jiraProjectKey: string,
	jiraClient: JiraApiClient,
): Promise<{ seeded: number; skipped: number }> {
	const result = { seeded: 0, skipped: 0 };

	// Check if this Jira project has been polled before
	const hasWatermarks = await hasJiraWatermarks(projectId, jiraProjectKey);
	if (hasWatermarks) {
		logger.debug('Jira project already has watermarks, skipping cold start', {
			projectId,
			jiraProjectKey,
		});
		return result;
	}

	logger.info('Cold start detected for Jira project, seeding ledger without dispatch', {
		projectId,
		jiraProjectKey,
	});

	// Fetch issues updated in the last hour (same as first-poll lookback)
	const jql = `project = "${jiraProjectKey}" AND updated >= -60m ORDER BY updated ASC`;

	const allIssues: JiraIssue[] = [];
	let nextPageToken: string | undefined;
	let pageCount = 0;
	const maxPages = 20;

	try {
		do {
			const response = await jiraClient.searchIssues({
				jql,
				fields: ['key', 'summary', 'status', 'updated', 'project', 'labels', 'components'],
				expand: ['changelog'],
				nextPageToken,
			});

			allIssues.push(...response.issues);
			nextPageToken = response.nextPageToken;
			pageCount++;

			if (pageCount >= maxPages || response.isLast !== false) {
				break;
			}
		} while (nextPageToken);
	} catch (error) {
		logger.error('Failed to fetch Jira issues for cold start', {
			projectId,
			jiraProjectKey,
			error: String(error),
		});
		return result;
	}

	if (allIssues.length === 0) {
		// Initialize watermark even with no issues
		await initializeJiraWatermark(projectId, jiraProjectKey);
		return result;
	}

	// Build dedup keys for all status changes
	const events: Array<{ eventType: PollingEventType; dedupKey: string }> = [];

	for (const issue of allIssues) {
		if (!issue.changelog?.histories) continue;

		const statusChanges = filterStatusChangeHistories(issue.changelog.histories);
		for (const { history } of statusChanges) {
			const dedupKey = buildJiraStatusChangedDedupKey(jiraProjectKey, issue.key, history.id);
			events.push({ eventType: 'status_changed', dedupKey });
		}
	}

	// Batch record all events without dispatch
	const recorded = await batchRecordWithoutDispatch(projectId, 'jira', events);
	result.seeded = recorded;

	// Initialize watermark
	await initializeJiraWatermark(projectId, jiraProjectKey);

	logger.info('Cold start complete for Jira project', {
		projectId,
		jiraProjectKey,
		totalIssues: allIssues.length,
		seeded: result.seeded,
	});

	return result;
}

/**
 * Initialize watermark for a Jira project to NOW.
 */
async function initializeJiraWatermark(projectId: string, jiraProjectKey: string): Promise<void> {
	const db = getDb();
	const now = new Date();

	await db
		.insert(pollingWatermarks)
		.values({
			projectId,
			provider: 'jira',
			resourceType: 'status_changes',
			resourceId: jiraProjectKey,
			watermark: now,
		})
		.onConflictDoNothing();
}
