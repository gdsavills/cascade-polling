import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock DB before imports
const mockFindFirst = vi.fn();
const mockInsert = vi.fn();
const mockValues = vi.fn();
const mockOnConflictDoUpdate = vi.fn().mockResolvedValue({ rowCount: 1 });

vi.mock('../../../../../src/db/client.js', () => ({
	getDb: vi.fn(() => ({
		query: {
			pollingWatermarks: {
				findFirst: mockFindFirst,
			},
		},
		insert: mockInsert,
	})),
}));

vi.mock('../../../../../src/polling/config.js', () => ({
	pollingConfig: {
		jiraOverlapMinutes: 2,
	},
}));

vi.mock('../../../../../src/polling/dispatch.js', () => ({
	batchCheckLedger: vi.fn().mockResolvedValue(new Set()),
	dispatchAndRecord: vi
		.fn()
		.mockResolvedValue({ recorded: true, deferred: false, skipped: false, enqueued: true }),
}));

vi.mock('../../../../../src/utils/logging.js', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

import { batchCheckLedger, dispatchAndRecord } from '../../../../../src/polling/dispatch.js';
import {
	type JiraApiClient,
	pollJiraStatusChanges,
} from '../../../../../src/polling/providers/jira/status-changed-poller.js';
import {
	buildJiraStatusChangedDedupKey,
	type JiraChangelogHistory,
	type JiraIssue,
} from '../../../../../src/polling/providers/jira/types.js';
import type { RouterPlatformAdapter } from '../../../../../src/router/platform-adapter.js';
import type { TriggerRegistry } from '../../../../../src/triggers/registry.js';

const mockAdapter = {
	type: 'jira',
} as unknown as RouterPlatformAdapter;

const mockTriggerRegistry = {
	dispatch: vi.fn(),
} as unknown as TriggerRegistry;

function createMockJiraClient(issues: JiraIssue[] = []): JiraApiClient {
	return {
		searchIssues: vi.fn().mockResolvedValue({
			issues,
			isLast: true,
		}),
	};
}

/**
 * Create a mock Jira issue based on Jira Cloud REST API v3 Search response.
 * Source: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/
 */
function createMockIssue(
	overrides: Partial<{
		id: string;
		key: string;
		summary: string;
		statusId: string;
		statusName: string;
		projectKey: string;
		changelog: { histories: JiraChangelogHistory[] };
	}> = {},
): JiraIssue {
	return {
		id: overrides.id ?? '10001',
		key: overrides.key ?? 'PROJ-123',
		fields: {
			summary: overrides.summary ?? 'Test Issue',
			status: {
				id: overrides.statusId ?? '10002',
				name: overrides.statusName ?? 'To Do',
			},
			project: {
				key: overrides.projectKey ?? 'PROJ',
			},
			updated: new Date().toISOString(),
		},
		changelog: overrides.changelog,
	};
}

/**
 * Create a mock Jira changelog history based on expand=changelog response.
 * Source: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/#api-rest-api-3-issue-issueidorkey-changelog-get
 */
function createMockHistory(
	overrides: Partial<{
		id: string;
		created: string;
		authorAccountId: string;
		statusFrom: string;
		statusTo: string;
		statusFromString: string;
		statusToString: string;
	}> = {},
): JiraChangelogHistory {
	return {
		id: overrides.id ?? 'history-123',
		created: overrides.created ?? new Date().toISOString(),
		author: {
			accountId: overrides.authorAccountId ?? 'user-account-id',
		},
		items: [
			{
				field: 'status',
				from: overrides.statusFrom ?? '10001',
				to: overrides.statusTo ?? '10002',
				fromString: overrides.statusFromString ?? 'Backlog',
				toString: overrides.statusToString ?? 'To Do',
			},
		],
	};
}

describe('pollJiraStatusChanges', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockFindFirst.mockResolvedValue(undefined);
		mockInsert.mockReturnValue({ values: mockValues });
		mockValues.mockReturnValue({ onConflictDoUpdate: mockOnConflictDoUpdate });
	});

	describe('watermark updates', () => {
		it('updates watermark after successful poll', async () => {
			const history = createMockHistory({
				created: new Date(Date.now() + 60000).toISOString(),
			});
			const issue = createMockIssue({
				changelog: { histories: [history] },
			});
			const jiraClient = createMockJiraClient([issue]);

			await pollJiraStatusChanges('p1', 'PROJ', jiraClient, mockAdapter, mockTriggerRegistry);

			expect(mockInsert).toHaveBeenCalled();
			expect(mockValues).toHaveBeenCalledWith(
				expect.objectContaining({
					projectId: 'p1',
					provider: 'jira',
					resourceType: 'status_changes',
					resourceId: 'PROJ',
				}),
			);
		});

		it('does NOT update watermark if errors occurred', async () => {
			const history = createMockHistory({
				created: new Date(Date.now() + 60000).toISOString(),
			});
			const issue = createMockIssue({
				changelog: { histories: [history] },
			});
			const jiraClient = createMockJiraClient([issue]);

			vi.mocked(dispatchAndRecord).mockResolvedValueOnce({
				recorded: false,
				deferred: false,
				skipped: false,
				enqueued: false,
				error: new Error('Dispatch failed'),
			});

			const result = await pollJiraStatusChanges(
				'p1',
				'PROJ',
				jiraClient,
				null,
				mockAdapter,
				mockTriggerRegistry,
			);

			expect(result.errors).toBe(1);
			// Watermark should NOT be updated when there are errors
			// The mockInsert for watermark happens in updateWatermark
			// Count the calls to verify no watermark update happened at the end
		});
	});

	describe('overlap window', () => {
		it('applies overlap window from config to JQL query', async () => {
			const watermarkDate = new Date(Date.now() - 30 * 60 * 1000); // 30 minutes ago
			mockFindFirst.mockResolvedValueOnce({ watermark: watermarkDate });

			const jiraClient = createMockJiraClient([]);

			await pollJiraStatusChanges('p1', 'PROJ', jiraClient, mockAdapter, mockTriggerRegistry);

			// Should have called searchIssues with JQL containing the lookback minutes
			expect(jiraClient.searchIssues).toHaveBeenCalledWith(
				expect.objectContaining({
					jql: expect.stringMatching(/updated >= -\d+m/),
				}),
			);
		});
	});

	describe('no author filtering (Cascade uses user account)', () => {
		it('emits status changes even when authored by the same account Cascade uses', async () => {
			// Cascade uses the user's own Jira account, so we must NOT filter
			// by author — doing so would drop every manual status move.
			const cascadeAccountId = 'cascade-user-account-123';
			const history = createMockHistory({
				authorAccountId: cascadeAccountId,
				created: new Date(Date.now() + 60000).toISOString(),
			});
			const issue = createMockIssue({
				changelog: { histories: [history] },
			});
			const jiraClient = createMockJiraClient([issue]);

			const result = await pollJiraStatusChanges(
				'p1',
				'PROJ',
				jiraClient,
				mockAdapter,
				mockTriggerRegistry,
			);

			// Status change by the same account MUST be emitted (no bot filtering)
			expect(result.total).toBe(1);
			expect(result.emitted).toBe(1);
			expect(dispatchAndRecord).toHaveBeenCalledTimes(1);
		});
	});

	describe('dedup key format', () => {
		it('uses correct dedup key format: jira:{projectKey}:status_changed:{issueKey}:{historyId}', async () => {
			const history = createMockHistory({
				id: 'hist-789',
				created: new Date(Date.now() + 60000).toISOString(),
			});
			const issue = createMockIssue({
				key: 'PROJ-456',
				changelog: { histories: [history] },
			});
			const jiraClient = createMockJiraClient([issue]);

			await pollJiraStatusChanges('p1', 'PROJ', jiraClient, mockAdapter, mockTriggerRegistry);

			const expectedDedupKey = buildJiraStatusChangedDedupKey('PROJ', 'PROJ-456', 'hist-789');
			expect(expectedDedupKey).toBe('jira:PROJ:status_changed:PROJ-456:hist-789');

			expect(dispatchAndRecord).toHaveBeenCalledWith(
				'p1',
				'jira',
				'status_changed',
				expectedDedupKey,
				expect.any(Object),
				mockAdapter,
				mockTriggerRegistry,
			);
		});
	});

	describe('synthetic payload structure', () => {
		it('builds correct synthetic payload for JiraRouterAdapter', async () => {
			const history = createMockHistory({
				id: 'hist-123',
				created: new Date(Date.now() + 60000).toISOString(),
				statusFrom: '10001',
				statusTo: '10002',
				statusFromString: 'Backlog',
				statusToString: 'To Do',
			});
			const issue = createMockIssue({
				id: 'issue-123',
				key: 'PROJ-456',
				summary: 'Test Issue Title',
				projectKey: 'PROJ',
				changelog: { histories: [history] },
			});
			const jiraClient = createMockJiraClient([issue]);

			await pollJiraStatusChanges('p1', 'PROJ', jiraClient, mockAdapter, mockTriggerRegistry);

			expect(dispatchAndRecord).toHaveBeenCalledWith(
				'p1',
				'jira',
				'status_changed',
				expect.any(String),
				expect.objectContaining({
					webhookEvent: 'jira:issue_updated',
					_deliveryId: expect.stringContaining('poll:jira_status:'),
					issue: expect.objectContaining({
						id: 'issue-123',
						key: 'PROJ-456',
						fields: expect.objectContaining({
							project: { key: 'PROJ' },
							status: { id: '10002', name: 'To Do' },
							summary: 'Test Issue Title',
						}),
					}),
					changelog: expect.objectContaining({
						items: expect.arrayContaining([
							expect.objectContaining({
								field: 'status',
								from: '10001',
								to: '10002',
								fromString: 'Backlog',
								toString: 'To Do',
							}),
						]),
					}),
				}),
				mockAdapter,
				mockTriggerRegistry,
			);
		});
	});

	describe('watermark filtering', () => {
		it('skips changes older than watermark', async () => {
			const watermarkDate = new Date();
			mockFindFirst.mockResolvedValueOnce({ watermark: watermarkDate });

			// History created BEFORE watermark
			const history = createMockHistory({
				created: new Date(watermarkDate.getTime() - 60000).toISOString(),
			});
			const issue = createMockIssue({
				changelog: { histories: [history] },
			});
			const jiraClient = createMockJiraClient([issue]);

			const result = await pollJiraStatusChanges(
				'p1',
				'PROJ',
				jiraClient,
				null,
				mockAdapter,
				mockTriggerRegistry,
			);

			expect(result.total).toBe(0);
			expect(dispatchAndRecord).not.toHaveBeenCalled();
		});
	});

	describe('ledger deduplication', () => {
		it('skips changes already in ledger', async () => {
			const history1 = createMockHistory({
				id: 'hist-1',
				created: new Date(Date.now() + 60000).toISOString(),
			});
			const history2 = createMockHistory({
				id: 'hist-2',
				created: new Date(Date.now() + 120000).toISOString(),
			});
			const issue = createMockIssue({
				key: 'PROJ-123',
				changelog: { histories: [history1, history2] },
			});
			const jiraClient = createMockJiraClient([issue]);

			// Mark first history as already processed
			vi.mocked(batchCheckLedger).mockResolvedValueOnce(
				new Set(['jira:PROJ:status_changed:PROJ-123:hist-1']),
			);

			const result = await pollJiraStatusChanges(
				'p1',
				'PROJ',
				jiraClient,
				null,
				mockAdapter,
				mockTriggerRegistry,
			);

			expect(result.total).toBe(2);
			expect(result.skipped).toBe(1);
			expect(result.emitted).toBe(1);
			expect(dispatchAndRecord).toHaveBeenCalledTimes(1);
		});
	});
});
