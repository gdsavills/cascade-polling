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
		githubPrBatchSize: 50,
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
import { pollPRReviewsForRepo } from '../../../../../src/polling/providers/github/pr-review-poller.js';
import { buildPRReviewDedupKey } from '../../../../../src/polling/providers/github/types.js';
import type { RouterPlatformAdapter } from '../../../../../src/router/platform-adapter.js';
import type { TriggerRegistry } from '../../../../../src/triggers/registry.js';

const mockAdapter = {
	type: 'github',
} as unknown as RouterPlatformAdapter;

const mockTriggerRegistry = {
	dispatch: vi.fn(),
} as unknown as TriggerRegistry;

function createMockOctokit(
	openPRs: unknown[] = [],
	reviewsMap: Map<number, unknown[]> = new Map(),
) {
	return {
		pulls: {
			list: vi.fn().mockResolvedValue({ data: openPRs }),
			listReviews: vi.fn().mockImplementation(({ pull_number }: { pull_number: number }) => {
				const reviews = reviewsMap.get(pull_number) ?? [];
				return Promise.resolve({ data: reviews });
			}),
		},
	} as unknown as Parameters<typeof pollPRReviewsForRepo>[3];
}

function createMockPR(
	overrides: Partial<{
		number: number;
		title: string;
		body: string | null;
		state: string;
		html_url: string;
		head: { ref: string; sha: string };
		base: { ref: string };
		user: { login: string } | null;
		merged_at: string | null;
		updated_at: string;
	}> = {},
) {
	return {
		number: overrides.number ?? 42,
		title: overrides.title ?? 'Test PR',
		body: overrides.body ?? 'PR body',
		state: overrides.state ?? 'open',
		html_url: overrides.html_url ?? 'https://github.com/owner/repo/pull/42',
		head: overrides.head ?? { ref: 'feature/test', sha: 'abc123' },
		base: overrides.base ?? { ref: 'main' },
		user: overrides.user ?? { login: 'author' },
		merged_at: overrides.merged_at ?? null,
		updated_at: overrides.updated_at ?? new Date().toISOString(),
	};
}

function createMockReview(
	overrides: Partial<{
		id: number;
		state: string;
		body: string | null;
		html_url: string;
		user: { login: string } | null;
		submitted_at: string | null;
		commit_id: string;
	}> = {},
) {
	return {
		id: overrides.id ?? 100,
		state: overrides.state ?? 'APPROVED',
		body: overrides.body ?? 'LGTM',
		html_url: overrides.html_url ?? 'https://github.com/owner/repo/pull/42#pullrequestreview-100',
		user: overrides.user ?? { login: 'reviewer' },
		submitted_at: overrides.submitted_at ?? new Date().toISOString(),
		commit_id: overrides.commit_id ?? 'abc123',
	};
}

describe('pollPRReviewsForRepo', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockFindFirst.mockResolvedValue(undefined);
		mockInsert.mockReturnValue({ values: mockValues });
		mockValues.mockReturnValue({ onConflictDoUpdate: mockOnConflictDoUpdate });
	});

	describe('watermark filtering', () => {
		it('skips reviews older than watermark', async () => {
			const watermarkDate = new Date('2024-06-01T12:00:00Z');
			mockFindFirst.mockResolvedValueOnce({ watermark: watermarkDate });

			const oldReview = createMockReview({
				id: 100,
				submitted_at: '2024-05-15T10:00:00Z', // Before watermark
			});

			const reviewsMap = new Map([[42, [oldReview]]]);
			const octokit = createMockOctokit([createMockPR({ number: 42 })], reviewsMap);

			const result = await pollPRReviewsForRepo(
				'p1',
				'owner',
				'repo',
				octokit,
				mockAdapter,
				mockTriggerRegistry,
			);

			expect(result.total).toBe(0);
			expect(result.emitted).toBe(0);
			expect(dispatchAndRecord).not.toHaveBeenCalled();
		});

		it('emits reviews after watermark', async () => {
			const watermarkDate = new Date('2024-06-01T12:00:00Z');
			mockFindFirst.mockResolvedValueOnce({ watermark: watermarkDate });

			const newReview = createMockReview({
				id: 101,
				submitted_at: '2024-06-15T10:00:00Z', // After watermark
			});

			const reviewsMap = new Map([[42, [newReview]]]);
			const octokit = createMockOctokit([createMockPR({ number: 42 })], reviewsMap);

			const result = await pollPRReviewsForRepo(
				'p1',
				'owner',
				'repo',
				octokit,
				mockAdapter,
				mockTriggerRegistry,
			);

			expect(result.total).toBe(1);
			expect(result.emitted).toBe(1);
			expect(dispatchAndRecord).toHaveBeenCalledTimes(1);
		});
	});

	describe('watermark updates', () => {
		it('updates watermark after successful poll', async () => {
			const newReview = createMockReview({
				id: 101,
				submitted_at: '2024-06-15T10:00:00Z',
			});

			const reviewsMap = new Map([[42, [newReview]]]);
			const octokit = createMockOctokit([createMockPR({ number: 42 })], reviewsMap);

			await pollPRReviewsForRepo('p1', 'owner', 'repo', octokit, mockAdapter, mockTriggerRegistry);

			expect(mockInsert).toHaveBeenCalled();
			expect(mockValues).toHaveBeenCalledWith(
				expect.objectContaining({
					projectId: 'p1',
					provider: 'github',
					resourceType: 'pr_reviews',
					resourceId: 'owner/repo',
				}),
			);
		});
	});

	describe('synthetic payload fields', () => {
		it('sets review.user.login in synthetic payload for loop protection', async () => {
			const newReview = createMockReview({
				id: 101,
				submitted_at: new Date(Date.now() + 60000).toISOString(), // Future to pass watermark
				user: { login: 'cascade-reviewer' },
			});

			const reviewsMap = new Map([[42, [newReview]]]);
			const octokit = createMockOctokit([createMockPR({ number: 42 })], reviewsMap);

			await pollPRReviewsForRepo('p1', 'owner', 'repo', octokit, mockAdapter, mockTriggerRegistry);

			expect(dispatchAndRecord).toHaveBeenCalledWith(
				'p1',
				'github',
				'pr_review',
				expect.any(String),
				expect.objectContaining({
					review: expect.objectContaining({
						user: { login: 'cascade-reviewer' },
					}),
					sender: { login: 'cascade-reviewer' },
				}),
				mockAdapter,
				mockTriggerRegistry,
			);
		});
	});

	describe('dedup key format', () => {
		it('uses correct dedup key format: github:{owner}/{repo}:pr_review:{pr_number}:{review_id}', async () => {
			const newReview = createMockReview({
				id: 12345,
				submitted_at: new Date(Date.now() + 60000).toISOString(),
			});

			const reviewsMap = new Map([[99, [newReview]]]);
			const octokit = createMockOctokit([createMockPR({ number: 99 })], reviewsMap);

			await pollPRReviewsForRepo('p1', 'owner', 'repo', octokit, mockAdapter, mockTriggerRegistry);

			const expectedDedupKey = buildPRReviewDedupKey('owner', 'repo', 99, 12345);
			expect(expectedDedupKey).toBe('github:owner/repo:pr_review:99:12345');

			expect(dispatchAndRecord).toHaveBeenCalledWith(
				'p1',
				'github',
				'pr_review',
				expectedDedupKey,
				expect.any(Object),
				mockAdapter,
				mockTriggerRegistry,
			);
		});
	});

	describe('ledger deduplication', () => {
		it('skips reviews already in ledger', async () => {
			const review1 = createMockReview({
				id: 100,
				submitted_at: new Date(Date.now() + 60000).toISOString(),
			});
			const review2 = createMockReview({
				id: 101,
				submitted_at: new Date(Date.now() + 60000).toISOString(),
			});

			const reviewsMap = new Map([[42, [review1, review2]]]);
			const octokit = createMockOctokit([createMockPR({ number: 42 })], reviewsMap);

			// Mark first review as already processed
			vi.mocked(batchCheckLedger).mockResolvedValueOnce(
				new Set(['github:owner/repo:pr_review:42:100']),
			);

			const result = await pollPRReviewsForRepo(
				'p1',
				'owner',
				'repo',
				octokit,
				mockAdapter,
				mockTriggerRegistry,
			);

			expect(result.total).toBe(2);
			expect(result.skipped).toBe(1);
			expect(result.emitted).toBe(1);
			expect(dispatchAndRecord).toHaveBeenCalledTimes(1);
		});
	});

	describe('PENDING reviews', () => {
		it('skips PENDING reviews', async () => {
			const pendingReview = createMockReview({
				id: 100,
				state: 'PENDING',
				submitted_at: new Date(Date.now() + 60000).toISOString(),
			});

			const reviewsMap = new Map([[42, [pendingReview]]]);
			const octokit = createMockOctokit([createMockPR({ number: 42 })], reviewsMap);

			const result = await pollPRReviewsForRepo(
				'p1',
				'owner',
				'repo',
				octokit,
				mockAdapter,
				mockTriggerRegistry,
			);

			expect(result.total).toBe(0);
			expect(dispatchAndRecord).not.toHaveBeenCalled();
		});
	});
});
