/**
 * Blocklist service: block or unblock a customer by customer id, identity subject, e-mail or phone. Keys are stored
 * hashed (the masked label is all the dashboard shows), so the blocklist never holds contact details in clear.
 */
import { customerKeys } from '../core/orders.js';
import { cleanText, isId, normalizeEmail, normalizePhone } from '../core/text.js';
import { fail, invalid } from './context.js';

/** Blocklist entry types. */
export const ENTRY_TYPES = Object.freeze(/** @type {const} */ (['customer', 'subject', 'email', 'phone']));

/**
 * A label that identifies an entry to staff without spelling out the contact.
 * @param {string} type
 * @param {string} value normalised
 */
export const maskOf = (type, value) => {
	if (type === 'email') {
		const [local = '', domain = ''] = value.split('@');
		return `${local.slice(0, 1)}***@${domain}`;
	}
	if (type === 'phone') return `***${value.replace(/\D/g, '').slice(-3)}`;
	return value;
};

/**
 * @param {import('./context.js').Deps} deps
 */
export const createBlocklist = (deps) => {
	/**
	 * @param {import('./context.js').Site} site
	 * @param {unknown} body `{ type, value }`
	 * @returns {{ ok: true, key: string, display: string, type: string, customerId: string | null } | import('./context.js').Failure}
	 */
	const keyOf = (site, body) => {
		const input = /** @type {any} */ (body ?? {});
		const type = input.type;
		if (!ENTRY_TYPES.includes(type)) return invalid([{ path: '/type', code: 'type_invalid' }]);
		const value =
			type === 'email'
				? normalizeEmail(input.value)
				: type === 'phone'
					? normalizePhone(input.value)
					: isId(input.value) || (type === 'subject' && cleanText(input.value, 255))
						? String(input.value)
						: null;
		if (!value) return invalid([{ path: '/value', code: 'value_invalid' }]);
		const raw = customerKeys(
			{
				customerId: type === 'customer' ? value : null,
				subject: type === 'subject' ? value : null,
				email: type === 'email' ? value : null,
				phone: type === 'phone' ? value : null,
			},
			site.settings.risk.phone_match_digits,
		)[0];
		return {
			ok: true,
			key: deps.hashKey(site.websiteId, /** @type {string} */ (raw)),
			display: maskOf(type, value),
			type,
			customerId: type === 'customer' ? value : null,
		};
	};

	/**
	 * @param {import('./context.js').Site} site
	 * @param {unknown} body `{ type, value, reason? }`
	 * @param {import('./context.js').Actor} actor
	 */
	const block = async (site, body, actor) => {
		const resolved = keyOf(site, body);
		if (!resolved.ok) return resolved;
		const reason = cleanText(/** @type {any} */ (body)?.reason, 500);
		if ((await site.repos.profiles.countBlocked()) >= site.settings.risk.max_blocklist)
			return fail('limit_reached', 'The blocklist is full (risk.max_blocklist).');
		const profile = await site.repos.profiles.set(resolved.key, {
			blocked: true,
			type: resolved.type,
			display: resolved.display,
			reason,
			customerId: resolved.customerId,
			blockedAt: new Date(deps.now()),
		});
		await deps
			.audit({ websiteId: site.websiteId, actor, action: 'risk.blocked', target: { key: resolved.key } })
			.catch(() => undefined);
		return { ok: true, entry: entryView(profile) };
	};

	/**
	 * @param {import('./context.js').Site} site
	 * @param {string} key stored key
	 * @param {import('./context.js').Actor} actor
	 */
	const unblock = async (site, key, actor) => {
		if (!/^[csep]:[0-9a-f]{40}$/.test(key)) return fail('not_found', 'No such entry.');
		const [existing] = await site.repos.profiles.byKeys([key]);
		if (!existing?.blocked) return fail('not_found', 'No such entry.');
		await site.repos.profiles.set(key, { blocked: false, unblockedAt: new Date(deps.now()) });
		await deps.audit({ websiteId: site.websiteId, actor, action: 'risk.unblocked', target: { key } }).catch(() => undefined);
		return { ok: true };
	};

	return Object.freeze({ block, unblock, keyOf });
};

/**
 * @param {Record<string, any>} profile
 */
export const entryView = (profile) => ({
	key: profile.key,
	type: profile.type ?? null,
	display: profile.display ?? null,
	reason: profile.reason ?? null,
	blocked: profile.blocked === true,
	rtoCount: profile.rtoCount ?? 0,
	blockedAt: profile.blockedAt ? new Date(profile.blockedAt).toISOString() : null,
});

/** @typedef {ReturnType<typeof createBlocklist>} Blocklist */
