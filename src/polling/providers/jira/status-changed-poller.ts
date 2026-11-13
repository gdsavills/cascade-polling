/**
 * Jira status-changed poller.
 *
 * Polls for Jira issues that have status changes in their changelog since
 * the last watermark. Uses watermark-based polling with an overlap window.
 *
 * Based on verified Jira API behavior (Task 0):
 * - Search endpoint: GET /rest/api/3/search/jql with nextPageToken/isLast
 * - JQL: project = "<KEY>" AND updated >= -Nm ORDER BY updated ASC
 * - Fields: key,summary,status,updated + expand=changelog
 * - Timestamps in ISO 8601 format
 *
 * Per FINAL-PLAN-v2 corrections:
 * - Do NOT advance watermark if ANY dispatch in the cycle failed
 * - Filter out changes by bot account (loop protection)
 * - Cap lookback at 24 hours (1440 minutes) with warning
 */

import { and, eq } from 'drizzle-orm';
import { getDb } from '../../../db/client.js';
import { pollingWatermarks } from '../../../db/schema/polling.js';
import type { RouterPlatformAdapter } from '../../../router/platform-adapter.js';
import type { TriggerRegistry } from '../../../triggers/registry.js';
import { logger } from '../../../utils/logging.js';
import { pollingConfig } from '../../config.js';
import { batchCheckLedger, dispatchAndRecord, type PollingEventType } from '../../dispatch.js';
import {
	buildJiraStatusChangedDedupKey,
	buildSyntheticJiraStatusChangedPayload,
	filterStatusChangeHistories,
	type JiraChangelogHistory,
	type JiraIssue,
	type JiraSearchResponse,
} from './types.js';

/** Maximum lookback period in minutes (24 hours) */
const MAX_LOOKBACK_MINUTES = 1440;

/** Maximum pages to fetch to avoid infinite loops on API errors */
const MAX_PAGINATION_PAGES = 20;

/** Result of a status-changed poll cycle for a single project. */
export interface JiraStatusChangedPollResult {
	total: number;
	emitted: number;
	skipped: number;
	errors: number;
}

/**
 * Jira API client interface for dependency injection.
 * The actual implementation will use the project's Jira credentials.
 */
export interface JiraApiClient {
	searchIssues(params: {
		jql: string;
		fields: string[];
		expand: string[];
		nextPageToken?: string;
	}): Promise<JiraSearchResponse>;
}

/**
 * Get the watermark for status changes for a specific Jira project.
 */
async function getWatermark(projectId: string, jiraProjectKey: string): Promise<Date | null> {
	const db = getDb();
	const result = await db.query.pollingWatermarks.findFirst({
		where: and(
			eq(pollingWatermarks.projectId, projectId),
			eq(pollingWatermarks.provider, 'jira'),
			eq(pollingWatermarks.resourceType, 'status_changes'),
			eq(pollingWatermarks.resourceId, jiraProjectKey),
		),
	});
	return result?.watermark ?? null;
}

/**
 * Update the watermark for status changes for a specific Jira project.
 */
async function updateWatermark(
	projectId: string,
	jiraProjectKey: string,
	watermark: Date,
): Promise<void> {
	const db = getDb();
	await db
		.insert(pollingWatermarks)
		.values({
			projectId,
			provider: 'jira',
			resourceType: 'status_changes',
			resourceId: jiraProjectKey,
			watermark,
		})
		.onConflictDoUpdate({
			target: [
				pollingWatermarks.projectId,
				pollingWatermarks.provider,
				pollingWatermarks.resourceType,
				pollingWatermarks.resourceId,
			],
			set: {
				watermark,
				updatedAt: new Date(),
			},
		});
}

/**
 * Calculate the lookback minutes from watermark to now with overlap.
 * Returns the number of minutes to look back in JQL, capped at MAX_LOOKBACK_MINUTES.
 */
function calculateLookbackMinutes(watermark: Date | null, overlapMinutes: number): number {
	if (!watermark) {
		// No watermark = first poll, use default 1 hour
		return 60;
	}

	const now = Date.now();
	const watermarkMs = watermark.getTime();
	const elapsedMs = now - watermarkMs;
	const elapsedMinutes = Math.ceil(elapsedMs / 60_000);

	// Add overlap to ensure we don't miss events at the boundary
	const lookbackMinutes = elapsedMinutes + overlapMinutes;

	if (lookbackMinutes > MAX_LOOKBACK_MINUTES) {
		logger.warn('Jira polling lookback exceeds 24 hours, capping at maximum', {
			requestedMinutes: lookbackMinutes,
			cappedMinutes: MAX_LOOKBACK_MINUTES,
			watermark: watermark.toISOString(),
		});
		return MAX_LOOKBACK_MINUTES;
	}

	return lookbackMinutes;
}

/**
 * Poll Jira for status changes for a single project.
 *
 * NOTE: No author/bot filtering is applied. Cascade uses the user's own Jira
 * account, so filtering by author would drop every manual status move.
 *
 * @param projectId - Cascade project ID
 * @param jiraProjectKey - Jira project key (e.g., "PROJ")
 * @param jiraClient - Jira API client
 * @param adapter - Router platform adapter
 * @param triggerRegistry - Trigger registry for dispatch
 */
export async function pollJiraStatusChanges(
	projectId: string,
	jiraProjectKey: string,
	jiraClient: JiraApiClient,
	adapter: RouterPlatformAdapter,
	triggerRegistry: TriggerRegistry,
): Promise<JiraStatusChangedPollResult> {
	const result: JiraStatusChangedPollResult = {
		total: 0,
		emitted: 0,
		skipped: 0,
		errors: 0,
	};

	// Get watermark
	const watermark = await getWatermark(projectId, jiraProjectKey);
	const lookbackMinutes = calculateLookbackMinutes(watermark, pollingConfig.jiraOverlapMinutes);
	const watermarkTime = watermark ?? new Date(Date.now() - 60 * 60 * 1000);

	// Build JQL query
	const jql = `project = "${jiraProjectKey}" AND updated >= -${lookbackMinutes}m ORDER BY updated ASC`;

	logger.debug('Polling Jira for status changes', {
		projectId,
		jiraProjectKey,
		lookbackMinutes,
		jql,
	});

	// Fetch issues with changelog
	const allIssues: JiraIssue[] = [];
	let nextPageToken: string | undefined;
	let pageCount = 0;

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

			// Safety: exit if we hit max pages to prevent infinite loop
			if (pageCount >= MAX_PAGINATION_PAGES) {
				logger.warn('Jira polling hit max pagination pages', {
					projectId,
					jiraProjectKey,
					pageCount,
				});
				break;
			}

			// Handle edge case: isLast=false but empty next page
			if (response.isLast !== false) {
				break;
			}
		} while (nextPageToken);
	} catch (error) {
		logger.error('Failed to fetch Jira issues', {
			projectId,
			jiraProjectKey,
			error: String(error),
		});
		return result;
	}

	if (allIssues.length === 0) {
		// Update watermark even with no issues
		await updateWatermark(projectId, jiraProjectKey, new Date());
		return result;
	}

	// Collect all status change events from all issues
	const statusChangeEvents: Array<{
		issue: JiraIssue;
		history: JiraChangelogHistory;
		statusChange: {
			field: string;
			from?: string | null;
			to?: string | null;
			fromString?: string | null;
			toString?: string | null;
		};
		dedupKey: string;
	}> = [];

	for (const issue of allIssues) {
		if (!issue.changelog?.histories) continue;

		const statusChanges = filterStatusChangeHistories(issue.changelog.histories);

		for (const { history, statusChange } of statusChanges) {
			// Filter by watermark: only process changes AFTER the watermark
			const changeTime = new Date(history.created);
			if (changeTime <= watermarkTime) continue;

			// NOTE: No author/bot filtering — Cascade uses the user's own Jira
			// account, so filtering by author would drop every manual status move.

			const dedupKey = buildJiraStatusChangedDedupKey(jiraProjectKey, issue.key, history.id);
			statusChangeEvents.push({ issue, history, statusChange, dedupKey });
		}
	}

	result.total = statusChangeEvents.length;

	if (statusChangeEvents.length === 0) {
		await updateWatermark(projectId, jiraProjectKey, new Date());
		return result;
	}

	// Batch check ledger
	const dedupKeys = statusChangeEvents.map((e) => e.dedupKey);
	const existingKeys = await batchCheckLedger(projectId, 'jira', dedupKeys);

	const newEvents = statusChangeEvents.filter((e) => !existingKeys.has(e.dedupKey));

	logger.debug('Jira status changes ledger check', {
		jiraProjectKey,
		total: statusChangeEvents.length,
		existing: existingKeys.size,
		new: newEvents.length,
	});

	result.skipped = existingKeys.size;

	// Track the latest change time for watermark update
	let latestChangeTime = watermarkTime;
	let hasErrors = false;

	// Dispatch new status change events
	for (const { issue, history, statusChange, dedupKey } of newEvents) {
		const syntheticPayload = buildSyntheticJiraStatusChangedPayload(issue, history, statusChange);

		const dispatchResult = await dispatchAndRecord(
			projectId,
			'jira',
			'status_changed' as PollingEventType,
			dedupKey,
			syntheticPayload,
			adapter,
			triggerRegistry,
		);

		if (dispatchResult.error) {
			result.errors++;
			hasErrors = true;
			logger.error('Failed to dispatch Jira status change event', {
				jiraProjectKey,
				issueKey: issue.key,
				historyId: history.id,
				error: dispatchResult.error.message,
			});
		} else if (dispatchResult.enqueued || dispatchResult.skipped) {
			result.emitted++;
		}

		// Track latest change time
		const changeTime = new Date(history.created);
		if (changeTime > latestChangeTime) {
			latestChangeTime = changeTime;
		}
	}

	// Only update watermark if NO errors occurred (per FINAL-PLAN-v2 corrections)
	if (!hasErrors) {
		await updateWatermark(projectId, jiraProjectKey, latestChangeTime);
	} else {
		logger.warn('Jira polling had errors, NOT advancing watermark', {
			projectId,
			jiraProjectKey,
			errors: result.errors,
		});
	}

	return result;
}
