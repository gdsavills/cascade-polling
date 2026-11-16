import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
	createSubscription,
	deleteSubscription,
	getSubscriptionProjectId,
	listSubscriptions,
	setSubscriptionEnabled,
} from '../../db/repositories/subscriptionsRepository.js';
import { protectedProcedure, router } from '../trpc.js';
import { verifyProjectOrgAccess } from './_shared/projectAccess.js';

/**
 * drizzle wraps the pg error, so `code`/`constraint` sit on `.cause`; walk the
 * chain like `rethrowRepoPrimaryConflict` in projects.ts does.
 */
function isDuplicateNameError(err: unknown): boolean {
	let current: unknown = err;
	for (let depth = 0; depth < 5 && current != null; depth++) {
		const c = current as { code?: unknown; constraint?: unknown };
		if (c.code === '23505' && c.constraint === 'uq_project_subscriptions_project_name') {
			return true;
		}
		current = (current as { cause?: unknown }).cause;
	}
	return false;
}

async function authorizeSubscription(id: number, orgId: string): Promise<void> {
	const projectId = await getSubscriptionProjectId(id);
	if (!projectId) throw new TRPCError({ code: 'NOT_FOUND' });
	await verifyProjectOrgAccess(projectId, orgId);
}

export const subscriptionsRouter = router({
	list: protectedProcedure
		.input(z.object({ projectId: z.string() }))
		.query(async ({ ctx, input }) => {
			await verifyProjectOrgAccess(input.projectId, ctx.effectiveOrgId);
			// The token is never returned.
			return (await listSubscriptions(input.projectId)).map((s) => ({
				id: s.id,
				name: s.name,
				enabled: s.enabled,
				fiveHourPct: s.fiveHourPct,
				fiveHourResetAt: s.fiveHourResetAt?.toISOString() ?? null,
				sevenDayPct: s.sevenDayPct,
				sevenDayResetAt: s.sevenDayResetAt?.toISOString() ?? null,
			}));
		}),

	create: protectedProcedure
		.input(
			z.object({
				projectId: z.string(),
				name: z.string().trim().min(1).max(50),
				token: z.string().trim().min(1),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			await verifyProjectOrgAccess(input.projectId, ctx.effectiveOrgId);
			try {
				return { id: await createSubscription(input.projectId, input.name, input.token) };
			} catch (err) {
				if (isDuplicateNameError(err)) {
					throw new TRPCError({
						code: 'CONFLICT',
						message: `A subscription named "${input.name}" already exists in this project.`,
					});
				}
				throw err;
			}
		}),

	setEnabled: protectedProcedure
		.input(z.object({ id: z.number().int(), enabled: z.boolean() }))
		.mutation(async ({ ctx, input }) => {
			await authorizeSubscription(input.id, ctx.effectiveOrgId);
			await setSubscriptionEnabled(input.id, input.enabled);
		}),

	delete: protectedProcedure
		.input(z.object({ id: z.number().int() }))
		.mutation(async ({ ctx, input }) => {
			await authorizeSubscription(input.id, ctx.effectiveOrgId);
			await deleteSubscription(input.id);
		}),
});
