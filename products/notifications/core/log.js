/**
 * The delivery log's filters (PLAN 0.8.5; counts, PLAN 0.8.10 K4): the list `GET /v1/messages`, its counts and the
 * delivery-log widget read the same filters, so a count always matches the list. No I/O.
 * @module
 */
import { CHANNELS, normaliseEmail, normalisePhone } from './channels.js';

/** @typedef {'queued' | 'retrying' | 'sent' | 'failed' | 'skipped'} MessageStatus */

/** Every status of a message, in the order screens list them. */
export const STATUSES = Object.freeze(/** @type {MessageStatus[]} */ (['queued', 'retrying', 'sent', 'failed', 'skipped']));

/**
 * @typedef {object} LogFilters
 * @property {MessageStatus} [status]
 * @property {import('./channels.js').Channel} [channel]
 * @property {string} [address] the recipient's address on the message's channel (e-mail and phones normalised)
 */

/**
 * The filters of a delivery-log request (`?status=&channel=&to=`). An unknown status or channel is ignored, as is an
 * empty `to`; any other `to` is matched as normalised (an e-mail address or a phone), else as written.
 * @param {Record<string, unknown>} query
 * @returns {LogFilters}
 */
export const logFilters = (query) => {
	/** @type {LogFilters} */
	const filters = {};
	if (STATUSES.includes(/** @type {MessageStatus} */ (query.status)))
		filters.status = /** @type {MessageStatus} */ (query.status);
	if (CHANNELS.includes(/** @type {import('./channels.js').Channel} */ (query.channel)))
		filters.channel = /** @type {import('./channels.js').Channel} */ (query.channel);
	if (typeof query.to === 'string' && query.to !== '')
		filters.address = normaliseEmail(query.to) ?? normalisePhone(query.to) ?? query.to;
	return filters;
};
