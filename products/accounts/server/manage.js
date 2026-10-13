/**
 * The merchant's side (PLAN 0.8.6): users (list, search, counts, block, roles, notes, invites, approvals and deletion
 * requests) and roles with their permissions, through the merchant's server (server token) and the Users and Roles
 * admin widgets (tickets); the activity-log copies other products send (with their filters and counts); and the custom
 * fields set in the dashboard. Every change made through the server token or a ticket is written to the activity log
 * with the acting user (the ticket's member of staff, else the `SS-Actor-*` user of a server-token call, else the
 * server; PLAN 0.8.10 K2), the target's label and a short detail (K9).
 * @module
 */
import { actorOf, countHandlers, paginate, problem } from '@ss/app-kit';
import { createId, validateActivityCopy } from '@ss/contracts';
import { copyFilter, detailOf, labelOf } from '../core/activity.js';
import { normaliseEmail } from '../core/identifiers.js';
import { MAX_CUSTOM_FIELDS, checkCustomValues, checkFieldDefinition, checkName, staffView } from '../core/profile.js';
import {
	DEFAULT_ROLE,
	MAX_ROLES,
	OWNER_ROLE,
	ROLE_KEY,
	checkOwnPermissions,
	checkRole,
	grants,
	permissionCatalog,
	roleView,
} from '../core/roles.js';
import { generateCode, returnAddress } from '../core/rules.js';
import { LINK_PARAMS, SETUP_PARAM } from '../core/widgets.js';
import { randomBytes, randomSecret, sha256 } from '../adapters/crypto.js';
import { manifest } from '../adapters/product.js';
import { createStore } from '../adapters/store.js';
import { STAFF_CODE_LENGTH, invalid } from './flows.js';

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Service} Service */
/** @typedef {import('./flows.js').Flows} Flows */

/** @param {unknown} value */
const bodyOf = (value) => (typeof value === 'object' && value !== null ? /** @type {Record<string, any>} */ (value) : {});
const PERMISSIONS_TTL_MS = 5 * 60_000;
/** The users list's statuses (`blocked`: blocked users, whatever their status). */
const USER_STATUSES = Object.freeze(['active', 'pending', 'invited', 'blocked']);
/** A permission as the users list's `permission` filter takes it (`<product>:<key>`, PLAN 0.8.10 A4, K6). */
const PERMISSION_FILTER = /^[a-z][a-z0-9-]{1,30}:[a-z][a-z0-9_.]{0,63}$/;
/** Role requests' statuses (`expired`: invited, and the setup link has expired; judged on read, A5). */
const REQUEST_STATUSES = Object.freeze(['pending', 'invited', 'completed', 'declined', 'expired']);

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
export const SERVER_ACTOR = Object.freeze({ kind: 'server', id: 'server', name: 'Server' });

/** A code record id. */
const createCodeId = () => createId('cod');

/** @param {number} n @param {string} one @param {string} many */
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * An activity-log copy as the API answers it: `label` and `detail` null when absent.
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
	at: row.at.toISOString(),
});

/**
 * @param {Product} product
 * @param {Service} service
 * @param {Flows} flows
 */
export const createManage = (product, service, flows) => {
	const { now } = product;
	/** Permission lists of pasted products, per website and product (5 minutes). @type {Map<string, { until: number, permissions: Array<{ key: string, name: string }> }>} */
	const permissionCache = new Map();

	/** Who acts (PLAN 0.8.10 K2). @param {any} ctx */
	const actor = (ctx) => actorOf(ctx, SERVER_ACTOR);

	/**
	 * An activity-log entry by the acting user.
	 * @param {any} ctx @param {string} action @param {string} target
	 * @param {{ label?: string, detail?: string }} [about] the target's name and a short plain-text detail (never addresses)
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
	 * (the last 10 digits) and `createdAfter` (ISO-8601). A role or status that does not fit is ignored; a phone,
	 * permission or time that does not fit answers 422.
	 * @param {any} ctx @param {import('./service.js').Site} s
	 * @returns {Promise<import('../adapters/store.js').UserQuery>}
	 */
	const userQuery = async (ctx, s) => {
		const { q, role, roles, status, deletion, blocked, phone, phoneDigits, permission, createdAfter } = ctx.query;
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
		const digits = typeof phoneDigits === 'string' ? phoneDigits.replace(/\D/g, '').slice(-10) : '';
		if (typeof phoneDigits === 'string' && phoneDigits !== '' && digits.length < 7)
			throw invalid('phoneDigits', 'phoneDigits is the last 10 digits of a number.');
		const after = typeof createdAfter === 'string' && createdAfter !== '' ? new Date(createdAfter) : null;
		if (after && Number.isNaN(after.getTime())) throw invalid('createdAfter', 'createdAfter is an ISO-8601 time.');
		return {
			...(typeof q === 'string' && q.trim() ? { q: q.trim() } : {}),
			...(anyRole ? { roles: anyRole } : {}),
			...(USER_STATUSES.includes(status) ? { status } : {}),
			...(blocked === 'true' || blocked === 'false' ? { blocked: blocked === 'true' } : {}),
			...(exact ? { phone: exact } : {}),
			...(digits ? { phoneDigits: digits } : {}),
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
	 * Accounts' self-protection (A4, always), for a change made by a member of staff: a ticket's user, or the acting user
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
		const acting = actorId === target.id ? target : await s.store.users.get(actorId);
		if (!acting) return;
		const mine = await service.roleOf(s, acting);
		if ((await service.roleOf(s, target)).rank < mine.rank) throw problem('forbidden', 'This user’s role ranks above yours.');
		const next = newRole ? await s.store.roles.get(newRole) : null;
		if (next && next.rank < mine.rank) throw problem('forbidden', 'This role ranks above yours.');
	};

	/**
	 * E-mail and phone of a user as staff enter them (A4): normalised, unique (checked when saved), marked verified.
	 * @param {import('./service.js').Site} s @param {Record<string, any>} body
	 * @returns {Promise<Record<string, unknown>>}
	 */
	const contactsOf = async (s, body) => {
		/** @type {Record<string, unknown>} */
		const set = {};
		if (body.email !== undefined) {
			const email = body.email === null || body.email === '' ? null : normaliseEmail(body.email);
			if (email === null && body.email !== null && body.email !== '') throw invalid('email', 'Enter a valid e-mail address.');
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
	 * Create an active user (A4): `{ name, email?, phone?, role?, password?, addresses?, notes?, custom? }`; nothing is
	 * sent. A user needs a name and an e-mail address or a phone number.
	 * @param {any} ctx
	 */
	const createUser = async (ctx) => {
		const s = await service.site(ctx);
		const body = bodyOf(ctx.body);
		const name = checkName(body.name);
		if (!name) throw invalid('name', 'Write the name (at most 120 characters).');
		const contacts = await contactsOf(s, body);
		if (!contacts.email && !contacts.phone) throw invalid('email', 'Enter an e-mail address or a phone number.');
		const role = body.role === undefined ? DEFAULT_ROLE : body.role;
		if (typeof role !== 'string' || !(await s.store.roles.get(role))) throw invalid('role', 'There is no such role.');
		await guard(ctx, s, /** @type {any} */ ({ id: '', role: DEFAULT_ROLE, blocked: null }), { role });
		if (body.notes !== undefined && (typeof body.notes !== 'string' || body.notes.length > 5000))
			throw invalid('notes', 'Notes are text of at most 5000 characters.');
		const custom = checkCustomValues(await s.store.fields.list(), body.custom, { complete: false });
		if (!custom.ok) throw invalid(custom.field, custom.message);
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
			...flows.blankUser(),
			...draft,
			emailVerified: Boolean(draft.email),
			phoneVerified: Boolean(draft.phone),
			identity: draft.email ? 'email' : 'phone',
			role,
			passwordHash,
			notes: typeof body.notes === 'string' ? body.notes : '',
			custom: custom.value,
			addresses: body.addresses === undefined ? [] : await service.addressesOf(s, body.addresses, null),
		});
		if (!user) throw problem('already_exists', 'Someone with this e-mail address or phone number has an account.');
		await log(ctx, 'user.created', user.id, {
			label: labelOf(name),
			detail: detailOf([`Role: ${role}`, passwordHash && 'with a password']),
		});
		return new Response(JSON.stringify(staffView(user)), { status: 201, headers: { 'content-type': 'application/json' } });
	};

	/**
	 * Delete a user (A4): `{ reason }`. `?scope=all` (default) erases them at once, as an approved deletion request does
	 * (every connected product deletes or anonymises their data); `?scope=accounts` removes them from Accounts only
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
				detail: detailOf([reason && `Reason: ${reason}`, 'From Accounts only: other products keep their data']),
			});
			return { deleted: true, pending: [] };
		}
		const { pending } = await service.erase(s, user, actor(ctx), ctx, reason ? `Reason: ${reason}` : 'Deleted by staff');
		return { deleted: true, pending };
	};

	// ----------------------------------------------------------------------------- staff codes and setup links (A3)

	/**
	 * A one-time sign-in code for a user (A3): 6 digits, shown to staff only, never sent; typed into the phone-code,
	 * e-mail-code or phone + password screen. A new one cancels the old.
	 * @param {any} ctx
	 */
	const signInCode = async (ctx) => {
		const s = await service.site(ctx);
		const user = await userOr404(s, ctx.params.id);
		await guard(ctx, s, user);
		if (user.blocked) throw problem('blocked', 'This account is blocked.');
		const { codeMinutes } = await service.settings(s, 'staff_links');
		const code = generateCode({ length: STAFF_CODE_LENGTH, randomBytes });
		const expireAt = new Date(now() + Number(codeMinutes) * 60_000);
		const id = createCodeId();
		await s.store.codes.add({
			id,
			kind: 'staff_code',
			target: user.id,
			hash: sha256(`${id}:${code}`),
			expireAt,
			data: { length: STAFF_CODE_LENGTH },
			replace: true,
		});
		await log(ctx, 'user.sign_in_code_issued', user.id, {
			label: labelOf(user.name),
			detail: `Valid for ${plural(Number(codeMinutes), 'minute', 'minutes')}`,
		});
		return { code, expiresAt: expireAt.toISOString() };
	};

	/**
	 * A setup link for a user (A3, also A5's invites): it sets a password, also for users with no e-mail address. A new
	 * one cancels the old. The setup page takes `{code}`; without one the link goes to the website with `?ss_setup=`.
	 * @param {import('./service.js').Site} s @param {import('../core/profile.js').UserRecord} user
	 */
	const setupLinkFor = async (s, user) => {
		const { setupDays, setupPageUrl } = await service.settings(s, 'staff_links');
		const template = String(setupPageUrl) || `https://${s.domain}/`;
		const page = returnAddress(template.replaceAll('{code}', 'code'), s.domain);
		if (!page) throw invalid('setupPageUrl', 'Set the setup page (a page of your website) in Settings first.');
		const secret = randomSecret(32);
		const expireAt = new Date(now() + Number(setupDays) * 86_400_000);
		const id = await s.store.codes.add({ kind: 'setup', target: user.id, hash: sha256(secret), expireAt, replace: true });
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
		await log(ctx, 'user.setup_link_issued', user.id, {
			label: labelOf(user.name),
			detail: `Valid until ${link.expiresAt.slice(0, 10)}`,
		});
		return link;
	};

	/** @param {any} ctx */
	const getUser = async (ctx) => staffView(await userOr404(await service.site(ctx), ctx.params.id));

	/**
	 * Role, notes, blocked (with a reason), name, custom fields and (A4) e-mail, phone, password and addresses; behind
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
		/** What changed, in the order of the log: the action and its detail. @type {Array<{ action: string, detail?: string }>} */
		const changes = [];
		if (body.role !== undefined) {
			if (typeof body.role !== 'string' || !(await s.store.roles.get(body.role)))
				throw invalid('role', 'There is no such role.');
			set.role = body.role;
			changes.push({ action: 'user.role_changed', detail: `Role: ${user.role} → ${body.role}` });
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
			changes.push({ action: 'user.name_changed', ...(user.name ? { detail: `Was: ${user.name}` } : {}) });
		}
		if (body.custom !== undefined) {
			const checked = checkCustomValues(await s.store.fields.list(), body.custom, { complete: false, current: user.custom });
			if (!checked.ok) throw invalid(checked.field, checked.message);
			set.custom = checked.value;
			changes.push({ action: 'user.custom_changed', detail: `Fields: ${Object.keys(bodyOf(body.custom)).join(', ')}` });
		}
		const contacts = await contactsOf(s, body);
		if ('email' in contacts)
			changes.push({ action: 'user.email_changed', detail: contacts.email ? 'New e-mail address' : 'E-mail address removed' });
		if ('phone' in contacts)
			changes.push({ action: 'user.phone_changed', detail: contacts.phone ? 'New phone number' : 'Phone number removed' });
		Object.assign(set, contacts);
		if (body.addresses !== undefined) {
			set.addresses = await service.addressesOf(s, body.addresses, user);
			changes.push({
				action: 'user.addresses_changed',
				detail: plural(/** @type {unknown[]} */ (set.addresses).length, 'address', 'addresses'),
			});
		}
		if (body.twoStep !== undefined) {
			// staff turn a user's two-step off (ST-18: its secret may no longer open); the user sets it up again
			if (body.twoStep !== false) throw invalid('twoStep', 'Send twoStep: false to turn two-step sign-in off.');
			const actorId = ctx.ticket ? String(ctx.ticket.user.id) : (ctx.actor?.id ?? null);
			if (actorId === user.id) throw problem('forbidden', 'Turn your own two-step sign-in off from your account.');
			if (user.twoStep?.enabledAt) {
				set.twoStep = null;
				changes.push({
					action: 'user.two_step_off',
					detail: 'Two-step sign-in turned off: set up again at the next sign-in',
				});
			}
		}
		if (body.password !== undefined) {
			const next = { ...user, ...set };
			const method = service.passwordMethodOf(s, /** @type {any} */ (next)) ?? 'email_password';
			set.passwordHash = await flows.newPassword(s, body.password, { method, who: /** @type {any} */ (next) });
			Object.assign(set, { failedLogins: 0, lockedUntil: null, lockLevel: 0 });
			changes.push({ action: 'user.password_changed' });
		}
		const updated = await s.store.users.update(user.id, set);
		if (!updated) throw problem('already_exists', 'Someone else has this e-mail address or phone number.');
		// a blocked user, and a user whose password staff changed, is signed out everywhere at once (sign-ins already
		// issued end within 15 minutes)
		const signedOut = body.blocked === true || body.password !== undefined ? await s.store.sessions.revokeAll(user.id) : 0;
		const label = labelOf(updated.name);
		for (const { action, detail } of changes) {
			const blockDetail =
				action === 'user.blocked'
					? detailOf([
							reason && `Reason: ${reason}`,
							signedOut > 0 && `${plural(signedOut, 'device', 'devices')} signed out`,
						])
					: action === 'user.password_changed'
						? `${plural(signedOut, 'device', 'devices')} signed out`
						: detail;
			await log(ctx, action, user.id, { label, detail: blockDetail });
		}
		return staffView(updated);
	};

	/** Sign a user out of every device. @param {any} ctx */
	const signOutUser = async (ctx) => {
		const s = await service.site(ctx);
		const user = await userOr404(s, ctx.params.id);
		const signedOut = await s.store.sessions.revokeAll(user.id);
		await log(ctx, 'user.signed_out', user.id, {
			label: labelOf(user.name),
			detail: `${plural(signedOut, 'device', 'devices')} signed out`,
		});
		return undefined;
	};

	/** Invite someone by e-mail or phone with a role (Approval / invite sign-up). @param {any} ctx */
	const invite = async (ctx) => {
		const s = await service.site(ctx);
		const body = bodyOf(ctx.body);
		const { invitePageUrl, inviteDays } = await service.settings(s, 'approval');
		const page = returnAddress(invitePageUrl, s.domain);
		if (!page) throw invalid('invitePageUrl', 'Set the invite page (a page of your website) in Settings first.');
		const email = body.email === undefined ? null : normaliseEmail(body.email);
		const phone = body.phone === undefined ? null : await service.phoneOf(s, body.phone);
		const deliver = body.deliver ?? 'send';
		if (deliver !== 'send' && deliver !== 'return') throw invalid('deliver', 'deliver is send or return.');
		if (!email && !phone) throw invalid('email', 'Enter an e-mail address or a phone number.');
		const name = checkName(body.name);
		if (name === null) throw invalid('name', 'The name is too long.');
		const role = typeof body.role === 'string' ? body.role : DEFAULT_ROLE;
		if (!(await s.store.roles.get(role))) throw invalid('role', 'There is no such role.');
		await guard(ctx, s, /** @type {any} */ ({ id: '', role: DEFAULT_ROLE, blocked: null }), { role });
		// the invite goes to the e-mail address when there is one
		const user = await s.store.users.create({
			...flows.blankUser(),
			email,
			phone,
			name,
			role,
			status: 'invited',
			identity: email ? 'email' : 'phone',
		});
		if (!user) throw problem('already_exists', 'Someone with this e-mail address or phone number has an account.');
		const secret = randomSecret(32);
		const id = await s.store.codes.add({
			kind: 'invite',
			target: user.id,
			hash: sha256(secret),
			expireAt: new Date(now() + inviteDays * 86_400_000),
			replace: true,
		});
		const values = { link: `${page}#${LINK_PARAMS.invite}=${id}.${secret}`, name: name || '', days: inviteDays };
		if (deliver === 'return') {
			// the link comes back to staff, who send it themselves (A3)
			await log(ctx, 'user.invited', user.id, {
				label: labelOf(name),
				detail: `Role: ${role}; link given to staff; valid for ${plural(inviteDays, 'day', 'days')}`,
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
				const { channel } = await service.settings(s, 'phone_code');
				sentBy = s.on.includes('phone_code') ? channel : 'sms';
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
			detail: `Role: ${role}; sent by ${sentBy === 'email' ? 'e-mail' : sentBy === 'sms' ? 'SMS' : 'WhatsApp'}; valid for ${plural(inviteDays, 'day', 'days')}`,
		});
		return new Response(JSON.stringify(staffView(user)), { status: 201, headers: { 'content-type': 'application/json' } });
	};

	/** Approve a sign-up that waits for approval. @param {any} ctx */
	const approve = async (ctx) => {
		const s = await service.site(ctx);
		const user = await userOr404(s, ctx.params.id);
		if (user.status !== 'pending') throw problem('conflict', 'This user is not waiting for approval.');
		const updated = await s.store.users.update(user.id, { status: 'active' });
		await log(ctx, 'user.approved', user.id, { label: labelOf(user.name), detail: `Role: ${user.role}` });
		return staffView(updated ?? user);
	};

	/** Decline a sign-up that waits for approval: the account is removed. @param {any} ctx */
	const decline = async (ctx) => {
		const s = await service.site(ctx);
		const user = await userOr404(s, ctx.params.id);
		if (user.status !== 'pending') throw problem('conflict', 'This user is not waiting for approval.');
		await guard(ctx, s, user, { remove: true });
		await s.store.users.remove(user.id);
		await log(ctx, 'user.declined', user.id, { label: labelOf(user.name), detail: 'The sign-up was removed' });
		return undefined;
	};

	/** Approve a "delete my account" request: erased here and in every connected product. @param {any} ctx */
	const approveDeletion = async (ctx) => {
		const s = await service.site(ctx);
		const user = await userOr404(s, ctx.params.id);
		if (!user.deletion) throw problem('conflict', 'This user did not ask to be deleted.');
		await guard(ctx, s, user, { remove: true });
		const { pending } = await service.erase(s, user, actor(ctx), ctx, 'Deletion request approved');
		return { deleted: true, pending };
	};

	/** Keep the account: the deletion request is dropped. @param {any} ctx */
	const rejectDeletion = async (ctx) => {
		const s = await service.site(ctx);
		const user = await userOr404(s, ctx.params.id);
		if (!user.deletion) throw problem('conflict', 'This user did not ask to be deleted.');
		const updated = await s.store.users.update(user.id, { deletion: null });
		await log(ctx, 'user.deletion_rejected', user.id, { label: labelOf(user.name), detail: 'The account stays' });
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

	/** A visitor asks for a role (A5): `{ role, name, phone | email, note }`, no account needed. @param {any} ctx */
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
		const email = body.email === undefined || body.email === '' ? null : normaliseEmail(body.email);
		if (email === null && body.email !== undefined && body.email !== '')
			throw invalid('email', 'Enter a valid e-mail address.');
		if (!phone && !email) throw invalid('phone', 'Enter a phone number or an e-mail address.');
		const note = typeof body.note === 'string' ? body.note.trim() : '';
		if (note.length > 1000) throw invalid('note', 'The note is at most 1000 characters.');
		if (requireNote && !note) throw invalid('note', 'Write a note.');
		const open = await s.store.requests.list({
			after: null,
			limit: 1,
			filter: { role: body.role, status: 'pending', ...(phone ? { phone } : { email }) },
		});
		if (open.length > 0) throw problem('already_exists', 'This request is already waiting for the shop.');
		const request = await s.store.requests.create({
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
		return new Response(JSON.stringify({ id: request.id, status: request.status }), {
			status: 201,
			headers: { 'content-type': 'application/json' },
		});
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

	/**
	 * Whether nobody could ever sign in to a user: no password, no social sign-in and never signed in (for example a
	 * user an earlier invite made, whose setup link was not used).
	 * @param {import('../core/profile.js').UserRecord} user
	 */
	const untouched = (user) => !user.passwordHash && !user.lastSignInAt && Object.keys(user.providers ?? {}).length === 0;

	/**
	 * Invite the person of a pending request (A5): their user is created, or the user with that phone or e-mail gets
	 * the role; the answer holds a setup link (A3) unless the user already has a password (then the request is
	 * completed at once). A user who never proved the request's phone or e-mail gets nothing (409
	 * `contact_unverified`): someone may have signed up first with another person's number (SA-2); only an untouched
	 * user is invited again.
	 * @param {any} ctx
	 */
	const inviteRequest = async (ctx) => {
		const s = await service.site(ctx);
		const request = await requestOr404(s, ctx.params.id);
		if (request.status !== 'pending') throw problem('conflict', 'Only a pending request can be invited.');
		if (!(await s.store.roles.get(request.role))) throw problem('conflict', 'The role of this request no longer exists.');
		const byPhone = request.phone ? await s.store.users.byPhone(request.phone) : null;
		const existing = byPhone ?? (request.email ? await s.store.users.byEmail(request.email) : null);
		if (existing && !(byPhone ? existing.phoneVerified : existing.emailVerified) && !untouched(existing))
			throw problem(
				'contact_unverified',
				'Someone signed up with this phone number or e-mail address without proving it. Check with the person: ' +
					'confirm it on their user if the account is theirs, or remove that account; then invite again.',
			);
		/** @type {import('../core/profile.js').UserRecord} */
		let user;
		if (existing) {
			await guard(ctx, s, existing, { role: request.role });
			user = (await s.store.users.update(existing.id, { role: request.role })) ?? existing;
		} else {
			await guard(ctx, s, /** @type {any} */ ({ id: '', role: DEFAULT_ROLE, blocked: null }), { role: request.role });
			// the setup link proves the phone number when there is one
			const created = await s.store.users.create({
				...flows.blankUser(),
				name: request.name,
				phone: request.phone,
				email: request.email,
				role: request.role,
				identity: request.phone ? 'phone' : 'email',
			});
			if (!created) throw problem('conflict', 'Someone else has this phone number or e-mail address.');
			user = created;
		}
		const link = user.passwordHash ? null : await setupLinkFor(s, user);
		const who = actor(ctx);
		const updated = await s.store.requests.update(request.id, {
			userId: user.id,
			invitedBy: { kind: who.kind, id: who.id, ...(who.name ? { name: who.name } : {}) },
			invitedAt: new Date(now()),
			...(link
				? { status: 'invited', setupExpiresAt: new Date(link.expiresAt), completedAt: null }
				: { status: 'completed', setupExpiresAt: null, completedAt: new Date(now()) }),
		});
		await log(ctx, 'role_request.invited', request.id, {
			label: labelOf(request.name),
			detail: detailOf([
				`Role: ${request.role}`,
				existing ? 'role given to the existing user' : 'user created',
				link && 'setup link given to staff',
			]),
		});
		return { request: requestView(/** @type {any} */ (updated), now()), user: staffView(user), setupLink: link };
	};

	/**
	 * Decline a pending request, or open a declined or expired one again (A5).
	 * @param {'declined' | 'pending'} to
	 */
	const moveRequest = (to) => async (/** @type {any} */ ctx) => {
		const s = await service.site(ctx);
		const request = await requestOr404(s, ctx.params.id);
		const status = requestView(request, now()).status;
		const allowed = to === 'declined' ? ['pending'] : ['declined', 'expired'];
		if (!allowed.includes(status))
			throw problem(
				'conflict',
				to === 'declined'
					? 'Only a pending request can be declined.'
					: 'Only a declined or expired request can be opened again.',
			);
		const updated = await s.store.requests.update(request.id, {
			status: to,
			...(to === 'pending' ? { setupExpiresAt: null, invitedAt: null, invitedBy: null } : {}),
		});
		await log(ctx, to === 'declined' ? 'role_request.declined' : 'role_request.reopened', request.id, {
			label: labelOf(request.name),
			detail: `Role: ${request.role}`,
		});
		return requestView(/** @type {any} */ (updated), now());
	};

	// ------------------------------------------------------------------------------------------------------ roles

	/** @param {any} ctx */
	const listRoles = async (ctx) => ({ items: (await (await service.site(ctx)).store.roles.list()).map(roleView) });

	/** Save a role (a ready-made one keeps its key and cannot be deleted). @param {any} ctx */
	const saveRole = async (ctx) => {
		const s = await service.site(ctx);
		const checked = checkRole(ctx.params.key, ctx.body);
		if (!checked.ok) throw invalid(checked.field, checked.message);
		const existing = await s.store.roles.get(checked.value.key);
		if (!existing && (await s.store.roles.count()) >= MAX_ROLES)
			throw problem('validation_failed', `A website can have at most ${MAX_ROLES} roles.`);
		const role = await s.store.roles.save(checked.value);
		await log(ctx, 'role.saved', role.key, {
			label: labelOf(role.name) ?? role.key,
			detail: detailOf([
				existing ? 'Changed' : 'New role',
				plural(role.permissions.length, 'permission', 'permissions'),
				`two-step ${role.twoStep}`,
				`rank ${role.rank}`,
				role.signIn === 'paused' && 'sign-in paused',
			]),
		});
		return roleView(role);
	};

	/** Delete one of the merchant's own roles; its users get the Customer role. @param {any} ctx */
	const deleteRole = async (ctx) => {
		const s = await service.site(ctx);
		const role = await s.store.roles.get(ctx.params.key);
		if (!(await s.store.roles.remove(ctx.params.key)))
			throw problem('not_found', 'No such role of your own (ready-made roles stay).');
		const moved = await s.store.users.resetRole(ctx.params.key);
		await log(ctx, 'role.deleted', ctx.params.key, {
			label: labelOf(role?.name) ?? ctx.params.key,
			detail: `${plural(moved, 'user', 'users')} moved to the role ${DEFAULT_ROLE}`,
		});
		return undefined;
	};

	/**
	 * The permission catalog: Accounts' own, each pasted product's (its `GET /v1/permissions`, cached 5 minutes) and
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
		await log(ctx, 'permissions.saved', `${checked.value.length}`, {
			label: 'Own permissions',
			detail:
				checked.value.length > 0 ? detailOf([checked.value.map((p) => `site:${p.key}`).join(', ')]) : 'No own permissions',
		});
		return { permissions: checked.value };
	};

	// --------------------------------------------------------------------------------------- activity-log copies

	/**
	 * Another product sends one activity-log entry (PLAN 0.4.11), with this website's Accounts server token: who (with
	 * the acting user's role), what, on what with its label, a short detail and when (K9).
	 * @param {any} ctx
	 */
	const receiveCopy = async (ctx) => {
		const checked = validateActivityCopy(ctx.body);
		if (!checked.ok || checked.value.websiteId !== ctx.websiteId)
			return problem(
				'validation_failed',
				'Send { websiteId, productId, actor, action, target, label?, detail?, at } for this website.',
			);
		const s = await service.site(ctx);
		const { productId, actor: who, action, target, label, detail, at } = checked.value;
		await s.store.copies.add({
			productId,
			actor: who,
			action,
			target,
			...(label ? { label } : {}),
			...(detail ? { detail } : {}),
			at: new Date(at),
		});
		return new Response(JSON.stringify({ received: true }), { status: 201, headers: { 'content-type': 'application/json' } });
	};

	/**
	 * The website and the copies filter of a request (`productId`, `actor`, `action`, `target`, `q`, `from`, `to`; days in
	 * the business time zone); a filter that does not fit answers 422.
	 * @param {any} ctx
	 */
	const copySource = async (ctx) => {
		const s = await service.site(ctx);
		const built = copyFilter(ctx.query, (await product.business(s.websiteId)).timeZone ?? 'UTC');
		if (!built.ok) throw invalid(built.field, built.message);
		return { s, filter: built.filter };
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
		countUsers: userCounts.count,
		countUsersBy: userCounts.counts,
		getUser,
		createUser,
		deleteUser,
		signInCode,
		setupLink,
		requestRole,
		listRequests,
		countRequests: requestCounts.count,
		countRequestsBy: requestCounts.counts,
		inviteRequest,
		declineRequest: moveRequest('declined'),
		reopenRequest: moveRequest('pending'),
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
