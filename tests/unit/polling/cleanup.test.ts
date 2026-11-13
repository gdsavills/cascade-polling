import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock pollingConfig before imports
vi.mock('../../../src/polling/config.js', () => ({
	pollingConfig: {
		dedupRetentionDays: 7,
	},
}));

// Mock DB before imports
const mockDelete = vi.fn();
const mockWhere = vi.fn();

vi.mock('../../../src/db/client.js', () => ({
	getDb: vi.fn(() => ({
		delete: mockDelete,
	})),
}));

// Mock drizzle-orm
vi.mock('drizzle-orm', () => ({
	lt: vi.fn((column, value) => ({ column, value, op: 'lt' })),
}));

// Mock logger
const mockLoggerInfo = vi.fn();
const mockLoggerError = vi.fn();

vi.mock('../../../src/utils/logging.js', () => ({
	logger: {
		info: (...args: unknown[]) => mockLoggerInfo(...args),
		error: (...args: unknown[]) => mockLoggerError(...args),
	},
}));

import { lt } from 'drizzle-orm';
import { cleanupPollingLedger } from '../../../src/polling/cleanup.js';
import { pollingConfig } from '../../../src/polling/config.js';

describe('cleanupPollingLedger', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockDelete.mockReturnValue({ where: mockWhere });
		mockWhere.mockResolvedValue({ rowCount: 0 });
	});

	describe('retention period', () => {
		it('deletes records older than retention period', async () => {
			mockWhere.mockResolvedValueOnce({ rowCount: 10 });

			const result = await cleanupPollingLedger();

			expect(result).toBe(10);
			expect(mockDelete).toHaveBeenCalled();
			expect(mockWhere).toHaveBeenCalled();
		});

		it('uses pollingConfig.dedupRetentionDays for cutoff calculation', async () => {
			const now = Date.now();
			vi.spyOn(Date, 'now').mockReturnValue(now);

			await cleanupPollingLedger();

			expect(lt).toHaveBeenCalled();
			const ltCall = vi.mocked(lt).mock.calls[0];
			const cutoffDate = ltCall[1] as Date;

			// Should be 7 days ago (dedupRetentionDays = 7)
			const expectedCutoff = now - pollingConfig.dedupRetentionDays * 24 * 60 * 60 * 1000;
			expect(cutoffDate.getTime()).toBe(expectedCutoff);
		});

		it('logs cleanup start with retention days and cutoff date', async () => {
			await cleanupPollingLedger();

			expect(mockLoggerInfo).toHaveBeenCalledWith(
				'Starting polling ledger cleanup',
				expect.objectContaining({
					retentionDays: 7,
					cutoffDate: expect.any(String),
				}),
			);
		});
	});

	describe('preserves recent records', () => {
		it('only deletes records with processedAt before cutoff', async () => {
			mockWhere.mockResolvedValueOnce({ rowCount: 5 });

			const result = await cleanupPollingLedger();

			// The lt() call ensures only records BEFORE cutoff are deleted
			expect(lt).toHaveBeenCalled();
			expect(result).toBe(5);
		});

		it('returns 0 when no old records exist', async () => {
			mockWhere.mockResolvedValueOnce({ rowCount: 0 });

			const result = await cleanupPollingLedger();

			expect(result).toBe(0);
		});
	});

	describe('logging', () => {
		it('logs completion with rows deleted count', async () => {
			mockWhere.mockResolvedValueOnce({ rowCount: 25 });

			await cleanupPollingLedger();

			expect(mockLoggerInfo).toHaveBeenCalledWith(
				'Polling ledger cleanup complete',
				expect.objectContaining({
					rowsDeleted: 25,
					retentionDays: 7,
				}),
			);
		});

		it('logs error on failure', async () => {
			mockWhere.mockRejectedValueOnce(new Error('DB error'));

			await expect(cleanupPollingLedger()).rejects.toThrow('DB error');

			expect(mockLoggerError).toHaveBeenCalledWith(
				'Failed to cleanup polling ledger',
				expect.objectContaining({
					error: 'Error: DB error',
				}),
			);
		});
	});

	describe('edge cases', () => {
		it('handles null rowCount gracefully', async () => {
			mockWhere.mockResolvedValueOnce({ rowCount: null });

			const result = await cleanupPollingLedger();

			expect(result).toBe(0);
		});

		it('handles undefined rowCount gracefully', async () => {
			mockWhere.mockResolvedValueOnce({});

			const result = await cleanupPollingLedger();

			expect(result).toBe(0);
		});
	});
});
