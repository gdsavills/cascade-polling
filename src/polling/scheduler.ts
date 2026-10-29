/**
 * Polling scheduler.
 *
 * Uses BullMQ Job Scheduler to run polling cycles at regular intervals.
 * Worker concurrency is 1 to ensure sequential processing.
 */

import { Octokit } from '@octokit/rest';
import { type ConnectionOptions, Queue, Worker } from 'bullmq';
import { getProjectGitHubToken } from '../config/projects.js';
import { loadProjectConfig } from '../router/config.js';
import { captureException } from '../sentry.js';
import { registerBuiltInTriggers } from '../triggers/builtins.js';
import { createTriggerRegistry, type TriggerRegistry } from '../triggers/registry.js';
import type { ProjectConfig } from '../types/index.js';
import { logger } from '../utils/logging.js';
import { parseRedisUrl } from '../utils/redis.js';
import { getPollingAdapter } from './adapter.js';
import { handleGitHubRepoColdStart } from './cold-start.js';
import { pollingConfig } from './config.js';
import { pollCheckSuitesForRepo } from './providers/github/check-suite-poller.js';
import { pollMergedPRsForRepo } from './providers/github/merged-pr-poller.js';
import { pollPRReviewsForRepo } from './providers/github/pr-review-poller.js';

const QUEUE_NAME = 'polling:scheduler';
const JOB_NAME = 'poll-cycle';

let queue: Queue | null = null;
let worker: Worker | null = null;
let connection: ConnectionOptions | null = null;

/**
 * Initialize the polling scheduler.
 */
export async function startPollingScheduler(): Promise<void> {
	if (!pollingConfig.enabled) {
		logger.info('Polling is disabled, scheduler not started');
		return;
	}

	const redisUrl = process.env.REDIS_URL;
	if (!redisUrl) {
		logger.error('REDIS_URL not set, cannot start polling scheduler');
		return;
	}

	logger.info('Starting polling scheduler', {
		intervalMs: pollingConfig.intervalMs,
	});

	// Create Redis connection options using shared utility
	connection = parseRedisUrl(redisUrl);

	// Create queue
	queue = new Queue(QUEUE_NAME, {
		connection,
	});

	// Create trigger registry for dispatch
	const triggerRegistry = createTriggerRegistry();
	registerBuiltInTriggers(triggerRegistry);

	// Create worker with concurrency 1
	worker = new Worker(
		QUEUE_NAME,
		async () => {
			await runPollCycle(triggerRegistry);
		},
		{
			connection,
			concurrency: 1,
		},
	);

	worker.on('failed', (job, err) => {
		logger.error('Poll cycle job failed', {
			jobId: job?.id,
			error: String(err),
		});
		captureException(err, {
			tags: { source: 'polling_scheduler' },
			extra: { jobId: job?.id },
		});
	});

	worker.on('error', (err) => {
		logger.error('Polling worker error', { error: String(err) });
		captureException(err, { tags: { source: 'polling_worker' } });
	});

	// Schedule repeating job
	await queue.upsertJobScheduler(
		'poll-scheduler',
		{
			every: pollingConfig.intervalMs,
		},
		{
			name: JOB_NAME,
			data: {},
			opts: {
				removeOnComplete: 100,
				removeOnFail: 100,
			},
		},
	);

	logger.info('Polling scheduler started');
}

/**
 * Stop the polling scheduler.
 */
export async function stopPollingScheduler(): Promise<void> {
	if (worker) {
		await worker.close();
		worker = null;
	}

	if (queue) {
		await queue.close();
		queue = null;
	}

	connection = null;

	logger.info('Polling scheduler stopped');
}

/**
 * Run a single poll cycle for all projects.
 */
async function runPollCycle(triggerRegistry: TriggerRegistry): Promise<void> {
	const startTime = Date.now();
	logger.debug('Starting poll cycle');

	const { fullProjects } = await loadProjectConfig();
	if (fullProjects.length === 0) {
		logger.debug('No projects configured, skipping poll cycle');
		return;
	}

	const adapter = getPollingAdapter('github');
	let totalEmitted = 0;
	let totalErrors = 0;

	for (const project of fullProjects) {
		try {
			const stats = await pollProject(project, adapter, triggerRegistry);
			totalEmitted += stats.emitted;
			totalErrors += stats.errors;
		} catch (error) {
			totalErrors++;
			logger.error('Failed to poll project', {
				projectId: project.id,
				error: String(error),
			});
			captureException(error instanceof Error ? error : new Error(String(error)), {
				tags: { source: 'polling_cycle', projectId: project.id },
			});
		}
	}

	const durationMs = Date.now() - startTime;
	logger.info('Poll cycle complete', {
		projectCount: fullProjects.length,
		totalEmitted,
		totalErrors,
		durationMs,
	});
}

/**
 * Poll a single project.
 */
async function pollProject(
	project: ProjectConfig,
	adapter: ReturnType<typeof getPollingAdapter>,
	triggerRegistry: TriggerRegistry,
): Promise<{ emitted: number; errors: number }> {
	const stats = { emitted: 0, errors: 0 };

	// Get GitHub token
	let githubToken: string;
	try {
		githubToken = await getProjectGitHubToken(project);
	} catch {
		logger.warn('No GitHub token for project, skipping', { projectId: project.id });
		return stats;
	}

	const octokit = new Octokit({ auth: githubToken });

	// Get repo from project config
	const repo = project.repo;
	if (!repo) {
		logger.warn('No repo configured for project, skipping', { projectId: project.id });
		return stats;
	}

	const [owner, repoName] = repo.split('/');
	if (!owner || !repoName) {
		logger.warn('Invalid repo format', { projectId: project.id, repo });
		return stats;
	}

	// Handle cold start
	await handleGitHubRepoColdStart(project.id, owner, repoName, octokit);

	// Poll check suites
	const checkSuiteResult = await pollCheckSuitesForRepo(
		project.id,
		owner,
		repoName,
		octokit,
		adapter,
		triggerRegistry,
	);
	stats.emitted += checkSuiteResult.emitted;
	stats.errors += checkSuiteResult.errors;

	// Poll PR reviews
	const prReviewResult = await pollPRReviewsForRepo(
		project.id,
		owner,
		repoName,
		octokit,
		adapter,
		triggerRegistry,
	);
	stats.emitted += prReviewResult.emitted;
	stats.errors += prReviewResult.errors;

	// Poll merged PRs
	const mergedPRResult = await pollMergedPRsForRepo(
		project.id,
		owner,
		repoName,
		octokit,
		adapter,
		triggerRegistry,
	);
	stats.emitted += mergedPRResult.emitted;
	stats.errors += mergedPRResult.errors;

	return stats;
}
