import { beforeEach, describe, expect, it, vi } from 'vitest';

// Create mock functions that can be configured per test
const mockFindFirst = vi.fn().mockResolvedValue(undefined);
const mockFindMany = vi.fn().mockResolvedValue([]);
const mockOnConflictDoNothing = vi.fn().mockResolvedValue({ rowCount: 1 });
const mockValues = vi.fn().mockReturnValue({ onConflictDoNothing: mockOnConflictDoNothing });
const mockInsert = vi.fn().mockReturnValue({ values: mockValues });

// Mock dependencies before imports
vi.mock('../../../src/db/client.js', () => ({
	getDb: vi.fn(() => ({
		query: {
			pollingProcessedEvents: {
				findFirst: mockFindFirst,
				findMany: mockFindMany,
			},
		},
		insert: mockInsert,
	})),
}));

vi.mock('../../../src/router/webhook-processor.js', () => ({
	processRouterWebhook: vi.fn(),
}));

vi.mock('../../../src/utils/logging.js', () => ({
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
} from '../../../src/polling/dispatch.js';
import type { RouterPlatformAdapter } from '../../../src/router/platform-adapter.js';
import { processRouterWebhook } from '../../../src/router/webhook-processor.js';
import type { TriggerRegistry } from '../../../src/triggers/registry.js';

const mockAdapter = {
	type: 'github',
	parseWebhook: vi.fn(),
	isProcessableEvent: vi.fn(),
	isSelfAuthored: vi.fn(),
	sendReaction: vi.fn(),
	resolveProject: vi.fn(),
	dispatchWithCredentials: vi.fn(),
	postAck: vi.fn(),
	buildJob: vi.fn(),
} as unknown as RouterPlatformAdapter;

const mockTriggerRegistry = {
	dispatch: vi.fn(),
} as unknown as TriggerRegistry;

describe('dispatchAndRecord', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Reset mocks to default behavior
		mockFindFirst.mockResolvedValue(undefined);
		mockFindMany.mockResolvedValue([]);
	});

	it('returns skipped:true when event already exists in ledger', async () => {
		mockFindFirst.mockResolvedValueOnce({
			id: 'existing',
			projectId: 'p1',
			provider: 'github',
			eventType: 'check_suite',
			dedupKey: 'key1',
			processedAt: new Date(),
		});

		const result = await dispatchAndRecord(
			'p1',
			'github',
			'check_suite',
			'key1',
			{ _eventType: 'check_suite' },
			mockAdapter,
			mockTriggerRegistry,
		);

		expect(result.recorded).toBe(false);
		expect(result.skipped).toBe(true);
		expect(result.deferred).toBe(false);
		expect(result.enqueued).toBe(false);
		expect(processRouterWebhook).not.toHaveBeenCalled();
	});

	it('returns deferred:true and recorded:false when router returns deferred', async () => {
		vi.mocked(processRouterWebhook).mockResolvedValueOnce({
			shouldProcess: true,
			projectId: 'p1',
			deferred: true,
			decisionReason: 'Deferred for re-check',
		});

		const result = await dispatchAndRecord(
			'p1',
			'github',
			'check_suite',
			'new-key',
			{ _eventType: 'check_suite' },
			mockAdapter,
			mockTriggerRegistry,
		);

		expect(result.deferred).toBe(true);
		expect(result.recorded).toBe(false);
		expect(result.skipped).toBe(false);
	});

	it('records to ledger when dispatch succeeds with shouldProcess:true', async () => {
		vi.mocked(processRouterWebhook).mockResolvedValueOnce({
			shouldProcess: true,
			projectId: 'p1',
			decisionReason: 'Job queued',
		});

		const result = await dispatchAndRecord(
			'p1',
			'github',
			'check_suite',
			'success-key',
			{ _eventType: 'check_suite' },
			mockAdapter,
			mockTriggerRegistry,
		);

		expect(result.recorded).toBe(true);
		expect(result.deferred).toBe(false);
		expect(result.enqueued).toBe(true);
		expect(result.skipped).toBe(false);
	});

	it('records to ledger and returns skipped:true when skipReason is present', async () => {
		vi.mocked(processRouterWebhook).mockResolvedValueOnce({
			shouldProcess: true,
			projectId: 'p1',
			decisionReason: 'Trigger skipped',
			skipReason: { handler: 'check-suite-failure', message: 'Not all checks complete' },
		});

		const result = await dispatchAndRecord(
			'p1',
			'github',
			'check_suite',
			'skip-key',
			{ _eventType: 'check_suite' },
			mockAdapter,
			mockTriggerRegistry,
		);

		expect(result.recorded).toBe(true);
		expect(result.skipped).toBe(true);
		expect(result.enqueued).toBe(false);
	});

	it('returns error and recorded:false when dispatch throws', async () => {
		vi.mocked(processRouterWebhook).mockRejectedValueOnce(new Error('Dispatch failed'));

		const result = await dispatchAndRecord(
			'p1',
			'github',
			'check_suite',
			'error-key',
			{ _eventType: 'check_suite' },
			mockAdapter,
			mockTriggerRegistry,
		);

		expect(result.recorded).toBe(false);
		expect(result.error).toBeDefined();
		expect(result.error?.message).toBe('Dispatch failed');
	});
});

describe('recordWithoutDispatch', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('records event to ledger without dispatching', async () => {
		const result = await recordWithoutDispatch('p1', 'github', 'ignored', 'ignored-key');

		expect(result).toBe(true);
		expect(processRouterWebhook).not.toHaveBeenCalled();
	});
});

describe('batchCheckLedger', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns empty set for empty input', async () => {
		const result = await batchCheckLedger('p1', 'github', []);

		expect(result.size).toBe(0);
	});

	it('returns set of existing dedup keys', async () => {
		mockFindMany.mockResolvedValueOnce([{ dedupKey: 'key1' }, { dedupKey: 'key3' }]);

		const result = await batchCheckLedger('p1', 'github', ['key1', 'key2', 'key3']);

		expect(result.has('key1')).toBe(true);
		expect(result.has('key2')).toBe(false);
		expect(result.has('key3')).toBe(true);
	});
});
