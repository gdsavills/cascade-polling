import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock dependencies before imports
vi.mock('../../../../../src/polling/config.js', () => ({
	pollingConfig: {
		githubLookbackMs: 6 * 60 * 60 * 1000,
	},
}));

vi.mock('../../../../../src/polling/dispatch.js', () => ({
	batchCheckLedger: vi.fn().mockResolvedValue(new Set()),
	dispatchAndRecord: vi
		.fn()
		.mockResolvedValue({ recorded: true, deferred: false, skipped: false, enqueued: true }),
	recordWithoutDispatch: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../../../../src/triggers/github/pr-resolution.js', () => ({
	resolveCheckSuitePRNumber: vi.fn(),
}));

vi.mock('../../../../../src/utils/logging.js', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

import {
	batchCheckLedger,
	dispatchAndRecord,
	recordWithoutDispatch,
} from '../../../../../src/polling/dispatch.js';
import { pollCheckSuitesForRepo } from '../../../../../src/polling/providers/github/check-suite-poller.js';
import type { RouterPlatformAdapter } from '../../../../../src/router/platform-adapter.js';
import { resolveCheckSuitePRNumber } from '../../../../../src/triggers/github/pr-resolution.js';
import type { TriggerRegistry } from '../../../../../src/triggers/registry.js';

const mockAdapter = {
	type: 'github',
} as unknown as RouterPlatformAdapter;

const mockTriggerRegistry = {
	dispatch: vi.fn(),
} as unknown as TriggerRegistry;

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
		pulls: {
			list: vi.fn(),
		},
	} as unknown as Parameters<typeof pollCheckSuitesForRepo>[3];
}

function createWorkflowRun(
	overrides: Partial<{
		id: number;
		status: string;
		conclusion: string | null;
		head_sha: string;
		head_branch: string;
		check_suite_id: number;
		pull_requests: unknown[];
	}> = {},
) {
	return {
		id: overrides.id ?? 123,
		name: 'CI',
		status: overrides.status ?? 'completed',
		conclusion: overrides.conclusion ?? 'success',
		head_sha: overrides.head_sha ?? 'abc123',
		head_branch: overrides.head_branch ?? 'feature/test',
		check_suite_id: overrides.check_suite_id ?? 456,
		workflow_id: 1,
		pull_requests: overrides.pull_requests ?? [],
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
		html_url: 'https://github.com/owner/repo/actions/runs/123',
	};
}

describe('pollCheckSuitesForRepo', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('skips runs with non-emittable conclusions (cancelled, skipped, neutral)', async () => {
		const runs = [
			createWorkflowRun({ id: 1, conclusion: 'cancelled' }),
			createWorkflowRun({ id: 2, conclusion: 'skipped' }),
			createWorkflowRun({ id: 3, conclusion: 'neutral' }),
		];
		const octokit = createMockOctokit(runs);

		const result = await pollCheckSuitesForRepo(
			'p1',
			'owner',
			'repo',
			octokit,
			mockAdapter,
			mockTriggerRegistry,
		);

		expect(result.total).toBe(3);
		expect(result.ignored).toBe(3);
		expect(result.emitted).toBe(0);
		expect(dispatchAndRecord).not.toHaveBeenCalled();
		// Should record all as ignored
		expect(recordWithoutDispatch).toHaveBeenCalledTimes(3);
	});

	it('emits runs with success conclusion', async () => {
		const runs = [createWorkflowRun({ id: 1, conclusion: 'success' })];
		const octokit = createMockOctokit(runs);

		vi.mocked(resolveCheckSuitePRNumber).mockResolvedValueOnce({ ok: true, prNumber: 42 });

		const result = await pollCheckSuitesForRepo(
			'p1',
			'owner',
			'repo',
			octokit,
			mockAdapter,
			mockTriggerRegistry,
		);

		expect(result.emitted).toBe(1);
		expect(dispatchAndRecord).toHaveBeenCalledTimes(1);
	});

	it('emits runs with failure conclusion', async () => {
		const runs = [createWorkflowRun({ id: 1, conclusion: 'failure' })];
		const octokit = createMockOctokit(runs);

		vi.mocked(resolveCheckSuitePRNumber).mockResolvedValueOnce({ ok: true, prNumber: 42 });

		const result = await pollCheckSuitesForRepo(
			'p1',
			'owner',
			'repo',
			octokit,
			mockAdapter,
			mockTriggerRegistry,
		);

		expect(result.emitted).toBe(1);
		expect(dispatchAndRecord).toHaveBeenCalledTimes(1);
	});

	it('maps timed_out and action_required to failure', async () => {
		const runs = [
			createWorkflowRun({ id: 1, conclusion: 'timed_out' }),
			createWorkflowRun({ id: 2, conclusion: 'action_required' }),
		];
		const octokit = createMockOctokit(runs);

		vi.mocked(resolveCheckSuitePRNumber)
			.mockResolvedValueOnce({ ok: true, prNumber: 42 })
			.mockResolvedValueOnce({ ok: true, prNumber: 43 });

		const result = await pollCheckSuitesForRepo(
			'p1',
			'owner',
			'repo',
			octokit,
			mockAdapter,
			mockTriggerRegistry,
		);

		expect(result.emitted).toBe(2);
		expect(dispatchAndRecord).toHaveBeenCalledTimes(2);
	});

	describe('PR resolution error handling', () => {
		it('records as ignored when PR resolution succeeds but finds no PR', async () => {
			const runs = [createWorkflowRun({ id: 1, conclusion: 'success' })];
			const octokit = createMockOctokit(runs);

			// PR resolution returns ok:false (no PR found, but API succeeded)
			vi.mocked(resolveCheckSuitePRNumber).mockResolvedValueOnce({
				ok: false,
				reason: 'unresolved',
			});

			const result = await pollCheckSuitesForRepo(
				'p1',
				'owner',
				'repo',
				octokit,
				mockAdapter,
				mockTriggerRegistry,
			);

			// Should record as ignored (not dispatch)
			expect(result.ignored).toBe(1);
			expect(result.emitted).toBe(0);
			expect(recordWithoutDispatch).toHaveBeenCalledWith(
				'p1',
				'github',
				'ignored',
				expect.stringContaining('unresolvable_pr'),
			);
			expect(dispatchAndRecord).not.toHaveBeenCalled();
		});

		it('does NOT record when PR resolution throws transient error (leaves for retry)', async () => {
			const runs = [createWorkflowRun({ id: 1, conclusion: 'success' })];
			const octokit = createMockOctokit(runs);

			// PR resolution throws (transient error like rate limit or network)
			vi.mocked(resolveCheckSuitePRNumber).mockRejectedValueOnce(
				new Error('API rate limit exceeded'),
			);

			// Clear the mock to track if recordWithoutDispatch is called for unresolvable_pr
			vi.mocked(recordWithoutDispatch).mockClear();

			const result = await pollCheckSuitesForRepo(
				'p1',
				'owner',
				'repo',
				octokit,
				mockAdapter,
				mockTriggerRegistry,
			);

			// Should NOT record - left for retry on next poll cycle
			expect(result.ignored).toBe(0);
			expect(result.emitted).toBe(0);
			expect(result.errors).toBe(0); // Not counted as error since it will retry

			// recordWithoutDispatch should NOT be called for unresolvable_pr
			const unresolvableCalls = vi
				.mocked(recordWithoutDispatch)
				.mock.calls.filter((call) => String(call[3]).includes('unresolvable_pr'));
			expect(unresolvableCalls.length).toBe(0);

			expect(dispatchAndRecord).not.toHaveBeenCalled();
		});
	});

	it('skips runs already in ledger', async () => {
		const runs = [
			createWorkflowRun({ id: 1, conclusion: 'success' }),
			createWorkflowRun({ id: 2, conclusion: 'success' }),
		];
		const octokit = createMockOctokit(runs);

		// First run already in ledger
		vi.mocked(batchCheckLedger).mockResolvedValueOnce(
			new Set(['github:owner/repo:check_suite:abc123:success:1']),
		);
		vi.mocked(resolveCheckSuitePRNumber).mockResolvedValue({ ok: true, prNumber: 42 });

		const result = await pollCheckSuitesForRepo(
			'p1',
			'owner',
			'repo',
			octokit,
			mockAdapter,
			mockTriggerRegistry,
		);

		expect(result.skipped).toBe(1);
		expect(result.emitted).toBe(1);
		expect(dispatchAndRecord).toHaveBeenCalledTimes(1);
	});
});
