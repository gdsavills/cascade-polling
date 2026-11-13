/**
 * Types for Jira polling synthetic events.
 *
 * These types represent the API responses from Jira and the synthetic
 * events we build to feed into the existing router adapter.
 *
 * Based on verified Jira API behavior (Task 0):
 * - Search endpoint: GET /rest/api/3/search/jql with nextPageToken/isLast pagination
 * - Fields must be explicitly requested or key is null
 * - Changelog available via expand=changelog
 * - Timestamps in ISO 8601 format
 */

/**
 * Jira issue from the Search API.
 * See: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/
 */
export interface JiraIssue {
	id: string;
	key: string;
	fields: {
		summary: string;
		status: {
			id: string;
			name: string;
		};
		project: {
			key: string;
		};
		labels?: string[];
		components?: Array<{ name: string }>;
		updated: string;
		comment?: {
			comments: Array<{
				id: string;
				body: unknown;
				author?: { displayName?: string; accountId?: string };
			}>;
		};
	};
	changelog?: {
		histories: JiraChangelogHistory[];
	};
}

/**
 * Changelog history entry from expand=changelog.
 */
export interface JiraChangelogHistory {
	id: string;
	created: string;
	author: {
		accountId: string;
		displayName?: string;
	};
	items: JiraChangelogItem[];
}

/**
 * Individual change item within a changelog history.
 */
export interface JiraChangelogItem {
	field: string;
	fieldtype?: string;
	from?: string | null;
	fromString?: string | null;
	to?: string | null;
	toString?: string | null;
}

/**
 * Response from GET /rest/api/3/search/jql.
 * Uses nextPageToken/isLast pagination (NOT startAt/maxResults for search).
 */
export interface JiraSearchResponse {
	issues: JiraIssue[];
	nextPageToken?: string;
	isLast?: boolean;
	total?: number;
}

/**
 * Synthetic Jira webhook payload matching what the JiraRouterAdapter expects.
 * See: src/router/adapters/jira.ts and src/triggers/jira/types.ts
 */
export interface SyntheticJiraWebhookPayload {
	webhookEvent: 'jira:issue_updated' | 'jira:issue_created';
	_deliveryId: string;
	issue: {
		id: string;
		key: string;
		fields: {
			project: { key: string };
			status: { id: string; name: string };
			summary: string;
			labels?: string[];
			components?: Array<{ name: string }>;
		};
	};
	changelog?: {
		items: Array<{
			field: string;
			from?: string | null;
			to?: string | null;
			fromString?: string | null;
			toString?: string | null;
		}>;
	};
}

/**
 * Build a dedup key for a Jira status change event.
 * Format: jira:{projectKey}:status_changed:{issueKey}:{historyId}
 */
export function buildJiraStatusChangedDedupKey(
	projectKey: string,
	issueKey: string,
	historyId: string,
): string {
	return `jira:${projectKey}:status_changed:${issueKey}:${historyId}`;
}

/**
 * Build a synthetic Jira webhook payload from a changelog history.
 *
 * This builds a payload that mimics the jira:issue_updated webhook event,
 * which the JiraRouterAdapter and JiraStatusChangedTrigger expect.
 */
export function buildSyntheticJiraStatusChangedPayload(
	issue: JiraIssue,
	history: JiraChangelogHistory,
	statusChange: JiraChangelogItem,
): SyntheticJiraWebhookPayload {
	return {
		webhookEvent: 'jira:issue_updated',
		_deliveryId: `poll:jira_status:${issue.key}:${history.id}`,
		issue: {
			id: issue.id,
			key: issue.key,
			fields: {
				project: { key: issue.fields.project.key },
				status: {
					id: statusChange.to ?? '',
					name: statusChange.toString ?? '',
				},
				summary: issue.fields.summary,
				labels: issue.fields.labels,
				components: issue.fields.components,
			},
		},
		changelog: {
			items: [
				{
					field: 'status',
					from: statusChange.from,
					to: statusChange.to,
					fromString: statusChange.fromString,
					toString: statusChange.toString,
				},
			],
		},
	};
}

/**
 * Check if a changelog item is a status change.
 */
export function isStatusChangeItem(item: JiraChangelogItem): boolean {
	return item.field === 'status';
}

/**
 * Filter changelog histories for status changes.
 * Returns only histories that contain a status field change.
 */
export function filterStatusChangeHistories(
	histories: JiraChangelogHistory[],
): Array<{ history: JiraChangelogHistory; statusChange: JiraChangelogItem }> {
	const result: Array<{ history: JiraChangelogHistory; statusChange: JiraChangelogItem }> = [];

	for (const history of histories) {
		const statusChange = history.items.find(isStatusChangeItem);
		if (statusChange) {
			result.push({ history, statusChange });
		}
	}

	return result;
}
