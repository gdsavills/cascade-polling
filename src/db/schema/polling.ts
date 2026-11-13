import { index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

import { projects } from './projects.js';

/**
 * Watermarks for incremental polling. Each (project, provider, resource_type,
 * resource_id) tuple tracks the last-seen timestamp so subsequent polls only
 * fetch newer items.
 */
export const pollingWatermarks = pgTable(
	'polling_watermarks',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id, { onDelete: 'cascade' }),
		provider: text('provider').notNull(),
		resourceType: text('resource_type').notNull(),
		resourceId: text('resource_id').notNull().default(''),
		watermark: timestamp('watermark', { withTimezone: true }).notNull(),
		etag: text('etag'),
		updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
	},
	(table) => [
		index('idx_polling_watermarks_project_provider').on(table.projectId, table.provider),
		unique('polling_watermarks_unique').on(
			table.projectId,
			table.provider,
			table.resourceType,
			table.resourceId,
		),
	],
);

/**
 * Processed events ledger for deduplication. Each event is keyed by a dedup_key
 * that uniquely identifies the event (e.g. run ID for workflow runs).
 * event_type can be 'check_suite', 'status_changed', 'pr_review', 'merged_pr',
 * or 'ignored' (for filtered events that should not be re-processed).
 */
export const pollingProcessedEvents = pgTable(
	'polling_processed_events',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id, { onDelete: 'cascade' }),
		provider: text('provider').notNull(),
		eventType: text('event_type').notNull(),
		dedupKey: text('dedup_key').notNull(),
		processedAt: timestamp('processed_at', { withTimezone: true }).defaultNow(),
	},
	(table) => [
		index('idx_polling_processed_events_processed_at').on(table.processedAt),
		unique('polling_processed_events_unique').on(table.projectId, table.provider, table.dedupKey),
	],
);
