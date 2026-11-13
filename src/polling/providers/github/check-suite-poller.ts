/**
 * GitHub check-suite poller.
 *
 * Polls the GitHub Actions API for completed workflow runs within a fixed
 * lookback window, filters by conclusion, resolves PR numbers, and dispatches
 * synthetic check_suite events through the router.
 *
 * Per FINAL-PLAN-v2 corrections:
 * 1. Apply conclusion filter FIRST (before any API call)
 * 2. Batch ledger lookup SECOND
 * 3. PR resolution THIRD (only for new, emittable runs)
 * 4. Record 'ignored' for skipped conclusions and unresolvable PRs
 */

import type { Octokit } from '@octokit/rest';
import type { RouterPlatformAdapter } from '../../../router/platform-adapter.js';
import {
	type CheckSuitePRResolution,
	resolveCheckSuitePRNumber,
} from '../../../triggers/github/pr-resolution.js';
import type { TriggerRegistry } from '../../../triggers/registry.js';
import { logger } from '../../../utils/logging.js';
import { pollingConfig } from '../../config.js';
import {
	batchCheckLedger,
	dispatchAndRecord,
	type PollingEventType,
	recordWithoutDispatch,
} from '../../dispatch.js';
import {
	buildCheckSuiteDedupKey,
	buildSyntheticCheckSuitePayload,
	type GitHubWorkflowRun,
	type GitHubWorkflowRunsResponse,
	shouldEmitWorkflowRun,
} from './types.js';

/** Maximum pagination pages for workflow runs (safety limit). */
const MAX_PAGINATION_PAGES = 10;

/** Result of a check-suite poll cycle for a single repo. */
export interface CheckSuitePollResult {
	total: number;
	emitted: number;
	skipped: number;
	errors: number;
	ignored: number;
}

/**
 * Poll workflow runs for a single repository.
 */
export async function pollCheckSuitesForRepo(
	projectId: string,
	owner: string,
	repo: string,
	octokit: Octokit,
	adapter: RouterPlatformAdapter,
	triggerRegistry: TriggerRegistry,
): Promise<CheckSuitePollResult> {
	const repoFullName = `${owner}/${repo}`;
	const result: CheckSuitePollResult = {
		total: 0,
		emitted: 0,
		skipped: 0,
		errors: 0,
		ignored: 0,
	};

	// Step 1: Fetch completed workflow runs within the lookback window
	const lookbackMs = pollingConfig.githubLookbackMs;
	const createdAfter = new Date(Date.now() - lookbackMs).toISOString();

	const runs: GitHubWorkflowRun[] = [];
	let page = 1;
	const perPage = 100;

	try {
		while (page <= MAX_PAGINATION_PAGES) {
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

			if (page > MAX_PAGINATION_PAGES) {
				logger.warn('Workflow runs pagination limit reached', {
					owner,
					repo,
					totalFetched: runs.length,
					maxPages: MAX_PAGINATION_PAGES,
				});
			}
		}
	} catch (error) {
		logger.error('Failed to fetch workflow runs', {
			owner,
			repo,
			error: String(error),
		});
		return result;
	}

	result.total = runs.length;

	if (runs.length === 0) {
		return result;
	}

	// Step 2: Apply conclusion filter FIRST (before any API call or ledger check)
	const candidates: Array<{
		run: GitHubWorkflowRun;
		conclusion: 'success' | 'failure';
		dedupKey: string;
	}> = [];

	const toIgnore: Array<{
		run: GitHubWorkflowRun;
		reason: string;
	}> = [];

	for (const run of runs) {
		const emitResult = shouldEmitWorkflowRun(run);
		if (emitResult.emit) {
			const dedupKey = buildCheckSuiteDedupKey(owner, repo, run, emitResult.conclusion);
			candidates.push({ run, conclusion: emitResult.conclusion, dedupKey });
		} else {
			toIgnore.push({ run, reason: emitResult.reason });
		}
	}

	// Step 3: Batch ledger lookup SECOND
	const dedupKeys = candidates.map((c) => c.dedupKey);
	const existingKeys = await batchCheckLedger(projectId, 'github', dedupKeys);

	const newCandidates = candidates.filter((c) => !existingKeys.has(c.dedupKey));

	logger.debug('Workflow runs ledger check', {
		repoFullName,
		total: runs.length,
		emittable: candidates.length,
		existing: existingKeys.size,
		new: newCandidates.length,
		ignored: toIgnore.length,
	});

	result.skipped = existingKeys.size;

	// Step 4: Record ignored runs in ledger (so we don't re-process them)
	for (const { run, reason } of toIgnore) {
		// Build a dedup key for ignored runs using the original conclusion
		const ignoredDedupKey = `github:${repoFullName}:ignored:${run.id}:${reason}`;
		const recorded = await recordWithoutDispatch(projectId, 'github', 'ignored', ignoredDedupKey);
		if (recorded) {
			result.ignored++;
		}
	}

	// Step 5: PR resolution THIRD (only for new, emittable runs)
	for (const { run, conclusion, dedupKey } of newCandidates) {
		// Resolve PR number using existing logic
		let resolution: CheckSuitePRResolution | undefined;
		let hadTransientError = false;
		try {
			resolution = await resolveCheckSuitePRNumber({
				owner,
				repo,
				pullRequests: run.pull_requests ?? [],
				headBranch: run.head_branch ?? undefined,
				handlerName: 'polling:check-suite',
				lookupOpenPRByBranch: async (o, r, b) => {
					// This throws on transient errors so we can distinguish from "no PR found"
					const response = await octokit.pulls.list({
						owner: o,
						repo: r,
						head: `${o}:${b}`,
						state: 'open',
						per_page: 1,
					});
					if (response.data.length === 0) return null;
					return {
						number: response.data[0].number,
						htmlUrl: response.data[0].html_url,
						title: response.data[0].title,
					};
				},
			});
		} catch (error) {
			// Transient error (rate limit, network, 5xx) - do NOT record, leave for retry
			hadTransientError = true;
			logger.warn('Transient error during PR resolution, will retry next cycle', {
				runId: run.id,
				repoFullName,
				error: String(error),
			});
		}

		if (hadTransientError) {
			// Do not record - leave unprocessed so next poll cycle retries within lookback window
			continue;
		}

		if (!resolution?.ok) {
			// API succeeded but no PR found - record as ignored so we don't retry every cycle
			const unresolvableDedupKey = `github:${repoFullName}:unresolvable_pr:${run.id}`;
			const recorded = await recordWithoutDispatch(
				projectId,
				'github',
				'ignored',
				unresolvableDedupKey,
			);
			if (recorded) {
				result.ignored++;
			}
			logger.debug('Cannot resolve PR for workflow run, recording as ignored', {
				runId: run.id,
				repoFullName,
			});
			continue;
		}

		// Build and dispatch synthetic event
		const syntheticPayload = buildSyntheticCheckSuitePayload(
			run,
			conclusion,
			repoFullName,
			resolution.prNumber,
		);

		const dispatchResult = await dispatchAndRecord(
			projectId,
			'github',
			'check_suite' as PollingEventType,
			dedupKey,
			syntheticPayload,
			adapter,
			triggerRegistry,
		);

		if (dispatchResult.error) {
			result.errors++;
			logger.error('Failed to dispatch check_suite event', {
				runId: run.id,
				repoFullName,
				error: dispatchResult.error.message,
			});
		} else if (dispatchResult.deferred) {
			// Deferred events will be retried next cycle
			logger.debug('Check suite dispatch deferred', { runId: run.id, repoFullName });
		} else if (dispatchResult.enqueued || dispatchResult.skipped) {
			result.emitted++;
		}
	}

	return result;
}
