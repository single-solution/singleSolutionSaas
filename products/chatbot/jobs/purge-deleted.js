/**
 * Retention of soft-deleted records: FAQ entries and agents removed through the API are kept (DELETE is soft, Part E
 * §5) for `transcripts.deleted_retention_days`, then hard-deleted by the scheduled maintenance job. Conversations and
 * messages need no job: their `retainUntil` TTL index removes them.
 */
import { DAY_MS } from '../core/time.js';

/**
 * @param {{ repos: { entries: { purgeDeleted: (before: string) => Promise<number> }, agents: { purgeDeleted: (before: string) => Promise<number> } },
 *   days: number, now: () => number }} input
 * @returns {Promise<{ entries: number, agents: number }>}
 */
export const purgeDeleted = async ({ repos, days, now }) => {
	const before = new Date(now() - Math.max(1, days) * DAY_MS).toISOString();
	return { entries: await repos.entries.purgeDeleted(before), agents: await repos.agents.purgeDeleted(before) };
};
