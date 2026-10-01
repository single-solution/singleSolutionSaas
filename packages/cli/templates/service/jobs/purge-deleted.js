/**
 * Scheduled job: hard-delete soft-deleted notes after the retention window. Wire it to a signed cron route when needed
 * (vercel.json ships with no crons by default).
 */

/** Retention of soft-deleted notes before they are purged. */
export const PURGE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * @param {{ repos: Iterable<{ purgeDeleted: (before: string) => Promise<number> }>, now?: () => number, afterMs?: number }} input
 * @returns {Promise<number>} notes purged
 */
export const purgeDeletedNotes = async ({ repos, now = Date.now, afterMs = PURGE_AFTER_MS }) => {
	const before = new Date(now() - afterMs).toISOString();
	let purged = 0;
	for (const repo of repos) purged += await repo.purgeDeleted(before);
	return purged;
};
