import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock cleanup module before any imports
vi.mock('../../../src/polling/cleanup.js', () => ({
	cleanupPollingLedger: vi.fn(),
}));

// Mock logger
vi.mock('../../../src/utils/logging.js', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

// Mock sentry
vi.mock('../../../src/sentry.js', () => ({
	captureException: vi.fn(),
}));

import * as cleanup from '../../../src/polling/cleanup.js';
import { maybeRunLedgerCleanup, resetCleanupState } from '../../../src/polling/scheduler.js';
import { logger } from '../../../src/utils/logging.js';

describe('maybeRunLedgerCleanup', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		resetCleanupState();
		vi.mocked(cleanup.cleanupPollingLedger).mockResolvedValue(100);
	});

	it('runs cleanup on first call', async () => {
		await maybeRunLedgerCleanup();

		expect(cleanup.cleanupPollingLedger).toHaveBeenCalledTimes(1);
		expect(logger.info).toHaveBeenCalledWith('Ledger cleanup completed', { rowsDeleted: 100 });
	});

	it('does not run cleanup again within 24 hours', async () => {
		await maybeRunLedgerCleanup();
		await maybeRunLedgerCleanup();

		expect(cleanup.cleanupPollingLedger).toHaveBeenCalledTimes(1);
	});

	it('handles cleanup errors gracefully', async () => {
		vi.mocked(cleanup.cleanupPollingLedger).mockRejectedValueOnce(
			new Error('DB connection failed'),
		);

		await maybeRunLedgerCleanup();

		expect(logger.error).toHaveBeenCalledWith(
			'Ledger cleanup failed',
			expect.objectContaining({ error: 'Error: DB connection failed' }),
		);
	});

	it('does not set lastCleanupTime when cleanup fails', async () => {
		vi.mocked(cleanup.cleanupPollingLedger).mockRejectedValueOnce(new Error('DB error'));

		await maybeRunLedgerCleanup();
		vi.clearAllMocks();
		vi.mocked(cleanup.cleanupPollingLedger).mockResolvedValue(50);

		// Second call should retry since first failed
		await maybeRunLedgerCleanup();

		expect(cleanup.cleanupPollingLedger).toHaveBeenCalledTimes(1);
		expect(logger.info).toHaveBeenCalledWith('Ledger cleanup completed', { rowsDeleted: 50 });
	});
});
