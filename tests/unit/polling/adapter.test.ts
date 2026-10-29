/**
 * Adapter contract test.
 *
 * Verifies that synthetic polling events contain all the JSON paths
 * that the router adapter reads when processing webhooks.
 */

import { describe, expect, it } from 'vitest';

import {
	buildSyntheticCheckSuitePayload,
	buildSyntheticMergedPRPayload,
	buildSyntheticPRReviewPayload,
	type GitHubPRReview,
	type GitHubPullRequest,
	type GitHubWorkflowRun,
} from '../../../src/polling/providers/github/types.js';

/**
 * Real webhook payload fixtures.
 *
 * These represent the minimal structure of actual GitHub webhook payloads
 * based on documented fields the router adapter reads.
 */
const REAL_CHECK_SUITE_WEBHOOK = {
	_eventType: 'check_suite',
	_deliveryId: 'abc123-def456',
	action: 'completed',
	check_suite: {
		id: 123456789,
		status: 'completed',
		conclusion: 'success',
		head_sha: 'a1b2c3d4e5f6',
		head_branch: 'feature/my-branch',
		pull_requests: [
			{
				number: 42,
				head: {
					ref: 'feature/my-branch',
					sha: 'a1b2c3d4e5f6',
				},
			},
		],
	},
	repository: {
		full_name: 'owner/repo',
		html_url: 'https://github.com/owner/repo',
	},
	sender: {
		login: 'github-actions[bot]',
	},
};

const REAL_PR_REVIEW_WEBHOOK = {
	_eventType: 'pull_request_review',
	_deliveryId: 'review-123',
	action: 'submitted',
	review: {
		id: 987654321,
		state: 'approved',
		body: 'LGTM!',
		html_url: 'https://github.com/owner/repo/pull/42#pullrequestreview-987654321',
		user: {
			login: 'reviewer-user',
		},
	},
	pull_request: {
		number: 42,
		title: 'Add new feature',
		body: 'This PR adds a new feature.',
		html_url: 'https://github.com/owner/repo/pull/42',
		head: {
			ref: 'feature/new-feature',
			sha: 'xyz789',
		},
		base: {
			ref: 'main',
		},
	},
	repository: {
		full_name: 'owner/repo',
		html_url: 'https://github.com/owner/repo',
	},
	sender: {
		login: 'reviewer-user',
	},
};

const REAL_MERGED_PR_WEBHOOK = {
	_eventType: 'pull_request',
	_deliveryId: 'pr-merged-456',
	action: 'closed',
	number: 42,
	pull_request: {
		number: 42,
		title: 'Add new feature',
		body: 'This PR adds a new feature.',
		html_url: 'https://github.com/owner/repo/pull/42',
		state: 'closed',
		draft: false,
		merged: true,
		head: {
			ref: 'feature/new-feature',
			sha: 'xyz789',
		},
		base: {
			ref: 'main',
		},
		user: {
			login: 'pr-author',
		},
	},
	repository: {
		full_name: 'owner/repo',
		html_url: 'https://github.com/owner/repo',
	},
	sender: {
		login: 'pr-author',
	},
};

describe('adapter contract: synthetic events match webhook structure', () => {
	describe('check_suite events', () => {
		const mockWorkflowRun: GitHubWorkflowRun = {
			id: 111222333,
			name: 'CI',
			head_branch: 'feature/my-branch',
			head_sha: 'a1b2c3d4e5f6',
			status: 'completed',
			conclusion: 'success',
			workflow_id: 1,
			check_suite_id: 123456789,
			pull_requests: [],
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
			html_url: 'https://github.com/owner/repo/actions/runs/111222333',
		};

		const synthetic = buildSyntheticCheckSuitePayload(mockWorkflowRun, 'success', 'owner/repo', 42);

		it('has _eventType matching webhook', () => {
			expect(synthetic._eventType).toBe(REAL_CHECK_SUITE_WEBHOOK._eventType);
		});

		it('has _deliveryId (required for actionId)', () => {
			expect(synthetic._deliveryId).toBeDefined();
			expect(typeof synthetic._deliveryId).toBe('string');
		});

		it('has action: completed', () => {
			expect(synthetic.action).toBe(REAL_CHECK_SUITE_WEBHOOK.action);
		});

		it('has check_suite.id (from workflow run check_suite_id)', () => {
			expect(synthetic.check_suite.id).toBeDefined();
			expect(typeof synthetic.check_suite.id).toBe('number');
		});

		it('has check_suite.status', () => {
			expect(synthetic.check_suite.status).toBe('completed');
		});

		it('has check_suite.conclusion', () => {
			expect(['success', 'failure']).toContain(synthetic.check_suite.conclusion);
		});

		it('has check_suite.head_sha', () => {
			expect(synthetic.check_suite.head_sha).toBe(mockWorkflowRun.head_sha);
		});

		it('has check_suite.head_branch', () => {
			expect(synthetic.check_suite.head_branch).toBe(mockWorkflowRun.head_branch);
		});

		it('has check_suite.pull_requests array', () => {
			expect(Array.isArray(synthetic.check_suite.pull_requests)).toBe(true);
			expect(synthetic.check_suite.pull_requests.length).toBeGreaterThan(0);
			expect(synthetic.check_suite.pull_requests[0].number).toBe(42);
		});

		it('has repository.full_name', () => {
			expect(synthetic.repository.full_name).toBe('owner/repo');
		});

		it('has sender.login', () => {
			expect(synthetic.sender.login).toBeDefined();
			expect(typeof synthetic.sender.login).toBe('string');
		});

		it('synthetic structure matches all router-read paths', () => {
			// These are the exact paths the GitHubRouterAdapter reads
			expect(synthetic._eventType).toBeDefined();
			expect(synthetic._deliveryId).toBeDefined();
			expect(synthetic.action).toBeDefined();
			expect(synthetic.check_suite).toBeDefined();
			expect(synthetic.check_suite.id).toBeDefined();
			expect(synthetic.check_suite.status).toBeDefined();
			expect(synthetic.check_suite.conclusion).toBeDefined();
			expect(synthetic.check_suite.head_sha).toBeDefined();
			expect(synthetic.check_suite.head_branch).toBeDefined();
			expect(synthetic.check_suite.pull_requests).toBeDefined();
			expect(synthetic.repository).toBeDefined();
			expect(synthetic.repository.full_name).toBeDefined();
			expect(synthetic.sender).toBeDefined();
			expect(synthetic.sender.login).toBeDefined();
		});
	});

	describe('pull_request_review events', () => {
		const mockReview: GitHubPRReview = {
			id: 987654321,
			state: 'APPROVED',
			body: 'LGTM!',
			html_url: 'https://github.com/owner/repo/pull/42#pullrequestreview-987654321',
			user: {
				login: 'reviewer-user',
			},
			submitted_at: new Date().toISOString(),
			commit_id: 'xyz789',
		};

		const mockPR: GitHubPullRequest = {
			number: 42,
			title: 'Add new feature',
			body: 'This PR adds a new feature.',
			state: 'open',
			html_url: 'https://github.com/owner/repo/pull/42',
			head: {
				ref: 'feature/new-feature',
				sha: 'xyz789',
			},
			base: {
				ref: 'main',
			},
			user: {
				login: 'pr-author',
			},
			merged: false,
			merged_at: null,
			updated_at: new Date().toISOString(),
		};

		const synthetic = buildSyntheticPRReviewPayload(mockReview, mockPR, 'owner/repo');

		it('has _eventType matching webhook', () => {
			expect(synthetic._eventType).toBe(REAL_PR_REVIEW_WEBHOOK._eventType);
		});

		it('has _deliveryId', () => {
			expect(synthetic._deliveryId).toBeDefined();
			expect(typeof synthetic._deliveryId).toBe('string');
		});

		it('has action: submitted', () => {
			expect(synthetic.action).toBe(REAL_PR_REVIEW_WEBHOOK.action);
		});

		it('has review.id', () => {
			expect(synthetic.review.id).toBe(mockReview.id);
		});

		it('has review.state (lowercase)', () => {
			expect(synthetic.review.state).toBe('approved');
		});

		it('has review.body', () => {
			expect(synthetic.review.body).toBe(mockReview.body);
		});

		it('has review.user.login (critical for loop protection)', () => {
			expect(synthetic.review.user.login).toBe(mockReview.user.login);
		});

		it('has pull_request.number', () => {
			expect(synthetic.pull_request.number).toBe(mockPR.number);
		});

		it('has pull_request.title', () => {
			expect(synthetic.pull_request.title).toBe(mockPR.title);
		});

		it('has pull_request.head.ref and head.sha', () => {
			expect(synthetic.pull_request.head.ref).toBe(mockPR.head.ref);
			expect(synthetic.pull_request.head.sha).toBe(mockPR.head.sha);
		});

		it('has pull_request.base.ref', () => {
			expect(synthetic.pull_request.base.ref).toBe(mockPR.base.ref);
		});

		it('has repository.full_name', () => {
			expect(synthetic.repository.full_name).toBe('owner/repo');
		});

		it('has sender.login (same as reviewer for loop protection)', () => {
			expect(synthetic.sender.login).toBe(mockReview.user.login);
		});

		it('synthetic structure matches all router-read paths', () => {
			expect(synthetic._eventType).toBeDefined();
			expect(synthetic._deliveryId).toBeDefined();
			expect(synthetic.action).toBeDefined();
			expect(synthetic.review).toBeDefined();
			expect(synthetic.review.id).toBeDefined();
			expect(synthetic.review.state).toBeDefined();
			expect(synthetic.review.user).toBeDefined();
			expect(synthetic.review.user.login).toBeDefined();
			expect(synthetic.pull_request).toBeDefined();
			expect(synthetic.pull_request.number).toBeDefined();
			expect(synthetic.pull_request.head).toBeDefined();
			expect(synthetic.pull_request.base).toBeDefined();
			expect(synthetic.repository).toBeDefined();
			expect(synthetic.repository.full_name).toBeDefined();
			expect(synthetic.sender).toBeDefined();
			expect(synthetic.sender.login).toBeDefined();
		});
	});

	describe('pull_request closed+merged events', () => {
		const mockMergedPR: GitHubPullRequest = {
			number: 42,
			title: 'Add new feature',
			body: 'This PR adds a new feature.',
			state: 'closed',
			html_url: 'https://github.com/owner/repo/pull/42',
			head: {
				ref: 'feature/new-feature',
				sha: 'xyz789',
			},
			base: {
				ref: 'main',
			},
			user: {
				login: 'pr-author',
			},
			merged: true,
			merged_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
		};

		const synthetic = buildSyntheticMergedPRPayload(mockMergedPR, 'owner/repo');

		it('has _eventType matching webhook', () => {
			expect(synthetic._eventType).toBe(REAL_MERGED_PR_WEBHOOK._eventType);
		});

		it('has _deliveryId', () => {
			expect(synthetic._deliveryId).toBeDefined();
			expect(typeof synthetic._deliveryId).toBe('string');
		});

		it('has action: closed', () => {
			expect(synthetic.action).toBe(REAL_MERGED_PR_WEBHOOK.action);
		});

		it('has top-level number', () => {
			expect(synthetic.number).toBe(mockMergedPR.number);
		});

		it('has pull_request.number', () => {
			expect(synthetic.pull_request.number).toBe(mockMergedPR.number);
		});

		it('has pull_request.merged: true (critical for merge detection)', () => {
			expect(synthetic.pull_request.merged).toBe(true);
		});

		it('has pull_request.state: closed', () => {
			expect(synthetic.pull_request.state).toBe('closed');
		});

		it('has pull_request.draft: false', () => {
			expect(synthetic.pull_request.draft).toBe(false);
		});

		it('has pull_request.head.ref and head.sha', () => {
			expect(synthetic.pull_request.head.ref).toBe(mockMergedPR.head.ref);
			expect(synthetic.pull_request.head.sha).toBe(mockMergedPR.head.sha);
		});

		it('has pull_request.base.ref', () => {
			expect(synthetic.pull_request.base.ref).toBe(mockMergedPR.base.ref);
		});

		it('has pull_request.user.login', () => {
			expect(synthetic.pull_request.user.login).toBe(mockMergedPR.user.login);
		});

		it('has repository.full_name', () => {
			expect(synthetic.repository.full_name).toBe('owner/repo');
		});

		it('has sender.login', () => {
			expect(synthetic.sender.login).toBe(mockMergedPR.user.login);
		});

		it('synthetic structure matches all router-read paths', () => {
			expect(synthetic._eventType).toBeDefined();
			expect(synthetic._deliveryId).toBeDefined();
			expect(synthetic.action).toBeDefined();
			expect(synthetic.number).toBeDefined();
			expect(synthetic.pull_request).toBeDefined();
			expect(synthetic.pull_request.number).toBeDefined();
			expect(synthetic.pull_request.merged).toBe(true);
			expect(synthetic.pull_request.state).toBeDefined();
			expect(synthetic.pull_request.head).toBeDefined();
			expect(synthetic.pull_request.base).toBeDefined();
			expect(synthetic.pull_request.user).toBeDefined();
			expect(synthetic.pull_request.user.login).toBeDefined();
			expect(synthetic.repository).toBeDefined();
			expect(synthetic.repository.full_name).toBeDefined();
			expect(synthetic.sender).toBeDefined();
			expect(synthetic.sender.login).toBeDefined();
		});
	});
});
