import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock DB before imports
const mockFindFirst = vi.fn();
const mockInsert = vi.fn();
const mockValues = vi.fn();
const mockOnConflictDoNothing = vi.fn().mockResolvedValue({ rowCount: 1 });

vi.mock('../../../src/db/client.js', () => ({
	getDb: vi.fn(() => ({
		query: {
			pollingWatermarks: {
				findFirst: mockFindFirst,
			},
		},
		insert: mockInsert,
	})),
}));

vi.mock('../../../src/polling/config.js', () => ({
	pollingConfig: {
		githubLookbackMs: 6 * 60 * 60 * 1000, // 6 hours
	},
}));

const mockBatchRecordWithoutDispatch = vi.fn().mockResolvedValue(5);
vi.mock('../../../src/polling/dispatch.js', () => ({
	batchRecordWithoutDispatch: (...args: unknown[]) => mockBatchRecordWithoutDispatch(...args),
}));

vi.mock('../../../src/utils/logging.js', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

import { handleGitHubRepoColdStart } from '../../../src/polling/cold-start.js';
import {
	buildCheckSuiteDedupKey,
	type GitHubWorkflowRun,
} from '../../../src/polling/providers/github/types.js';

function createMockOctokit(workflowRuns: unknown[] = []) {
	return {
		actions: {
			listWorkflowRunsForRepo: vi.fn().mockResolvedValue({
				data: {
					total_count: workflowRuns.length,
					workflow_runs: workflowRuns,
				},
			}),
		},
	} as unknown as Parameters<typeof handleGitHubRepoColdStart>[3];
}

function createWorkflowRun(
	overrides: Partial<{
		id: number;
		name: string;
		status: string;
		conclusion: string | null;
		head_sha: string;
		head_branch: string | null;
		check_suite_id: number;
		workflow_id: number;
		pull_requests: unknown[];
		created_at: string;
		updated_at: string;
		html_url: string;
	}> = {},
): GitHubWorkflowRun {
	return {
		id: overrides.id ?? 123,
		name: overrides.name ?? 'CI',
		status: (overrides.status ?? 'completed') as GitHubWorkflowRun['status'],
		conclusion: overrides.conclusion === undefined ? 'success' : overrides.conclusion,
		head_sha: overrides.head_sha ?? 'abc123',
		head_branch: overrides.head_branch ?? 'feature/test',
		check_suite_id: overrides.check_suite_id ?? 456,
		workflow_id: overrides.workflow_id ?? 1,
		pull_requests: (overrides.pull_requests ?? []) as GitHubWorkflowRun['pull_requests'],
		created_at: overrides.created_at ?? new Date().toISOString(),
		updated_at: overrides.updated_at ?? new Date().toISOString(),
		html_url: overrides.html_url ?? 'https://github.com/owner/repo/actions/runs/123',
	} as GitHubWorkflowRun;
}

describe('handleGitHubRepoColdStart', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockFindFirst.mockResolvedValue(undefined); // No watermarks by default
		mockInsert.mockReturnValue({ values: mockValues });
		mockValues.mockReturnValue({ onConflictDoNothing: mockOnConflictDoNothing });
	});

	describe('per-repo cold start', () => {
		it('inserts dedup keys for each workflow run in the repo', async () => {
			const runs = [
				createWorkflowRun({ id: 1, conclusion: 'success' }),
				createWorkflowRun({ id: 2, conclusion: 'failure' }),
				createWorkflowRun({ id: 3, conclusion: 'success' }),
			];
			const octokit = createMockOctokit(runs);

			await handleGitHubRepoColdStart('p1', 'owner', 'repo', octokit);

			expect(mockBatchRecordWithoutDispatch).toHaveBeenCalledTimes(1);
			const events = mockBatchRecordWithoutDispatch.mock.calls[0][2];
			expect(events).toHaveLength(3);
		});

		it('skips cold start if repo already has watermarks', async () => {
			// Repo already has watermarks
			mockFindFirst.mockResolvedValueOnce({
				projectId: 'p1',
				provider: 'github',
				resourceId: 'owner/repo',
				watermark: new Date(),
			});

			const octokit = createMockOctokit([createWorkflowRun()]);

			const result = await handleGitHubRepoColdStart('p1', 'owner', 'repo', octokit);

			expect(result.seeded).toBe(0);
			expect(result.skipped).toBe(0);
			expect(mockBatchRecordWithoutDispatch).not.toHaveBeenCalled();
		});
	});

	describe('empty-insert guard', () => {
		it('does not call batchRecordWithoutDispatch when no workflow runs exist', async () => {
			const octokit = createMockOctokit([]);

			const result = await handleGitHubRepoColdStart('p1', 'owner', 'repo', octokit);

			expect(result.seeded).toBe(0);
			expect(mockBatchRecordWithoutDispatch).not.toHaveBeenCalled();
		});

		it('still initializes watermarks when no runs exist', async () => {
			const octokit = createMockOctokit([]);

			await handleGitHubRepoColdStart('p1', 'owner', 'repo', octokit);

			// Should still insert watermarks for pr_reviews and merged_prs
			expect(mockInsert).toHaveBeenCalled();
		});
	});

	describe('conclusion mapping', () => {
		it('maps success conclusion to check_suite event type', async () => {
			const runs = [createWorkflowRun({ id: 1, conclusion: 'success' })];
			const octokit = createMockOctokit(runs);

			await handleGitHubRepoColdStart('p1', 'owner', 'repo', octokit);

			const events = mockBatchRecordWithoutDispatch.mock.calls[0][2];
			expect(events[0].eventType).toBe('check_suite');
		});

		it('maps failure conclusion to check_suite event type', async () => {
			const runs = [createWorkflowRun({ id: 1, conclusion: 'failure' })];
			const octokit = createMockOctokit(runs);

			await handleGitHubRepoColdStart('p1', 'owner', 'repo', octokit);

			const events = mockBatchRecordWithoutDispatch.mock.calls[0][2];
			expect(events[0].eventType).toBe('check_suite');
		});

		it('maps timed_out and action_required to check_suite (failure)', async () => {
			const runs = [
				createWorkflowRun({ id: 1, conclusion: 'timed_out' }),
				createWorkflowRun({ id: 2, conclusion: 'action_required' }),
			];
			const octokit = createMockOctokit(runs);

			await handleGitHubRepoColdStart('p1', 'owner', 'repo', octokit);

			const events = mockBatchRecordWithoutDispatch.mock.calls[0][2];
			expect(events).toHaveLength(2);
			expect(events[0].eventType).toBe('check_suite');
			expect(events[1].eventType).toBe('check_suite');
		});

		it('maps cancelled/neutral/skipped/stale to ignored', async () => {
			const runs = [
				createWorkflowRun({ id: 1, conclusion: 'cancelled' }),
				createWorkflowRun({ id: 2, conclusion: 'neutral' }),
				createWorkflowRun({ id: 3, conclusion: 'skipped' }),
				createWorkflowRun({ id: 4, conclusion: 'stale' }),
			];
			const octokit = createMockOctokit(runs);

			const result = await handleGitHubRepoColdStart('p1', 'owner', 'repo', octokit);

			const events = mockBatchRecordWithoutDispatch.mock.calls[0][2];
			expect(events).toHaveLength(4);
			expect(events.every((e: { eventType: string }) => e.eventType === 'ignored')).toBe(true);
			expect(result.skipped).toBe(4);
		});
	});

	describe('dedup key format consistency', () => {
		it('uses same dedup key format as regular polling for emittable runs', async () => {
			const run = createWorkflowRun({
				id: 12345,
				head_sha: 'abc123',
				conclusion: 'success',
			});
			const octokit = createMockOctokit([run]);

			await handleGitHubRepoColdStart('p1', 'owner', 'repo', octokit);

			const events = mockBatchRecordWithoutDispatch.mock.calls[0][2];
			const expectedDedupKey = buildCheckSuiteDedupKey('owner', 'repo', run, 'success');

			expect(events[0].dedupKey).toBe(expectedDedupKey);
			expect(expectedDedupKey).toMatch(/^github:owner\/repo:check_suite:abc123:success:\d+$/);
		});

		it('uses github:{owner}/{repo}:ignored:{run_id}:{reason} format for ignored runs', async () => {
			const run = createWorkflowRun({
				id: 999,
				conclusion: 'cancelled',
			});
			const octokit = createMockOctokit([run]);

			await handleGitHubRepoColdStart('p1', 'owner', 'repo', octokit);

			const events = mockBatchRecordWithoutDispatch.mock.calls[0][2];
			expect(events[0].dedupKey).toBe('github:owner/repo:ignored:999:skipped_conclusion_cancelled');
		});
	});

	describe('watermark initialization', () => {
		it('initializes watermarks for pr_reviews and merged_prs', async () => {
			const runs = [createWorkflowRun({ id: 1, conclusion: 'success' })];
			const octokit = createMockOctokit(runs);

			await handleGitHubRepoColdStart('p1', 'owner', 'repo', octokit);

			// Check that watermarks are inserted
			const insertedValues = mockValues.mock.calls.find(
				(call) =>
					Array.isArray(call[0]) &&
					call[0].some((v: unknown) => typeof v === 'object' && v !== null && 'resourceType' in v),
			);
			expect(insertedValues).toBeDefined();
		});
	});
});
