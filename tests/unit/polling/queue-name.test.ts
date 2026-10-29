/**
 * Regression test for polling queue name.
 *
 * BullMQ rejects queue names containing ":" at runtime with:
 * "Error: Queue name cannot contain :"
 *
 * This test reads the scheduler source to extract the actual QUEUE_NAME
 * constant and verifies it doesn't contain a colon.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('polling queue name validation', () => {
	it('QUEUE_NAME does not contain colon (BullMQ rejects colons)', () => {
		// Read the actual scheduler source to extract QUEUE_NAME
		const schedulerPath = join(__dirname, '../../../src/polling/scheduler.ts');
		const source = readFileSync(schedulerPath, 'utf-8');

		// Extract the QUEUE_NAME constant value
		const match = source.match(/const QUEUE_NAME = ['"]([^'"]+)['"]/);
		expect(match, 'QUEUE_NAME constant not found in scheduler.ts').toBeTruthy();

		const queueName = match![1];

		// BullMQ throws "Queue name cannot contain :" - this is the regression guard
		expect(queueName).not.toContain(':');

		// Should follow repo convention (hyphen-separated lowercase)
		expect(queueName).toBe('polling-scheduler');
	});

	it('matches repo convention for queue names', () => {
		// Read cascade's other queue name for comparison
		const clientPath = join(__dirname, '../../../src/queue/client.ts');
		const source = readFileSync(clientPath, 'utf-8');

		const match = source.match(/const QUEUE_NAME = ['"]([^'"]+)['"]/);
		expect(match, 'QUEUE_NAME not found in queue/client.ts').toBeTruthy();

		const existingQueueName = match![1];

		// Both should use hyphens, not colons
		expect(existingQueueName).not.toContain(':');
		expect(existingQueueName).toMatch(/^[a-z0-9-]+$/);
	});
});
