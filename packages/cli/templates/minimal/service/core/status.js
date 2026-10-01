/**
 * Placeholder domain logic (pure: no I/O, no DOM). Replace with your product's core.
 */

/** Longest greeting the status resource returns. */
export const MAX_GREETING = 80;

/**
 * The status of the placeholder element for one website.
 * @param {{ websiteId: string, config: { greeting?: unknown } }} input
 * @returns {{ websiteId: string, ok: true, greeting: string }}
 */
export const statusOf = ({ websiteId, config }) => ({
	websiteId,
	ok: true,
	greeting: typeof config.greeting === 'string' && config.greeting.length > 0 ? config.greeting.slice(0, MAX_GREETING) : 'Hello',
});
