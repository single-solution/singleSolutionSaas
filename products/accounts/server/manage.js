/**
 * The merchant's side (PLAN 0.8.6): users (list, search, counts, block, roles, notes, invites, approvals and deletion
 * requests) and roles with their permissions, through the merchant's server (server token) and the Users and Roles
 * admin widgets (tickets); the activity-log copies other products send (with their filters and counts); and the custom
 * fields set in the dashboard. Every change made through the server token or a ticket is written to the activity log
 * with the acting user (the ticket's staff member, else the signed-in staff member of a server-token call, else the
 * server; PLAN 0.8.10 K2), the target's label and what changed as values (K9, A8: codes, numbers and yes/no, never a
 * sentence in one language).
 * @module
 */
import { activityFilter, actorOf, countHandlers, paginate, problem } from '@ss/app-kit';
import { createId, validateActivityCopy } from '@ss/contracts';
import { normalizeEmail } from '@ss/contracts/email';
import { nationalNumberOf } from '@ss/contracts/phone';
import { randomToken, sha256Hex } from '@ss/protocol';
import { labelOf, valuesOf } from '../core/activity.js';
import { MAX_CONSENTS, checkConsent } from '../core/consents.js';
import { MAX_CUSTOM_FIELDS, MAX_ROLES, STAFF_CODE_MINUTES } from '../core/limits.js';
import { checkCustomValues, checkFieldDefinition, checkName, checkTags, staffView } from '../core/profile.js';
import { MAX_VIEWS, checkView } from '../core/views.js';
import {
	OWNER_ROLE,
	ROLE_KEY,
	SIGN_UP_NO_PERMISSIONS,
	checkOwnPermissions,
	checkRole,
	grants,
	isSystemRole,
	permissionCatalog,
	roleView,
} from '../core/roles.js';
import { SETUP_TRACE_DAYS, generateCode, returnAddress } from '../core/rules.js';
import { LINK_PARAMS, SETUP_PARAM } from '../core/widgets.js';
import { randomBytes } from '../adapters/crypto.js';
import { manifest } from '../adapters/product.js';
import { createStore } from '../adapters/store.js';
import { STAFF_CODE_LENGTH, invalid } from './flows.js';
import { bodyOf } from './service.js';

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Service} Service */
/** @typedef {import('./flows.js').Flows} Flows */

const PERMISSIONS_TTL_MS = 5 * 60_000;
/** The fewest digits the users list's search by the end of a number takes (A7). */
const MIN_PHONE_END = 4;
/** The users list's statuses (`blocked`: blocked users, whatever their status). */
const USER_STATUSES = Object.freeze(['active', 'pending', 'invited', 'blocked']);
/** A product id, as the activity copies' `productId` filter takes it. */
const PRODUCT_ID = /^[a-z][a-z0-9-]{1,30}$/;
/** A permission as the users list's `permission` filter takes it (`<product>:<key>`, PLAN 0.8.10 A4, K6). */
const PERMISSION_FILTER = /^[a-z][a-z0-9-]{1,30}:[a-z][a-z0-9_.]{0,63}$/;
/** Role requests' statuses (`expired`: invited, and the setup link has expired; judged on read, A5). */
const REQUEST_STATUSES = Object.freeze(['pending', 'invited', 'completed', 'declined', 'expired']);
/** The window of the counter a private repeat ask writes in place of a new request (removed by TTL after it). */
const REPEATS_WINDOW_MS = 3_600_000;

/**
 * A role request as the API answers it, its status judged now (`expired` once an invite's setup link has run out).
 * @param {import('../adapters/store.js').RequestRecord} row @param {number} now
 */
const requestView = (row, now) => ({
	id: row.id,
	role: row.role,
	name: row.name,
	phone: row.phone,
	email: row.email,
	note: row.note,
	status: row.status === 'invited' && row.setupExpiresAt && row.setupExpiresAt.getTime() <= now ? 'expired' : row.status,
	userId: row.userId,
	invitedBy: row.invitedBy,
	invitedAt: row.invitedAt?.toISOString() ?? null,
	setupExpiresAt: row.setupExpiresAt?.toISOString() ?? null,
	completedAt: row.completedAt?.toISOString() ?? null,
	createdAt: row.createdAt.toISOString(),
});

/** Who acts without a ticket or acting-user headers: the merchant's server (PLAN 0.8.10 K2). */
const SERVER_ACTOR = Object.freeze({ kind: 'server', id: 'server', name: 'Server' });

/** A code record id. */
const createCodeId = () => createId('cod');

/**
 * An activity-log copy as the API answers it: `label` and `detail` null when absent, `values` {} when none.
 * @param {import('../adapters/store.js').CopyRecord} row
 */
const copyView = (row) => ({
	id: row.id,
	productId: row.productId,
	actor: row.actor,
	action: row.action,
	target: row.target,
	label: row.label ?? null,
	detail: row.detail ?? null,
	values: row.values ?? {},
	at: row.at.toISOString(),
});

/**
 * @param {Product} product
 * @param {Service} service
 * @param {Flows} flows
 */
export const createManage = (product, service, flows) => {
	const { now } = product;
	/** Permission lists of the linked products, per website and product (5 minutes). @type {Map<string, { until: number, permissions: Array<{ key: string, name: string }> }>} */
	const permissionCache = new Map();

	/** Who acts (PLAN 0.8.10 K2). @param {any} ctx */
	const actor = (ctx) => actorOf(ctx, SERVER_ACTOR);

	/**
	 * An activity-log entry by the acting user.
	 * @param {any} ctx @param {string} action @param {string} target
	 * @param {{ label?: string, values?: Record<string, string | number | boolean> }} [about] the target's name and what
	 *   changed as values (A8; never addresses)
	 */
	const log = (ctx, action, target, about = {}) =>
		product.activity.record(
			{ websiteId: ctx.websiteId, merchantId: ctx.merchantId, after: ctx.after },
			{ actor: actor(ctx), action, target, ...about },
		);

	/** @param {import('./service.js').Site} s @param {string} id */
	const userOr404 = async (s, id) => {
		const user = await s.store.users.get(id);
		if (!user) throw problem('not_found', 'No such user.');
		return user;
	};

	// ------------------------------------------------------------------------------------------------------ users

	/**
	 * The filters of the users list and its counts: `q`, `role` and `roles` (a comma list; users of any of them),
	 * `permission` (`<product>:<key>`: users whose role grants it, K6), `status` (active, pending, invited, blocked),
	 * `blocked` (true or false), `deletion=1`, `phone` (exact, as typed in the website's phone format), `phoneDigits`
	 * (the end of a national number, A7: a whole number typed any usual way counts by its national number, so its trunk
	 * prefix or calling code does not matter; else at least 4 digits the number ends with) and `createdAfter`
	 * (ISO-8601), `tags` (a comma list: users with any of them, A5), and `consent` (the key of a consent the user gives
	 * now, A2: for example the users who want offers). A
	 * role or status that does not fit is ignored; a phone, permission, consent or time that does not fit answers 422.
	 * @param {any} ctx @param {import('./service.js').Site} s
	 * @returns {Promise<import('../adapters/store.js').UserQuery>}
	 */
	const userQuery = async (ctx, s) => {
		/** The national number of a whole number as typed, else its digits (the end of a number). @param {any} site @param {string} typed */
		const phoneEndOf = async (site, typed) => {
			const whole = await service.phoneOf(site, typed);
			return (whole && nationalNumberOf(whole)) ?? typed.replace(/\D/g, '');
		};
		const { q, role, roles, status, deletion, blocked, phone, phoneDigits, permission, consent, tags, createdAfter } =
			ctx.query;
		const named = [role, ...(typeof roles === 'string' ? roles.split(',') : [])]
			.filter((key) => typeof key === 'string')
			.map((key) => key.trim())
			.filter((key) => ROLE_KEY.test(key));
		/** @type {string[] | undefined} */
		let anyRole = named.length > 0 ? named : undefined;
		if (typeof permission === 'string' && permission !== '') {
			if (!PERMISSION_FILTER.test(permission)) throw invalid('permission', 'permission is <product>:<key>.');
			const granting = (await s.store.roles.list()).filter((each) => grants(each, permission)).map((each) => each.key);
			anyRole = anyRole ? anyRole.filter((key) => granting.includes(key)) : granting;
		}
		const exact = typeof phone === 'string' && phone !== '' ? await service.phoneOf(s, phone) : null;
		if (typeof phone === 'string' && phone !== '' && !exact)
			throw invalid('phone', 'Enter the phone number with its country code.');
		const end = typeof phoneDigits === 'string' && phoneDigits !== '' ? await phoneEndOf(s, phoneDigits) : '';
		if (typeof phoneDigits === 'string' && phoneDigits !== '' && end.length < MIN_PHONE_END)
			throw invalid('phoneDigits', `phoneDigits is a number, or at least ${MIN_PHONE_END} digits it ends with.`);
		if (typeof consent === 'string' && consent !== '' && !/^[a-z][a-z0-9_]{0,39}$/.test(consent))
			throw invalid('consent', 'consent is the key of a consent.');
		const tagList = typeof tags === 'string' && tags.trim() !== '' ? checkTags(tags.split(',')) : null;
		if (tagList && !tagList.ok) throw invalid('tags', 'tags is a comma list of tags.');
		const after = typeof createdAfter === 'string' && createdAfter !== '' ? new Date(createdAfter) : null;
		if (after && Number.isNaN(after.getTime())) throw invalid('createdAfter', 'createdAfter is an ISO-8601 time.');
		return {
			...(typeof q === 'string' && q.trim() ? { q: q.trim() } : {}),
			...(anyRole ? { roles: anyRole } : {}),
			...(USER_STATUSES.includes(status) ? { status } : {}),
			...(blocked === 'true' || blocked === 'false' ? { blocked: blocked === 'true' } : {}),
			...(exact ? { phone: exact } : {}),
			...(end ? { phoneEnd: end } : {}),
			...(typeof consent === 'string' && consent !== '' ? { consent } : {}),
			...(tagList?.ok ? { tags: tagList.value } : {}),
			...(after ? { createdAfter: after } : {}),
			deletion: deletion === '1',
		};
	};

	/**
	 * `?cursor=&limit=&q=&role=&roles=&permission=&status=&blocked=&deletion=1&phone=&phoneDigits=&createdAfter=`.
	 * @param {any} ctx
	 */
	const listUsers = async (ctx) => {
		const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url }, { defaultLimit: 25 });
		const s = await service.site(ctx);
		const rows = await s.store.users.list({
			after: /** @type {[string, string] | null} */ (page.after),
			limit: page.fetchLimit,
			...(await userQuery(ctx, s)),
		});
		return page.respond(rows.map(staffView), (user) => [user.createdAt, user.id]);
	};

	/**
	 * `GET /v1/users/count` and `/counts?by=status|role` (and their ticket twins): the list's own filters (PLAN 0.8.10
	 * K4). `status` groups by the stored status (active, pending, invited); blocked users are counted with
	 * `status=blocked`.
	 */
	const userCounts = countHandlers({
		source: async (ctx) => {
			const s = await service.site(ctx);
			return s.store.users.counting(await userQuery(ctx, s));
		},
		by: { status: 'status', role: 'role' },
	});

	/**
	 * The role of the staff member acting in a call: a ticket's user, or the acting user of a server-token call (K2). Null
	 * without one (the server token stays all-powerful), and for an acting user who is not a user of Accounts.
	 * @param {any} ctx @param {import('./service.js').Site} s
	 * @param {import('../core/profile.js').UserRecord} [self] the user the call is about, when it may be the actor
	 */
	const actingRoleOf = async (ctx, s, self) => {
		const actorId = ctx.ticket ? String(ctx.ticket.user.id) : (ctx.actor?.id ?? null);
		if (!actorId) return null;
		const acting = self && actorId === self.id ? self : await s.store.users.get(actorId);
		return acting ? service.roleOf(s, acting) : null;
	};

	/**
	 * Accounts' self-protection (A4, always), for a change made by a staff member: a ticket's user, or the acting user
	 * of a server-token call (K2). Nobody changes their own role, blocks or deletes themselves; nobody edits, blocks or
	 * deletes a user whose role ranks above theirs, or gives a role ranking above theirs; the last unblocked Owner is
	 * never demoted, blocked or deleted. Without a ticket or acting user the server token stays all-powerful; an acting
	 * user who is not a user of Accounts is checked by id only.
	 * @param {any} ctx @param {import('./service.js').Site} s @param {import('../core/profile.js').UserRecord} target
	 * @param {{ role?: string, block?: boolean, remove?: boolean }} [change]
	 */
	const guard = async (ctx, s, target, change = {}) => {
		const actorId = ctx.ticket ? String(ctx.ticket.user.id) : (ctx.actor?.id ?? null);
		if (!actorId) return;
		const newRole = change.role !== undefined && change.role !== target.role ? change.role : null;
		if (actorId === target.id && (change.remove || change.block || newRole))
			throw problem('forbidden', 'Nobody changes their own role, blocks or deletes themselves.');
		if (target.role === OWNER_ROLE && !target.blocked && (change.remove || change.block || newRole))
			if ((await s.store.users.unblockedOf(OWNER_ROLE)) <= 1)
				throw problem('forbidden', 'The last Owner cannot be demoted, blocked or deleted.');
		const mine = await actingRoleOf(ctx, s, target);
		if (!mine) return;
		if ((await service.roleOf(s, target)).rank < mine.rank) throw problem('forbidden', 'This user’s role ranks above yours.');
		const next = newRole ? await s.store.roles.get(newRole) : null;
		if (next && next.rank < mine.rank) throw problem('forbidden', 'This role ranks above yours.');
	};

	/**
	 * The ceiling of role changes (SR-4-3), for a change made by a staff member (as `guard`): they edit or delete only
	 * roles ranking below their own, give no role a rank at or above their own and no permission they do not hold (what a
	 * role already holds may stay). Owner keeps full power; the server token without an acting user stays all-powerful.
	 * @param {any} ctx @param {import('./service.js').Site} s @param {import('../core/roles.js').Role | null} existing
	 * @param {import('../core/roles.js').Role | null} [next] the role as it would be saved (null: deleted)
	 */
	const ceiling = async (ctx, s, existing, next = null) => {
		const mine = await actingRoleOf(ctx, s);
		if (!mine || mine.key === OWNER_ROLE) return;
		if (existing && existing.rank <= mine.rank) throw problem('forbidden', 'This role ranks at or above yours.');
		if (!next) return;
		if (next.rank <= mine.rank) throw problem('forbidden', 'A role cannot rank at or above yours.');
		const held = new Set(existing?.permissions ?? []);
		if (next.permissions.some((permission) => !held.has(permission) && !grants(mine, permission)))
			throw problem('forbidden', 'A role cannot get a permission you do not hold yourself.');
	};

	/**
	 * Email and phone of a user as staff enter them (A4): normalized, unique (checked when saved), marked verified.
	 * @param {import('./service.js').Site} s @param {Record<string, any>} body
	 * @returns {Promise<Record<string, unknown>>}
	 */
	const contactsOf = async (s, body) => {
		/** @type {Record<string, unknown>} */
		const set = {};
		if (body.email !== undefined) {
			const email = body.email === null || body.email === '' ? null : normalizeEmail(body.email);
			if (email === null && body.email !== null && body.email !== '') throw invalid('email', 'Enter a valid email address.');
			Object.assign(set, { email, emailVerified: email !== null });
		}
		if (body.phone !== undefined) {
			const phone = body.phone === null || body.phone === '' ? null : await service.phoneOf(s, body.phone);
			if (phone === null && body.phone !== null && body.phone !== '')
				throw invalid('phone', 'Enter the phone number with its country code.');
			Object.assign(set, { phone, phoneVerified: phone !== null });
		}
		return set;
	};

	/**
	 * Create an active user (A4): `{ name, email?, phone?, role?, password?, addresses?, notes?, custom?, tags? }`; nothing is
	 * sent. A user needs a name and an email address or a phone number.
	 * @param {any} ctx
	 */
	const createUser = async (ctx) => {
		const s = await service.site(ctx);
		const body = bodyOf(ctx.body);
		const name = checkName(body.name);
		if (!name) throw invalid('name', 'Write the name (at most 120 characters).');
		const contacts = await contactsOf(s, body);
		if (!contacts.email && !contacts.phone) throw invalid('email', 'Enter an email address or a phone number.');
		const signUpRole = (await service.signUpRole(s)).key;
		const role = body.role === undefined ? signUpRole : body.role;
		if (typeof role !== 'string' || !(await s.store.roles.get(role))) throw invalid('role', 'There is no such role.');
		await guard(ctx, s, /** @type {any} */ ({ id: '', role: signUpRole, blocked: null }), { role });
		if (body.notes !== undefined && (typeof body.notes !== 'string' || body.notes.length > 5000))
			throw invalid('notes', 'Notes are text of at most 5000 characters.');
		const custom = checkCustomValues(await s.store.fields.list(), body.custom, { complete: false, by: 'staff' });
		if (!custom.ok) throw invalid(custom.field, custom.message);
		const tags = body.tags === undefined ? { ok: /** @type {const} */ (true), value: [] } : checkTags(body.tags);
		if (!tags.ok) throw invalid('tags', tags.message);
		const draft = {
			email: /** @type {string | null} */ (contacts.email ?? null),
			phone: /** @type {string | null} */ (contacts.phone ?? null),
			name,
		};
		const method = service.passwordMethodOf(s, draft);
		const passwordHash =
			body.password === undefined || body.password === null
				? null
				: await flows.newPassword(s, body.password, { method: method ?? 'email_password', who: draft });
		const user = await s.store.users.create({
			...flows.blankUser(role),
			...draft,
			emailVerified: Boolean(draft.email),
			phoneVerified: Boolean(draft.phone),
			identity: draft.email ? 'email' : 'phone',
			role,
			passwordHash,
			passwordChangedAt: passwordHash ? new Date(now()) : null,
			notes: typeof body.notes === 'string' ? body.notes : '',
			custom: custom.value,
			tags: tags.value,
			addresses: body.addresses === undefined ? [] : await service.addressesOf(s, body.addresses, null),
		});
		if (!user) throw problem('already_exists', 'Someone with this email address or phone number has an account.');
		await log(ctx, 'user.created', user.id, {
			label: labelOf(name),
			values: valuesOf({ role, password: Boolean(passwordHash) }),
		});
		return new Response(JSON.stringify(staffView(user)), { status: 201, headers: { 'content-type': 'application/json' } });
	};

	/**
	 * Delete a user (A4): `{ reason }`. `?scope=all` (default) erases them at once, as an approved deletion request does
	 * (every connected product deletes or anonymizes their data); `?scope=accounts` removes them from Accounts only
	 * (the user, their sessions and codes) and every other product keeps its data, so removing someone from the team
	 * never erases their orders or conversations (ST-2).
	 * @param {any} ctx
	 */
	const deleteUser = async (ctx) => {
		const s = await service.site(ctx);
		const scope = ctx.query.scope ?? 'all';
		if (scope !== 'all' && scope !== 'accounts') throw invalid('scope', 'scope is all or accounts.');
		const user = await userOr404(s, ctx.params.id);
		await guard(ctx, s, user, { remove: true });
		const reason = typeof bodyOf(ctx.body).reason === 'string' ? bodyOf(ctx.body).reason.trim().slice(0, 300) : '';
		if (scope === 'accounts') {
			await service.removeHere(s, user);
			await log(ctx, 'user.removed', user.id, {
				label: labelOf(user.name),
				values: valuesOf({ scope: 'accounts', reason }),
			});
			return { deleted: true, pending: [] };
		}
		const { pending } = await service.erase(s, user, actor(ctx), ctx, { by: 'staff', reason });
		return { deleted: true, pending };
	};

	// ----------------------------------------------------------------------------- staff codes and setup links (A3)

	/**
	 * A one-time sign-in code for a user (A3): 6 digits, shown to staff only, never sent; typed into the phone-code,
	 * email-code or phone + password screen. A new one cancels the old.
	 * @param {any} ctx
	 */
	const signInCode = async (ctx) => {
		const s = await service.site(ctx);
		const user = await userOr404(s, ctx.params.id);
		await guard(ctx, s, user);
		if (user.blocked) throw problem('blocked', 'This account is blocked.');
		const code = generateCode({ length: STAFF_CODE_LENGTH, randomBytes });
		const expireAt = new Date(now() + STAFF_CODE_MINUTES * 60_000);
		const id = createCodeId();
		await s.store.codes.add({
			id,
			kind: 'staff_code',
			target: user.id,
			hash: sha256Hex(`${id}:${code}`),
			expireAt,
			data: { length: STAFF_CODE_LENGTH },
			replace: true,
		});
		await log(ctx, 'user.sign_in_code_issued', user.id, {
			label: labelOf(user.name),
			values: { minutes: STAFF_CODE_MINUTES },
		});
		return { code, expiresAt: expireAt.toISOString() };
	};

	/**
	 * A setup link for a user (A3, also A5's invites): it sets a password, also for users with no email address. A new
	 * one cancels the old. The setup page takes `{code}`; without one the link goes to the website with `?ss_setup=`.
	 * The link leaves a trace (its hash, its user and its end; SETUP_TRACE_DAYS past its end) for the setup page's
	 * lookup to tell "used", "expired" or "canceled" apart.
	 * @param {import('./service.js').Site} s @param {import('../core/profile.js').UserRecord} user
	 */
	const setupLinkFor = async (s, user) => {
		const { setupDays, setupPageUrl } = await service.settings(s, 'staff_links');
		const template = String(setupPageUrl) || `https://${s.domain}/`;
		const page = returnAddress(template.replaceAll('{code}', 'code'), s.domain);
		if (!page) throw invalid('setupPageUrl', 'Set the setup page (a page of your website) in Settings first.');
		const secret = randomToken(32);
		const hash = sha256Hex(secret);
		const expireAt = new Date(now() + Number(setupDays) * 86_400_000);
		await s.store.codes.cancelSetups(user.id);
		const id = await s.store.codes.add({ kind: 'setup', target: user.id, hash, expireAt, replace: true });
		await s.store.codes.add({
			kind: 'setup_trace',
			target: id,
			hash,
			expireAt: new Date(expireAt.getTime() + SETUP_TRACE_DAYS * 86_400_000),
			data: { userId: user.id, validUntil: expireAt, state: 'issued' },
		});
		const code = `${id}.${secret}`;
		/** @type {string} */
		let url;
		if (template.includes('{code}')) url = template.replaceAll('{code}', code);
		else {
			const link = new URL(template);
			link.searchParams.set(SETUP_PARAM, code);
			url = link.toString();
		}
		return { url, expiresAt: expireAt.toISOString() };
	};

	/** @param {any} ctx */
	const setupLink = async (ctx) => {
		const s = await service.site(ctx);
		const user = await userOr404(s, ctx.params.id);
		await guard(ctx, s, user);
		if (user.blocked) throw problem('blocked', 'This account is blocked.');
		const link = await setupLinkFor(s, user);
		// the new link replaced the one of the user's invited role request: the request ends with it (A5)
		const request = await s.store.requests.invitedFor(user.id);
		if (request) await s.store.requests.update(request.id, { setupExpiresAt: new Date(link.expiresAt) });
		await log(ctx, 'user.setup_link_issued', user.id, {
			label: labelOf(user.name),
			values: { expiresAt: link.expiresAt },
		});
		return link;
	};

	/** @param {any} ctx */
	const getUser = async (ctx) => staffView(await userOr404(await service.site(ctx), ctx.params.id));

	/**
	 * Role, notes, blocked (with a reason), name, custom fields and (A4) email, phone, password and addresses; behind
	 * the guards.
	 * @param {any} ctx
	 */
	const updateUser = async (ctx) => {
		const s = await service.site(ctx);
		const user = await userOr404(s, ctx.params.id);
		const body = bodyOf(ctx.body);
		await guard(ctx, s, user, {
			...(typeof body.role === 'string' ? { role: body.role } : {}),
			block: body.blocked === true && !user.blocked,
		});
		/** @type {Record<string, unknown>} */
		const set = {};
		/**
		 * What changed, in the order of the log: the action and its values (A8).
		 * @type {Array<{ action: string, values?: Record<string, string | number | boolean> }>}
		 */
		const changes = [];
		if (body.role !== undefined) {
			if (typeof body.role !== 'string' || !(await s.store.roles.get(body.role)))
				throw invalid('role', 'There is no such role.');
			set.role = body.role;
			changes.push({ action: 'user.role_changed', values: { from: user.role, to: body.role } });
		}
		if (body.tags !== undefined) {
			const tags = checkTags(body.tags);
			if (!tags.ok) throw invalid('tags', tags.message);
			set.tags = tags.value;
			const added = tags.value.filter((tag) => !user.tags.includes(tag));
			const removed = user.tags.filter((tag) => !tags.value.includes(tag));
			if (added.length > 0 || removed.length > 0)
				changes.push({
					action: 'user.tags_changed',
					values: valuesOf({ added: added.join(','), removed: removed.join(',') }),
				});
		}
		if (body.notes !== undefined) {
			if (typeof body.notes !== 'string' || body.notes.length > 5000)
				throw invalid('notes', 'Notes are text of at most 5000 characters.');
			set.notes = body.notes;
			// the notes themselves stay out of the log
			changes.push({ action: 'user.notes_changed' });
		}
		/** @type {string} */
		let reason = '';
		if (body.blocked !== undefined) {
			reason = typeof body.blockedReason === 'string' ? body.blockedReason.trim().slice(0, 300) : '';
			set.blocked = body.blocked === true ? { at: new Date(now()), reason } : null;
			changes.push({ action: body.blocked === true ? 'user.blocked' : 'user.unblocked' });
		}
		if (body.name !== undefined) {
			const name = checkName(body.name);
			if (name === null) throw invalid('name', 'The name is too long.');
			set.name = name;
			changes.push({ action: 'user.name_changed', values: valuesOf({ was: user.name }) });
		}
		if (body.custom !== undefined) {
			const checked = checkCustomValues(await s.store.fields.list(), body.custom, {
				complete: false,
				current: user.custom,
				by: 'staff',
			});
			if (!checked.ok) throw invalid(checked.field, checked.message);
			set.custom = checked.value;
			changes.push({ action: 'user.custom_changed', values: { fields: Object.keys(bodyOf(body.custom)).join(',') } });
		}
		const contacts = await contactsOf(s, body);
		if ('email' in contacts)
			changes.push({ action: 'user.email_changed', values: { change: contacts.email ? 'new' : 'removed' } });
		if ('phone' in contacts)
			changes.push({ action: 'user.phone_changed', values: { change: contacts.phone ? 'new' : 'removed' } });
		Object.assign(set, contacts);
		if (body.addresses !== undefined) {
			set.addresses = await service.addressesOf(s, body.addresses, user);
			changes.push({
				action: 'user.addresses_changed',
				values: { addresses: /** @type {unknown[]} */ (set.addresses).length },
			});
		}
		if (body.twoStep !== undefined) {
			// staff turn a user's two-step off (ST-18: its secret may no longer open); the user sets it up again
			if (body.twoStep !== false) throw invalid('twoStep', 'Send twoStep: false to turn two-step sign-in off.');
			const actorId = ctx.ticket ? String(ctx.ticket.user.id) : (ctx.actor?.id ?? null);
			if (actorId === user.id) throw problem('forbidden', 'Turn your own two-step sign-in off from your account.');
			if (user.twoStep?.enabledAt) {
				set.twoStep = null;
				changes.push({ action: 'user.two_step_off' });
			}
		}
		if (body.password !== undefined) {
			const next = { ...user, ...set };
			const method = service.passwordMethodOf(s, /** @type {any} */ (next)) ?? 'email_password';
			set.passwordHash = await flows.newPassword(s, body.password, { method, who: /** @type {any} */ (next) });
			set.passwordChangedAt = new Date(now());
			Object.assign(set, { failedLogins: 0, lockedUntil: null, lockLevel: 0 });
			changes.push({ action: 'user.password_changed' });
		}
		const updated = await s.store.users.update(user.id, set);
		if (!updated) throw problem('already_exists', 'Someone else has this email address or phone number.');
		// a blocked user, and a user whose password staff changed, is signed out everywhere at once (sign-ins already
		// issued end within 15 minutes)
		const signedOut = body.blocked === true || body.password !== undefined ? await s.store.sessions.revokeAll(user.id) : 0;
		const label = labelOf(updated.name);
		for (const { action, values } of changes) {
			const shown =
				action === 'user.blocked'
					? valuesOf({ reason, signedOut })
					: action === 'user.password_changed'
						? { signedOut }
						: values;
			await log(ctx, action, user.id, { label, ...(shown ? { values: shown } : {}) });
		}
		return staffView(updated);
	};

	/** Sign a user out of every device. @param {any} ctx */
	const signOutUser = async (ctx) => {
		const s = await service.site(ctx);
		const user = await userOr404(s, ctx.params.id);
		await guard(ctx, s, user);
		const signedOut = await s.store.sessions.revokeAll(user.id);
		await log(ctx, 'user.signed_out', user.id, {
			label: labelOf(user.name),
			values: { signedOut },
		});
		return undefined;
	};

	/** Invite someone by email or phone with a role (Approval / invite sign-up). @param {any} ctx */
	const invite = async (ctx) => {
		const s = await service.site(ctx);
		const body = bodyOf(ctx.body);
		const { invitePageUrl, inviteDays } = await service.settings(s, 'approval');
		const page = returnAddress(invitePageUrl, s.domain);
		if (!page) throw invalid('invitePageUrl', 'Set the invite page (a page of your website) in Settings first.');
		const email = body.email === undefined ? null : normalizeEmail(body.email);
		const phone = body.phone === undefined ? null : await service.phoneOf(s, body.phone);
		const deliver = body.deliver ?? 'send';
		if (deliver !== 'send' && deliver !== 'return') throw invalid('deliver', 'deliver is send or return.');
		if (!email && !phone) throw invalid('email', 'Enter an email address or a phone number.');
		const name = checkName(body.name);
		if (name === null) throw invalid('name', 'The name is too long.');
		const signUpRole = (await service.signUpRole(s)).key;
		const role = typeof body.role === 'string' ? body.role : signUpRole;
		if (!(await s.store.roles.get(role))) throw invalid('role', 'There is no such role.');
		await guard(ctx, s, /** @type {any} */ ({ id: '', role: signUpRole, blocked: null }), { role });
		// the invite goes to the email address when there is one
		const user = await s.store.users.create({
			...flows.blankUser(role),
			email,
			phone,
			name,
			status: 'invited',
			identity: email ? 'email' : 'phone',
		});
		if (!user) throw problem('already_exists', 'Someone with this email address or phone number has an account.');
		const secret = randomToken(32);
		const id = await s.store.codes.add({
			kind: 'invite',
			target: user.id,
			hash: sha256Hex(secret),
			expireAt: new Date(now() + inviteDays * 86_400_000),
			replace: true,
		});
		const values = { link: `${page}#${LINK_PARAMS.invite}=${id}.${secret}`, name: name || '', days: inviteDays };
		if (deliver === 'return') {
			// the link comes back to staff, who send it themselves (A3)
			await log(ctx, 'user.invited', user.id, {
				label: labelOf(name),
				values: { role, delivery: 'link', days: inviteDays },
			});
			const expiresAt = new Date(now() + inviteDays * 86_400_000).toISOString();
			return new Response(JSON.stringify({ ...staffView(user), invite: { url: values.link, expiresAt } }), {
				status: 201,
				headers: { 'content-type': 'application/json' },
			});
		}
		/** @type {string} */
		let sentBy = 'email';
		try {
			if (email) await service.notify(s, 'email', 'accounts.invite', { email }, values);
			else {
				// the phone channel while a phone sign-in is on (it is set only then), else SMS
				const { channel } = await service.settings(s, 'phone');
				sentBy = s.on.includes('phone_code') || s.on.includes('phone_password') ? channel : 'sms';
				await service.notify(
					s,
					/** @type {'sms' | 'whatsapp'} */ (sentBy),
					'accounts.invite',
					{ phone: /** @type {string} */ (phone) },
					values,
				);
			}
		} catch (error) {
			await s.store.users.remove(user.id);
			throw error;
		}
		await log(ctx, 'user.invited', user.id, {
			label: labelOf(name),
			values: { role, delivery: sentBy, days: inviteDays },
		});
		return new Response(JSON.stringify(staffView(user)), { status: 201, headers: { 'content-type': 'application/json' } });
	};

	/** Approve a sign-up that waits for approval. @param {any} ctx */
	const approve = async (ctx) => {
		const s = await service.site(ctx);
		const user = await userOr404(s, ctx.params.id);
		if (user.status !== 'pending') throw problem('conflict', 'This user is not waiting for approval.');
		await guard(ctx, s, user);
		const updated = await s.store.users.update(user.id, { status: 'active' });
		await log(ctx, 'user.approved', user.id, { label: labelOf(user.name), values: { role: user.role } });
		return staffView(updated ?? user);
	};

	/** Decline a sign-up that waits for approval: the account is removed. @param {any} ctx */
	const decline = async (ctx) => {
		const s = await service.site(ctx);
		const user = await userOr404(s, ctx.params.id);
		if (user.status !== 'pending') throw problem('conflict', 'This user is not waiting for approval.');
		await guard(ctx, s, user, { remove: true });
		await s.store.users.remove(user.id);
		await log(ctx, 'user.declined', user.id, { label: labelOf(user.name) });
		return undefined;
	};

	/** Approve a "delete my account" request: erased here and in every connected product. @param {any} ctx */
	const approveDeletion = async (ctx) => {
		const s = await service.site(ctx);
		const user = await userOr404(s, ctx.params.id);
		if (!user.deletion) throw problem('conflict', 'This user did not ask to be deleted.');
		await guard(ctx, s, user, { remove: true });
		const { pending } = await service.erase(s, user, actor(ctx), ctx, { by: 'request' });
		return { deleted: true, pending };
	};

	/** Keep the account: the deletion request is dropped. @param {any} ctx */
	const rejectDeletion = async (ctx) => {
		const s = await service.site(ctx);
		const user = await userOr404(s, ctx.params.id);
		if (!user.deletion) throw problem('conflict', 'This user did not ask to be deleted.');
		const updated = await s.store.users.update(user.id, { deletion: null });
		await log(ctx, 'user.deletion_rejected', user.id, { label: labelOf(user.name) });
		return staffView(updated ?? user);
	};

	// ------------------------------------------------------------------------------------------- role requests (A5)

	/**
	 * The filter of the requests list and its counts: `status` (pending, invited, completed, declined, or expired:
	 * invited, with the setup link run out) and `role`.
	 * @param {any} ctx
	 */
	const requestFilter = (ctx) => {
		const { status, role } = ctx.query;
		/** @type {Record<string, unknown>} */
		const filter = {};
		const at = new Date(now());
		if (status === 'expired') Object.assign(filter, { status: 'invited', setupExpiresAt: { $lte: at } });
		else if (status === 'invited')
			Object.assign(filter, { status: 'invited', $or: [{ setupExpiresAt: null }, { setupExpiresAt: { $gt: at } }] });
		else if (REQUEST_STATUSES.includes(status)) filter.status = status;
		if (typeof role === 'string' && ROLE_KEY.test(role)) filter.role = role;
		return filter;
	};

	/**
	 * A visitor asks for a role (A5): `{ role, name, phone | email, note }`, no account needed. A repeat ask changes
	 * nothing. Every ask answers `{ outcome: 'requested' }`, a new request or not, so nobody who types a phone number
	 * or email address learns whether it belongs to a member or has a request or invite (a privacy guard that is
	 * always on).
	 * @param {any} ctx
	 */
	const requestRole = async (ctx) => {
		const s = await service.site(ctx);
		const body = bodyOf(ctx.body);
		const { requestableRoles, requireNote } = await service.settings(s, 'role_requests');
		if (typeof body.role !== 'string' || !(/** @type {string[]} */ (requestableRoles).includes(body.role)))
			throw invalid('role', 'This role cannot be asked for.');
		const name = checkName(body.name);
		if (!name) throw invalid('name', 'Write your name.');
		const phone = body.phone === undefined || body.phone === '' ? null : await service.phoneOf(s, body.phone);
		if (phone === null && body.phone !== undefined && body.phone !== '')
			throw invalid('phone', 'Enter the phone number with its country code.');
		const email = body.email === undefined || body.email === '' ? null : normalizeEmail(body.email);
		if (email === null && body.email !== undefined && body.email !== '') throw invalid('email', 'Enter a valid email address.');
		if (!phone && !email) throw invalid('phone', 'Enter a phone number or an email address.');
		const note = typeof body.note === 'string' ? body.note.trim() : '';
		if (note.length > 1000) throw invalid('note', 'The note is at most 1000 characters.');
		if (requireNote && !note) throw invalid('note', 'Write a note.');
		/** @param {Record<string, unknown>} answer */
		const created = (answer) =>
			new Response(JSON.stringify(answer), { status: 201, headers: { 'content-type': 'application/json' } });
		// The same database work whatever the person's state, so the time of the answer tells as little as its words: both user lookups and the open-request lookup always, then one write and one read (the new
		// request, or in its place a short counter and a read that change nothing).
		const [byPhone, byEmail, [open]] = await Promise.all([
			phone ? s.store.users.byPhone(phone) : null,
			email ? s.store.users.byEmail(email) : null,
			s.store.requests.list({
				after: null,
				limit: 1,
				filter: { role: body.role, status: { $in: ['pending', 'invited'] }, ...(phone ? { phone } : { email }) },
			}),
		]);
		// the person already has the role: the user an invite would give it to (phone first), with that contact proven
		const holder = byPhone ?? byEmail;
		const member = holder && holder.role === body.role && (byPhone ? holder.phoneVerified : holder.emailVerified);
		if (member || open) {
			await s.store.counters.take('role_requests|repeats', REPEATS_WINDOW_MS, Number.MAX_SAFE_INTEGER);
			await s.store.requests.get(open?.id ?? '');
			return created({ outcome: 'requested' });
		}
		await s.store.requests.create({
			role: body.role,
			name,
			phone,
			email,
			note,
			status: 'pending',
			userId: null,
			invitedBy: null,
			invitedAt: null,
			setupExpiresAt: null,
			completedAt: null,
		});
		return created({ outcome: 'requested' });
	};

	/** `?status=&role=&cursor=&limit=`, newest first. @param {any} ctx */
	const listRequests = async (ctx) => {
		const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url }, { defaultLimit: 25 });
		const s = await service.site(ctx);
		const rows = await s.store.requests.list({
			after: /** @type {[string, string] | null} */ (page.after),
			limit: page.fetchLimit,
			filter: requestFilter(ctx),
		});
		return page.respond(
			rows.map((row) => requestView(row, now())),
			(row) => [row.createdAt, row.id],
		);
	};

	/** `GET /v1/role-requests/count` and `/counts?by=status|role` (K4; `status` groups the stored status). */
	const requestCounts = countHandlers({
		source: async (ctx) => (await service.site(ctx)).store.requests.counting(requestFilter(ctx)),
		by: { status: 'status', role: 'role' },
	});

	/** @param {import('./service.js').Site} s @param {string} id */
	const requestOr404 = async (s, id) => {
		const found = await s.store.requests.get(id);
		if (!found) throw problem('not_found', 'No such request.');
		return found;
	};

	/** `GET /v1/role-requests/:id`: one request, as the list gives it. @param {any} ctx */
	const readRequest = async (ctx) => requestView(await requestOr404(await service.site(ctx), ctx.params.id), now());

	/**
	 * Whether nobody could ever sign in to a user: no password, no social sign-in and never signed in (for example a
	 * user an earlier invite made, whose setup link was not used).
	 * @param {import('../core/profile.js').UserRecord} user
	 */
	const untouched = (user) => !user.passwordHash && !user.lastSignInAt && Object.keys(user.providers).length === 0;

	/** Who acts, as a request keeps it. @param {any} ctx */
	const invitedByOf = (ctx) => {
		const who = actor(ctx);
		return { kind: who.kind, id: who.id, ...(who.name ? { name: who.name } : {}) };
	};

	/**
	 * Invite the person of a pending request (A5): their user is created, or the user with that phone or email is
	 * found; the answer holds a setup link (A3) unless the user already has a password (then the request is completed at
	 * once). The role is given at the invite (`giveRoleAt: invite`, the default), or when the request is completed
	 * (`completion`: a new user starts with the default role, an existing one keeps theirs until then). What the invite
	 * did is kept on the request (its `grant`), so a decline can undo it. A user who never proved the request's phone or
	 * email gets nothing (409 `contact_unverified`): someone may have signed up first with another person's number
	 * (SA-2); only an untouched user is invited again. A user has one role (K-27), so a request never lowers one: a user
	 * whose role ranks above the request's (for example staff asking with their own phone) is refused (409 `conflict`).
	 * @param {any} ctx
	 */
	const inviteRequest = async (ctx) => {
		const s = await service.site(ctx);
		const request = await requestOr404(s, ctx.params.id);
		if (request.status !== 'pending') throw problem('conflict', 'Only a pending request can be invited.');
		const requested = await s.store.roles.get(request.role);
		if (!requested) throw problem('conflict', 'The role of this request no longer exists.');
		const byPhone = request.phone ? await s.store.users.byPhone(request.phone) : null;
		const existing = byPhone ?? (request.email ? await s.store.users.byEmail(request.email) : null);
		if (existing && !(byPhone ? existing.phoneVerified : existing.emailVerified) && !untouched(existing))
			throw problem(
				'contact_unverified',
				'Someone signed up with this phone number or email address without proving it. Check with the person: ' +
					'confirm it on their user if the account is theirs, or remove that account; then invite again.',
			);
		const current = existing ? await service.roleOf(s, existing) : null;
		if (current && current.rank < requested.rank)
			throw problem(
				'conflict',
				`The user with this phone number or email address has the role ${current.name}, which ranks above ` +
					`${requested.name}: a request never lowers a role. Change the role on their user if that is what you want, ` +
					'or decline the request.',
			);
		const at = (await service.settings(s, 'role_requests')).giveRoleAt === 'completion' ? 'completion' : 'invite';
		/** @type {import('../core/profile.js').UserRecord} */
		let user;
		/** @type {import('../adapters/store.js').RequestGrant} */
		let grant;
		if (existing) {
			await guard(ctx, s, existing, { role: request.role });
			// an earlier invite of this request made or changed this user (it was opened again after its link ran out): keep
			// what it did, and a role it gave stays given (a decline takes it back)
			const earlier = request.grant && request.userId === existing.id ? request.grant : null;
			const given = earlier?.at === 'invite' && existing.role === request.role;
			grant = {
				at: given ? 'invite' : at,
				createdUser: earlier?.createdUser ?? false,
				roleBefore: earlier?.roleBefore ?? existing.role,
			};
			user = at === 'invite' ? ((await s.store.users.update(existing.id, { role: request.role })) ?? existing) : existing;
		} else {
			const signUpRole = (await service.signUpRole(s)).key;
			await guard(ctx, s, /** @type {any} */ ({ id: '', role: signUpRole, blocked: null }), { role: request.role });
			// the setup link proves the phone number when there is one
			const created = await s.store.users.create({
				...flows.blankUser(at === 'invite' ? request.role : signUpRole),
				name: request.name,
				phone: request.phone,
				email: request.email,
				identity: request.phone ? 'phone' : 'email',
			});
			if (!created) throw problem('conflict', 'Someone else has this phone number or email address.');
			user = created;
			grant = { at, createdUser: true, roleBefore: signUpRole };
		}
		const link = user.passwordHash ? null : await setupLinkFor(s, user);
		let updated = await s.store.requests.update(request.id, {
			userId: user.id,
			invitedBy: invitedByOf(ctx),
			invitedAt: new Date(now()),
			grant,
			status: 'invited',
			setupExpiresAt: link ? new Date(link.expiresAt) : null,
			completedAt: null,
		});
		if (!link && updated) ({ user, request: updated } = await service.completeRequest(s, updated, user));
		await log(ctx, 'role_request.invited', request.id, {
			label: labelOf(request.name),
			values: {
				role: request.role,
				user: existing ? 'existing' : 'created',
				roleGiven: at === 'invite' || !link ? 'now' : 'at_setup',
				setupLink: Boolean(link),
			},
		});
		return { request: requestView(/** @type {any} */ (updated), now()), user: staffView(user), setupLink: link };
	};

	/**
	 * A new setup link for an invited request whose link still works or ran out (A5): the old link stops working. A
	 * user who has a password by now completes the request at once (no link), as an invite does.
	 * @param {any} ctx
	 */
	const renewRequestLink = async (ctx) => {
		const s = await service.site(ctx);
		const request = await requestOr404(s, ctx.params.id);
		const status = requestView(request, now()).status;
		if (status !== 'invited' && status !== 'expired')
			throw problem('conflict', 'Only an invited request (its link working or expired) gets a new link.');
		if (!(await s.store.roles.get(request.role))) throw problem('conflict', 'The role of this request no longer exists.');
		const found = request.userId ? await s.store.users.get(request.userId) : null;
		if (!found) throw problem('conflict', 'The user of this request no longer exists: decline it, open it again and invite.');
		await guard(ctx, s, found);
		if (found.blocked) throw problem('blocked', 'This account is blocked.');
		let user = found;
		const link = user.passwordHash ? null : await setupLinkFor(s, user);
		let updated = await s.store.requests.update(request.id, {
			invitedBy: invitedByOf(ctx),
			invitedAt: new Date(now()),
			setupExpiresAt: link ? new Date(link.expiresAt) : null,
		});
		if (!link && updated) ({ user, request: updated } = await service.completeRequest(s, updated, user));
		await log(ctx, 'role_request.link_renewed', request.id, {
			label: labelOf(request.name),
			values: valuesOf({
				role: request.role,
				result: link ? 'new_link' : 'completed',
				expiresAt: link?.expiresAt,
			}),
		});
		return { request: requestView(/** @type {any} */ (updated), now()), user: staffView(user), setupLink: link };
	};

	/**
	 * Decline a pending or invited request (its link working or expired; A5). An invited request's setup link stops
	 * working, and what its invite did is undone: a user the invite made who was never signed in to and has no password is
	 * removed from Accounts; otherwise, when the invite gave the role and the user still holds it, they get their role
	 * from before back. The guards apply to both, before anything changes.
	 * @param {any} ctx
	 */
	const declineRequest = async (ctx) => {
		const s = await service.site(ctx);
		const request = await requestOr404(s, ctx.params.id);
		const status = requestView(request, now()).status;
		if (!['pending', 'invited', 'expired'].includes(status))
			throw problem('conflict', 'Only a pending or invited request can be declined.');
		const user = request.userId ? await s.store.users.get(request.userId) : null;
		const grant = request.grant ?? null;
		const remove = Boolean(user && grant?.createdUser && untouched(user));
		const roleBack =
			user && grant && !remove && grant.at === 'invite' && user.role === request.role && grant.roleBefore !== request.role
				? grant.roleBefore
				: null;
		if (user && remove) await guard(ctx, s, user, { remove: true });
		if (user && roleBack) await guard(ctx, s, user, { role: roleBack });
		/** @type {Array<string | false>} */
		const done = [`Role: ${request.role}`];
		if (user && (status === 'invited' || status === 'expired')) {
			await s.store.codes.removeKind('setup', user.id);
			await s.store.codes.cancelSetups(user.id);
			done.push('setup_link_canceled');
		}
		if (user && remove) {
			await service.removeHere(s, user);
			done.push('user_removed');
		} else if (user && roleBack) {
			await s.store.users.update(user.id, { role: roleBack });
			done.push('role_back');
		}
		const updated = await s.store.requests.update(request.id, {
			status: 'declined',
			grant: null,
			...(remove ? { userId: null } : {}),
		});
		await log(ctx, 'role_request.declined', request.id, {
			label: labelOf(request.name),
			values: valuesOf({ done: done.join(','), roleBack: done.includes('role_back') ? roleBack : undefined }),
		});
		return requestView(/** @type {any} */ (updated), now());
	};

	/** Open a declined or expired request again (A5): it waits for staff, who invite it anew. @param {any} ctx */
	const reopenRequest = async (ctx) => {
		const s = await service.site(ctx);
		const request = await requestOr404(s, ctx.params.id);
		const status = requestView(request, now()).status;
		if (status !== 'declined' && status !== 'expired')
			throw problem('conflict', 'Only a declined or expired request can be opened again.');
		const updated = await s.store.requests.update(request.id, {
			status: 'pending',
			setupExpiresAt: null,
			invitedAt: null,
			invitedBy: null,
		});
		await log(ctx, 'role_request.reopened', request.id, {
			label: labelOf(request.name),
			values: { role: request.role },
		});
		return requestView(/** @type {any} */ (updated), now());
	};

	// ------------------------------------------------------------------------------------------------------ roles

	/**
	 * The roles, highest rank first, with the role for new sign-ups (A4).
	 * @param {any} ctx
	 */
	const listRoles = async (ctx) => {
		const s = await service.site(ctx);
		const items = (await s.store.roles.list()).map(roleView);
		return { items, signUpRole: (await service.signUpRole(s)).key };
	};

	/**
	 * Save a whole role (A3, A4): Owner keeps every permission and rank 100; `signUp: true` makes the role the one for
	 * new sign-ups (left out: unchanged), and the sign-up role moves only by choosing another one.
	 * @param {any} ctx
	 */
	const saveRole = async (ctx) => {
		const s = await service.site(ctx);
		const checked = checkRole(ctx.params.key, ctx.body);
		if (!checked.ok) throw invalid(checked.field, checked.message);
		const existing = await s.store.roles.get(checked.value.key);
		await ceiling(ctx, s, existing, checked.value);
		if (!existing && (await s.store.roles.count()) >= MAX_ROLES)
			throw problem('validation_failed', `A website can have at most ${MAX_ROLES} roles.`);
		const given = bodyOf(ctx.body).signUp;
		const signUp = given === undefined ? existing?.signUp === true : checked.value.signUp;
		if (existing?.signUp && !signUp)
			throw invalid('signUp', 'New sign-ups need a role: choose another role for new sign-ups instead.');
		if (signUp && checked.value.permissions.length > 0) throw invalid('permissions', SIGN_UP_NO_PERMISSIONS);
		const role = await s.store.roles.save({ ...checked.value, signUp });
		await log(ctx, 'role.saved', role.key, {
			label: labelOf(role.name) ?? role.key,
			values: {
				change: existing ? 'changed' : 'new',
				permissions: role.permissions.length,
				twoStep: role.twoStep,
				rank: role.rank,
				signIn: role.signIn,
				signUp: role.signUp,
			},
		});
		return roleView(role);
	};

	/**
	 * Delete a role; its users get the role for new sign-ups. Owner and the sign-up role stay (A3).
	 * @param {any} ctx
	 */
	const deleteRole = async (ctx) => {
		const s = await service.site(ctx);
		const role = await s.store.roles.get(ctx.params.key);
		if (!role) throw problem('not_found', 'No such role.');
		await ceiling(ctx, s, role);
		if (isSystemRole(role))
			throw problem('conflict', 'Owner and the role for new sign-ups stay: choose another role for new sign-ups first.');
		if (!(await s.store.roles.remove(role.key))) throw problem('not_found', 'No such role.');
		const to = (await service.signUpRole(s)).key;
		const moved = await s.store.users.resetRole(role.key, to);
		await log(ctx, 'role.deleted', role.key, {
			label: labelOf(role.name) ?? role.key,
			values: { users: moved, to },
		});
		return undefined;
	};

	/**
	 * The permission catalog: Accounts' own, each linked product's (its `GET /v1/permissions`, cached 5 minutes) and
	 * the merchant's own names. A product that cannot be reached is listed as unavailable.
	 * @param {any} ctx
	 */
	const catalog = async (ctx) => {
		const s = await service.site(ctx);
		/** @type {Array<{ productId: string, permissions: Array<{ key: string, name: string }> }>} */
		const products = [{ productId: 'accounts', permissions: manifest.permissions.map(({ key, name }) => ({ key, name })) }];
		/** @type {string[]} */
		const unavailable = [];
		for (const id of await service.connectedProducts(s.websiteId)) {
			const cacheKey = `${s.websiteId}|${id}`;
			const cached = permissionCache.get(cacheKey);
			if (cached && cached.until > now()) {
				products.push({ productId: id, permissions: cached.permissions });
				continue;
			}
			const answer = await product.callProduct(s.websiteId, id, '/v1/permissions');
			const list = answer.ok ? bodyOf(answer.body).permissions : null;
			if (!Array.isArray(list)) {
				unavailable.push(id);
				continue;
			}
			const permissions = list
				.filter((p) => typeof p?.key === 'string' && typeof p?.name === 'string')
				.map((p) => ({ key: String(p.key), name: String(p.name) }));
			permissionCache.set(cacheKey, { until: now() + PERMISSIONS_TTL_MS, permissions });
			products.push({ productId: id, permissions });
		}
		return { groups: permissionCatalog({ products, own: await s.store.permissions.list() }), unavailable };
	};

	/** Replace the merchant's own permission names (`{ permissions: [{ key, name }] }`). @param {any} ctx */
	const saveOwnPermissions = async (ctx) => {
		const s = await service.site(ctx);
		const checked = checkOwnPermissions(bodyOf(ctx.body).permissions);
		if (!checked.ok) throw invalid('permissions', checked.message);
		await s.store.permissions.replace(checked.value);
		await log(ctx, 'permissions.saved', 'site', {
			values: valuesOf({ count: checked.value.length, keys: checked.value.map((p) => p.key).join(',') }),
		});
		return { permissions: checked.value };
	};

	// --------------------------------------------------------------------------------------- activity-log copies

	/**
	 * Another product sends one activity-log entry (PLAN 0.4.11), with this website's Accounts server token: who (with
	 * the acting user's role), what, on what with its label, what changed (values, or a short detail) and when (K9).
	 * @param {any} ctx
	 */
	const receiveCopy = async (ctx) => {
		const checked = validateActivityCopy(ctx.body);
		if (!checked.ok || checked.value.websiteId !== ctx.websiteId)
			return problem(
				'validation_failed',
				'Send { websiteId, productId, actor, action, target, label?, detail?, values?, at } for this website.',
			);
		const s = await service.site(ctx);
		const { productId, actor: who, action, target, label, detail, values, at } = checked.value;
		await s.store.copies.add({
			productId,
			actor: who,
			action,
			target,
			...(label ? { label } : {}),
			...(detail ? { detail } : {}),
			...(values && Object.keys(values).length > 0 ? { values } : {}),
			at: new Date(at),
		});
		return new Response(JSON.stringify({ received: true }), { status: 201, headers: { 'content-type': 'application/json' } });
	};

	/**
	 * The website and the copies filter of a request: the kit's activity filter (`actor`, `action`, `target`, `q`,
	 * `from`, `to`; days in the business time zone) and the product the copy came from (`productId`); a filter that
	 * does not fit answers 422.
	 * @param {any} ctx
	 */
	const copySource = async (ctx) => {
		const s = await service.site(ctx);
		const { productId, ...query } = ctx.query;
		if (productId !== undefined && productId !== '' && !PRODUCT_ID.test(productId))
			throw invalid('productId', 'productId is a product id.');
		const built = activityFilter(query, (await product.business(s.websiteId)).timeZone ?? 'UTC');
		if (!built.ok) throw invalid(built.field, built.message);
		return { s, filter: productId ? { ...built.filter, productId } : built.filter };
	};

	/** `?productId=&actor=&action=&target=&q=&from=&to=&cursor=&limit=`, newest first. @param {any} ctx */
	const listCopies = async (ctx) => {
		const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url }, { defaultLimit: 50 });
		const { s, filter } = await copySource(ctx);
		const rows = await s.store.copies.list({
			after: /** @type {[string, string] | null} */ (page.after),
			limit: page.fetchLimit,
			filter,
		});
		return page.respond(rows.map(copyView), (row) => [row.at, row.id]);
	};

	/** `GET /v1/activity-copies/count` and `/counts?by=productId|action|actor`: the list's own filters (K4, K9). */
	const copyCounts = countHandlers({
		source: async (ctx) => {
			const { s, filter } = await copySource(ctx);
			return s.store.copies.counting(filter);
		},
		by: { productId: 'productId', action: 'action', actor: 'actor.id' },
	});

	// ------------------------------------------------------------------------------------- custom fields (dashboard)

	/** The dashboard's view of the custom fields (setup, not business data). @param {any} ctx */
	const fieldsStore = async (ctx) =>
		createStore(await product.data.forWebsite(ctx.websiteId, ctx.merchantId ? { merchantId: ctx.merchantId } : {}), { now });

	/** @param {any} ctx @param {string} detail */
	const recordChange = (ctx, detail) =>
		product.recentChanges.record({
			websiteId: ctx.websiteId,
			who: {
				kind: ctx.session.kind,
				id: ctx.session.subject,
				name: ctx.session.name,
				...(ctx.session.role ? { role: ctx.session.role } : {}),
			},
			what: 'custom fields',
			detail,
		});

	/** @param {any} ctx */
	const listFields = async (ctx) => ({ items: await (await fieldsStore(ctx)).fields.list() });

	/** Merchants edit custom fields only while the feature is on (admins may prepare them). @param {any} ctx */
	const editable = async (ctx) => {
		if (ctx.session.kind === 'merchant' && !(await product.featuresOn(ctx.websiteId)).includes('custom_fields'))
			throw problem('feature_off', 'Custom fields are off.');
	};

	// ---------------------------------------------------------------------------------------- tags and views (A5)

	/** The website's tags with how many users have each. @param {any} ctx */
	const listTags = async (ctx) => ({ items: await (await service.site(ctx)).store.users.tags() });

	/** The users list's saved views, in the merchant's order. @param {any} ctx */
	const listViews = async (ctx) => ({ items: await (await service.site(ctx)).store.views.list() });

	/** Save a view: `{ name, query }` (the list's filters). @param {any} ctx */
	const saveView = async (ctx) => {
		const s = await service.site(ctx);
		const checked = checkView(ctx.params.key, ctx.body);
		if (!checked.ok) throw invalid(checked.field, checked.message);
		const existing = (await s.store.views.list()).some((view) => view.key === checked.value.key);
		if (!existing && (await s.store.views.count()) >= MAX_VIEWS)
			throw problem('validation_failed', `A website keeps at most ${MAX_VIEWS} saved views.`);
		await s.store.views.save(checked.value);
		await log(ctx, 'users_view.saved', checked.value.key, { label: checked.value.name });
		return checked.value;
	};

	/** Delete a saved view. @param {any} ctx */
	const deleteView = async (ctx) => {
		const s = await service.site(ctx);
		if (!(await s.store.views.remove(ctx.params.key))) throw problem('not_found', 'No such view.');
		await log(ctx, 'users_view.deleted', ctx.params.key);
		return undefined;
	};

	/** Place the saved views in this order: `{ order: [every key once] }`. @param {any} ctx */
	const orderViews = async (ctx) => {
		const s = await service.site(ctx);
		const keys = (await s.store.views.list()).map((view) => view.key);
		const order = bodyOf(ctx.body).order;
		if (
			!Array.isArray(order) ||
			order.length !== keys.length ||
			new Set(order).size !== keys.length ||
			order.some((key) => !keys.includes(key))
		)
			throw invalid('order', 'Send every view key once, in the new order.');
		await s.store.views.reorder(order);
		return { items: await s.store.views.list() };
	};

	// ------------------------------------------------------------------------------------------------- consents (A2)

	/** Merchants edit the consent list only while the feature is on (admins may prepare it). @param {any} ctx */
	const consentsEditable = async (ctx) => {
		if (ctx.session.kind === 'merchant' && !(await product.featuresOn(ctx.websiteId)).includes('consents'))
			throw problem('feature_off', 'Consents are off.');
	};

	/** The consent list, for the dashboard. @param {any} ctx */
	const listConsents = async (ctx) => ({ items: await (await fieldsStore(ctx)).consents.list() });

	/** The consent list, for the merchant's server. @param {any} ctx */
	const consentList = async (ctx) => ({ items: await (await service.site(ctx)).store.consents.list() });

	/** Save a consent (A2). @param {any} ctx */
	const saveConsent = async (ctx) => {
		await consentsEditable(ctx);
		const checked = checkConsent(ctx.params.key, ctx.body);
		if (!checked.ok) throw invalid(checked.field, checked.message);
		const store = await fieldsStore(ctx);
		const existing = (await store.consents.list()).some((c) => c.key === checked.value.key);
		if (!existing && (await store.consents.count()) >= MAX_CONSENTS)
			throw problem('validation_failed', `A website can ask for at most ${MAX_CONSENTS} consents.`);
		await store.consents.save(checked.value);
		await recordChange(ctx, `Consent ${checked.value.key}: saved`);
		return checked.value;
	};

	/** Delete a consent (the answers users gave stay on their records). @param {any} ctx */
	const deleteConsent = async (ctx) => {
		await consentsEditable(ctx);
		if (!(await (await fieldsStore(ctx)).consents.remove(ctx.params.key))) throw problem('not_found', 'No such consent.');
		await recordChange(ctx, `Consent ${ctx.params.key}: deleted`);
		return undefined;
	};

	/** Place the consents in the merchant's order: `{ order: [every key once] }`. @param {any} ctx */
	const orderConsents = async (ctx) => {
		await consentsEditable(ctx);
		const store = await fieldsStore(ctx);
		const keys = (await store.consents.list()).map((c) => c.key);
		const order = bodyOf(ctx.body).order;
		if (
			!Array.isArray(order) ||
			order.length !== keys.length ||
			new Set(order).size !== keys.length ||
			order.some((k) => !keys.includes(k))
		)
			throw invalid('order', 'Send every consent key once, in the new order.');
		await store.consents.reorder(order);
		await recordChange(ctx, 'Consents: order saved');
		return { items: await store.consents.list() };
	};

	/**
	 * Place the custom fields in the merchant's order (A6): `{ order: [every key once] }`.
	 * @param {any} ctx
	 */
	const orderFields = async (ctx) => {
		await editable(ctx);
		const store = await fieldsStore(ctx);
		const keys = (await store.fields.list()).map((field) => field.key);
		const order = bodyOf(ctx.body).order;
		if (
			!Array.isArray(order) ||
			order.length !== keys.length ||
			new Set(order).size !== keys.length ||
			order.some((key) => !keys.includes(key))
		)
			throw invalid('order', 'Send every field key once, in the new order.');
		await store.fields.reorder(order);
		await recordChange(ctx, 'Fields: order saved');
		return { items: await store.fields.list() };
	};

	/**
	 * The custom fields, every one with who sees it (A6), for the merchant's server and the Users admin widget.
	 * @param {any} ctx
	 */
	const customFields = async (ctx) => ({ items: await (await service.site(ctx)).store.fields.list() });

	/**
	 * The custom fields a user sees (A6), public like the widgets' own: sign-up and My account on the merchant's own pages
	 * need the definitions (label, type, choices, help and whether the user edits the field). Staff-only fields never leave.
	 * @param {any} ctx
	 */
	const publicFields = async (ctx) => ({
		items: (await (await service.site(ctx)).store.fields.list()).filter((field) => field.visibility !== 'staff'),
	});

	/** @param {any} ctx */
	const saveField = async (ctx) => {
		await editable(ctx);
		const checked = checkFieldDefinition(ctx.params.key, ctx.body);
		if (!checked.ok) throw invalid(checked.field, checked.message);
		const store = await fieldsStore(ctx);
		const existing = (await store.fields.list()).some((f) => f.key === checked.value.key);
		if (!existing && (await store.fields.count()) >= MAX_CUSTOM_FIELDS)
			throw problem('validation_failed', `A website can have at most ${MAX_CUSTOM_FIELDS} custom fields.`);
		await store.fields.save(checked.value);
		await recordChange(ctx, `Field ${checked.value.key}: saved`);
		return checked.value;
	};

	/** @param {any} ctx */
	const deleteField = async (ctx) => {
		await editable(ctx);
		if (!(await (await fieldsStore(ctx)).fields.remove(ctx.params.key))) throw problem('not_found', 'No such field.');
		await recordChange(ctx, `Field ${ctx.params.key}: deleted`);
		return undefined;
	};

	return Object.freeze({
		listUsers,
		listTags,
		listViews,
		saveView,
		deleteView,
		orderViews,
		listConsents,
		consentList,
		saveConsent,
		deleteConsent,
		orderConsents,
		customFields,
		publicFields,
		orderFields,
		countUsers: userCounts.count,
		countUsersBy: userCounts.counts,
		getUser,
		createUser,
		deleteUser,
		signInCode,
		setupLink,
		requestRole,
		listRequests,
		readRequest,
		countRequests: requestCounts.count,
		countRequestsBy: requestCounts.counts,
		inviteRequest,
		renewRequestLink,
		declineRequest,
		reopenRequest,
		updateUser,
		signOutUser,
		invite,
		approve,
		decline,
		approveDeletion,
		rejectDeletion,
		listRoles,
		saveRole,
		deleteRole,
		catalog,
		saveOwnPermissions,
		receiveCopy,
		listCopies,
		countCopies: copyCounts.count,
		countCopiesBy: copyCounts.counts,
		listFields,
		saveField,
		deleteField,
	});
};
