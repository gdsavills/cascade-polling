/**
 * Ledger cleanup job for polling.
 *
 * Deletes processed events older than the retention period to prevent
 * unbounded growth of the polling_processed_events table.
 */

import { lt } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { pollingProcessedEvents } from '../db/schema/polling.js';
import { logger } from '../utils/logging.js';
import { pollingConfig } from './config.js';

/**
 * Clean up old processed events from the ledger.
 * Returns the number of rows deleted.
 */
export async function cleanupPollingLedger(): Promise<number> {
	const retentionDays = pollingConfig.dedupRetentionDays;
	const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

	logger.info('Starting polling ledger cleanup', {
		retentionDays,
		cutoffDate: cutoffDate.toISOString(),
	});

	try {
		const db = getDb();
		const result = await db
			.delete(pollingProcessedEvents)
			.where(lt(pollingProcessedEvents.processedAt, cutoffDate));

		const rowsDeleted = result.rowCount ?? 0;

		logger.info('Polling ledger cleanup complete', {
			rowsDeleted,
			retentionDays,
		});

		return rowsDeleted;
	} catch (error) {
		logger.error('Failed to cleanup polling ledger', {
			error: String(error),
		});
		throw error;
	}
}
