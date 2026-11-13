/**
 * Adapter contract test.
 *
 * Verifies that synthetic polling events contain all the JSON paths
 * that the router adapter reads when processing webhooks, by comparing
 * against real webhook payload fixtures from official documentation.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
	buildSyntheticCheckSuitePayload,
	buildSyntheticMergedPRPayload,
	buildSyntheticPRReviewPayload,
	type GitHubPRReview,
	type GitHubPullRequest,
	type GitHubWorkflowRun,
} from '../../../src/polling/providers/github/types.js';
import {
	buildSyntheticJiraStatusChangedPayload,
	type JiraChangelogHistory,
	type JiraChangelogItem,
	type JiraIssue,
} from '../../../src/polling/providers/jira/types.js';

// Load real webhook fixtures
const FIXTURES_DIR = join(__dirname, '../../fixtures/webhooks');

function loadFixture(name: string): unknown {
	const path = join(FIXTURES_DIR, name);
	return JSON.parse(readFileSync(path, 'utf-8'));
}

/**
 * Extract all JSON paths from an object (dot notation).
 * Skips _source and _note metadata fields.
 */
function extractPaths(obj: unknown, prefix = ''): Set<string> {
	const paths = new Set<string>();
	if (obj === null || obj === undefined) return paths;
	if (typeof obj !== 'object') return paths;

	for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
		// Skip metadata fields
		if (key === '_source' || key === '_note') continue;

		const path = prefix ? `${prefix}.${key}` : key;
		paths.add(path);

		if (value && typeof value === 'object' && !Array.isArray(value)) {
			for (const subPath of extractPaths(value, path)) {
				paths.add(subPath);
			}
		} else if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'object') {
			// For arrays of objects, extract paths from first element
			for (const subPath of extractPaths(value[0], `${path}[0]`)) {
				paths.add(subPath);
			}
		}
	}
	return paths;
}

/**
 * Paths that triggers and adapters actually read from the payload.
 * Derived from code analysis of src/router/adapters/ and src/triggers/.
 */
const REQUIRED_PATHS = {
	checkSuite: [
		'action',
		'check_suite',
		'check_suite.id',
		'check_suite.status',
		'check_suite.conclusion',
		'check_suite.head_sha',
		'check_suite.head_branch',
		'check_suite.pull_requests',
		'repository',
		'repository.full_name',
		'sender',
		'sender.login',
	],
	prReview: [
		'action',
		'review',
		'review.id',
		'review.state',
		'review.body',
		'review.user',
		'review.user.login',
		'pull_request',
		'pull_request.number',
		'pull_request.title',
		'pull_request.head',
		'pull_request.head.ref',
		'pull_request.head.sha',
		'pull_request.base',
		'pull_request.base.ref',
		'repository',
		'repository.full_name',
		'sender',
		'sender.login',
	],
	prMerged: [
		'action',
		'number',
		'pull_request',
		'pull_request.number',
		'pull_request.merged',
		'pull_request.state',
		'pull_request.draft',
		'pull_request.head',
		'pull_request.head.ref',
		'pull_request.head.sha',
		'pull_request.base',
		'pull_request.base.ref',
		'pull_request.user',
		'pull_request.user.login',
		'repository',
		'repository.full_name',
		'sender',
		'sender.login',
	],
	jiraStatusChanged: [
		'webhookEvent',
		'issue',
		'issue.id',
		'issue.key',
		'issue.fields',
		'issue.fields.project',
		'issue.fields.project.key',
		'issue.fields.status',
		'issue.fields.status.id',
		'issue.fields.status.name',
		'issue.fields.summary',
		'changelog',
		'changelog.items',
	],
};

describe('adapter contract: synthetic events match real webhook structure', () => {
	describe('check_suite events', () => {
		const realFixture = loadFixture('github-check-suite-completed.json') as Record<string, unknown>;

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

		it('synthetic has all required paths that adapters/triggers read', () => {
			const syntheticPaths = extractPaths(synthetic);
			const missing = REQUIRED_PATHS.checkSuite.filter((p) => !syntheticPaths.has(p));
			expect(
				missing,
				`Synthetic check_suite missing required paths: ${missing.join(', ')}`,
			).toEqual([]);
		});

		it('real fixture has all required paths (validates fixture correctness)', () => {
			const realPaths = extractPaths(realFixture);
			const missing = REQUIRED_PATHS.checkSuite.filter((p) => !realPaths.has(p));
			expect(missing, `Real fixture missing required paths: ${missing.join(', ')}`).toEqual([]);
		});

		it('reports paths in real fixture but missing in synthetic (informational)', () => {
			const realPaths = extractPaths(realFixture);
			const syntheticPaths = extractPaths(synthetic);
			const extraInReal = [...realPaths].filter((p) => !syntheticPaths.has(p));
			// This is informational - we don't fail on extra paths in real fixture
			// as long as synthetic has all REQUIRED_PATHS
			if (extraInReal.length > 0) {
				console.log(
					'check_suite: Paths in real fixture but not in synthetic:',
					extraInReal.slice(0, 10),
				);
			}
		});

		it('matches key structural values', () => {
			expect(synthetic.action).toBe(realFixture.action);
			expect(typeof synthetic.check_suite).toBe(typeof realFixture.check_suite);
			expect(typeof synthetic.repository).toBe(typeof realFixture.repository);
			expect(typeof synthetic.sender).toBe(typeof realFixture.sender);
		});
	});

	describe('pull_request_review events', () => {
		const realFixture = loadFixture('github-pull-request-review-submitted.json') as Record<
			string,
			unknown
		>;

		const mockReview: GitHubPRReview = {
			id: 987654321,
			state: 'APPROVED',
			body: 'LGTM!',
			html_url: 'https://github.com/owner/repo/pull/42#pullrequestreview-987654321',
			user: { login: 'reviewer-user' },
			submitted_at: new Date().toISOString(),
			commit_id: 'xyz789',
		};

		const mockPR: GitHubPullRequest = {
			number: 42,
			title: 'Add new feature',
			body: 'This PR adds a new feature.',
			state: 'open',
			html_url: 'https://github.com/owner/repo/pull/42',
			head: { ref: 'feature/new-feature', sha: 'xyz789' },
			base: { ref: 'main' },
			user: { login: 'pr-author' },
			merged: false,
			merged_at: null,
			updated_at: new Date().toISOString(),
		};

		const synthetic = buildSyntheticPRReviewPayload(mockReview, mockPR, 'owner/repo');

		it('synthetic has all required paths that adapters/triggers read', () => {
			const syntheticPaths = extractPaths(synthetic);
			const missing = REQUIRED_PATHS.prReview.filter((p) => !syntheticPaths.has(p));
			expect(missing, `Synthetic pr_review missing required paths: ${missing.join(', ')}`).toEqual(
				[],
			);
		});

		it('real fixture has all required paths (validates fixture correctness)', () => {
			const realPaths = extractPaths(realFixture);
			const missing = REQUIRED_PATHS.prReview.filter((p) => !realPaths.has(p));
			expect(missing, `Real fixture missing required paths: ${missing.join(', ')}`).toEqual([]);
		});

		it('reports paths in real fixture but missing in synthetic (informational)', () => {
			const realPaths = extractPaths(realFixture);
			const syntheticPaths = extractPaths(synthetic);
			const extraInReal = [...realPaths].filter((p) => !syntheticPaths.has(p));
			if (extraInReal.length > 0) {
				console.log(
					'pr_review: Paths in real fixture but not in synthetic:',
					extraInReal.slice(0, 10),
				);
			}
		});

		it('matches key structural values', () => {
			expect(synthetic.action).toBe(realFixture.action);
			expect(typeof synthetic.review).toBe(typeof realFixture.review);
			expect(typeof synthetic.pull_request).toBe(typeof realFixture.pull_request);
		});
	});

	describe('pull_request closed+merged events', () => {
		const realFixture = loadFixture('github-pull-request-closed-merged.json') as Record<
			string,
			unknown
		>;

		const mockMergedPR: GitHubPullRequest = {
			number: 42,
			title: 'Add new feature',
			body: 'This PR adds a new feature.',
			state: 'closed',
			html_url: 'https://github.com/owner/repo/pull/42',
			head: { ref: 'feature/new-feature', sha: 'xyz789' },
			base: { ref: 'main' },
			user: { login: 'pr-author' },
			merged: true,
			merged_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
		};

		const synthetic = buildSyntheticMergedPRPayload(mockMergedPR, 'owner/repo');

		it('synthetic has all required paths that adapters/triggers read', () => {
			const syntheticPaths = extractPaths(synthetic);
			const missing = REQUIRED_PATHS.prMerged.filter((p) => !syntheticPaths.has(p));
			expect(missing, `Synthetic pr_merged missing required paths: ${missing.join(', ')}`).toEqual(
				[],
			);
		});

		it('real fixture has all required paths (validates fixture correctness)', () => {
			const realPaths = extractPaths(realFixture);
			const missing = REQUIRED_PATHS.prMerged.filter((p) => !realPaths.has(p));
			expect(missing, `Real fixture missing required paths: ${missing.join(', ')}`).toEqual([]);
		});

		it('reports paths in real fixture but missing in synthetic (informational)', () => {
			const realPaths = extractPaths(realFixture);
			const syntheticPaths = extractPaths(synthetic);
			const extraInReal = [...realPaths].filter((p) => !syntheticPaths.has(p));
			if (extraInReal.length > 0) {
				console.log(
					'pr_merged: Paths in real fixture but not in synthetic:',
					extraInReal.slice(0, 10),
				);
			}
		});

		it('matches key structural values', () => {
			expect(synthetic.action).toBe(realFixture.action);
			// Verify number field exists and is the expected type
			expect(typeof synthetic.number).toBe('number');
			expect(typeof (realFixture as { number: number }).number).toBe('number');
		});
	});

	describe('Jira status-changed events', () => {
		const realFixture = loadFixture('jira-issue-updated-status-change.json') as Record<
			string,
			unknown
		>;

		const mockIssue: JiraIssue = {
			id: '10000',
			key: 'PROJ-123',
			fields: {
				summary: 'Test Issue',
				status: { id: '10002', name: 'In Progress' },
				project: { key: 'PROJ' },
				labels: ['feature'],
				components: [{ name: 'Backend' }],
				updated: new Date().toISOString(),
			},
		};

		const mockHistory: JiraChangelogHistory = {
			id: '10001',
			created: new Date().toISOString(),
			author: { accountId: 'user-123' },
			items: [
				{
					field: 'status',
					from: '10001',
					to: '10002',
					fromString: 'To Do',
					toString: 'In Progress',
				},
			],
		};

		const mockStatusChange: JiraChangelogItem = mockHistory.items[0];

		const synthetic = buildSyntheticJiraStatusChangedPayload(
			mockIssue,
			mockHistory,
			mockStatusChange,
		);

		it('synthetic has all required paths that adapters/triggers read', () => {
			const syntheticPaths = extractPaths(synthetic);
			const missing = REQUIRED_PATHS.jiraStatusChanged.filter((p) => !syntheticPaths.has(p));
			expect(
				missing,
				`Synthetic jira_status_changed missing required paths: ${missing.join(', ')}`,
			).toEqual([]);
		});

		it('real fixture has all required paths (validates fixture correctness)', () => {
			const realPaths = extractPaths(realFixture);
			const missing = REQUIRED_PATHS.jiraStatusChanged.filter((p) => !realPaths.has(p));
			expect(missing, `Real fixture missing required paths: ${missing.join(', ')}`).toEqual([]);
		});

		it('reports paths in real fixture but missing in synthetic (informational)', () => {
			const realPaths = extractPaths(realFixture);
			const syntheticPaths = extractPaths(synthetic);
			const extraInReal = [...realPaths].filter((p) => !syntheticPaths.has(p));
			if (extraInReal.length > 0) {
				console.log(
					'jira_status_changed: Paths in real fixture but not in synthetic:',
					extraInReal.slice(0, 10),
				);
			}
		});

		it('matches key structural values', () => {
			expect(synthetic.webhookEvent).toBe(realFixture.webhookEvent);
			expect(typeof synthetic.issue).toBe(typeof realFixture.issue);
			expect(typeof synthetic.changelog).toBe(typeof realFixture.changelog);
		});

		it('synthetic has _deliveryId for actionId generation', () => {
			expect(synthetic._deliveryId).toBeDefined();
			expect(typeof synthetic._deliveryId).toBe('string');
		});
	});
});
