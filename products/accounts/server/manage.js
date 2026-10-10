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
import { validateActivityCopy } from '@ss/contracts';
import { copyFilter, detailOf, labelOf } from '../core/activity.js';
import { normaliseEmail, normalisePhone } from '../core/identifiers.js';
import { MAX_CUSTOM_FIELDS, checkCustomValues, checkFieldDefinition, checkName, staffView } from '../core/profile.js';
import { DEFAULT_ROLE, MAX_ROLES, ROLE_KEY, checkOwnPermissions, checkRole, permissionCatalog } from '../core/roles.js';
import { returnAddress } from '../core/rules.js';
import { LINK_PARAMS } from '../core/widgets.js';
import { randomSecret, sha256 } from '../adapters/crypto.js';
import { manifest } from '../adapters/product.js';
import { createStore } from '../adapters/store.js';
import { invalid } from './flows.js';

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Service} Service */
/** @typedef {import('./flows.js').Flows} Flows */

/** @param {unknown} value */
const bodyOf = (value) => (typeof value === 'object' && value !== null ? /** @type {Record<string, any>} */ (value) : {});
const PERMISSIONS_TTL_MS = 5 * 60_000;
/** The users list's statuses (`blocked`: blocked users, whatever their status). */
const USER_STATUSES = Object.freeze(['active', 'pending', 'invited', 'blocked']);

/** Who acts without a ticket or acting-user headers: the merchant's server (PLAN 0.8.10 K2). */
export const SERVER_ACTOR = Object.freeze({ kind: 'server', id: 'server', name: 'Server' });

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
	 * The filters of the users list and its counts: `q`, `role`, `status` (active, pending, invited, blocked) and
	 * `deletion=1`; a role or status that does not fit is ignored.
	 * @param {any} ctx
	 * @returns {import('../adapters/store.js').UserQuery}
	 */
	const userQuery = (ctx) => {
		const { q, role, status, deletion } = ctx.query;
		return {
			...(typeof q === 'string' && q.trim() ? { q: q.trim() } : {}),
			...(typeof role === 'string' && ROLE_KEY.test(role) ? { role } : {}),
			...(USER_STATUSES.includes(status) ? { status } : {}),
			deletion: deletion === '1',
		};
	};

	/** `?cursor=&limit=&q=&role=&status=` (active, pending, invited, blocked) `&deletion=1`. @param {any} ctx */
	const listUsers = async (ctx) => {
		const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url }, { defaultLimit: 25 });
		const s = await service.site(ctx);
		const rows = await s.store.users.list({
			after: /** @type {[string, string] | null} */ (page.after),
			limit: page.fetchLimit,
			...userQuery(ctx),
		});
		return page.respond(rows.map(staffView), (user) => [user.createdAt, user.id]);
	};

	/**
	 * `GET /v1/users/count` and `/counts?by=status|role` (and their ticket twins): the list's own filters (PLAN 0.8.10
	 * K4). `status` groups by the stored status (active, pending, invited); blocked users are counted with
	 * `status=blocked`.
	 */
	const userCounts = countHandlers({
		source: async (ctx) => (await service.site(ctx)).store.users.counting(userQuery(ctx)),
		by: { status: 'status', role: 'role' },
	});

	/** @param {any} ctx */
	const getUser = async (ctx) => staffView(await userOr404(await service.site(ctx), ctx.params.id));

	/** Role, notes, blocked (with a reason), name and custom fields. @param {any} ctx */
	const updateUser = async (ctx) => {
		const s = await service.site(ctx);
		const user = await userOr404(s, ctx.params.id);
		const body = bodyOf(ctx.body);
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
		const updated = (await s.store.users.update(user.id, set)) ?? user;
		// a blocked user is signed out everywhere at once (sign-ins already issued end within 15 minutes)
		const signedOut = body.blocked === true ? await s.store.sessions.revokeAll(user.id) : 0;
		const label = labelOf(updated.name);
		for (const { action, detail } of changes) {
			const blockDetail =
				action === 'user.blocked'
					? detailOf([
							reason && `Reason: ${reason}`,
							signedOut > 0 && `${plural(signedOut, 'device', 'devices')} signed out`,
						])
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
		if (!page) throw problem('validation_failed', 'Set the invite page (a page of your website) in Settings first.');
		const email = body.email === undefined ? null : normaliseEmail(body.email);
		const { defaultCallingCode, trunkPrefix } = await service.settings(s, 'phone_code');
		const phone =
			body.phone === undefined
				? null
				: normalisePhone(body.phone, { defaultCallingCode: String(defaultCallingCode), trunkPrefix: String(trunkPrefix) });
		if (!email && !phone) throw invalid('email', 'Enter an e-mail address or a phone number.');
		const name = checkName(body.name);
		if (name === null) throw invalid('name', 'The name is too long.');
		const role = typeof body.role === 'string' ? body.role : DEFAULT_ROLE;
		if (!(await s.store.roles.get(role))) throw invalid('role', 'There is no such role.');
		const user = await s.store.users.create({ ...flows.blankUser(), email, phone, name, role, status: 'invited' });
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
		await s.store.users.remove(user.id);
		await log(ctx, 'user.declined', user.id, { label: labelOf(user.name), detail: 'The sign-up was removed' });
		return undefined;
	};

	/** Approve a "delete my account" request: erased here and in every connected product. @param {any} ctx */
	const approveDeletion = async (ctx) => {
		const s = await service.site(ctx);
		const user = await userOr404(s, ctx.params.id);
		if (!user.deletion) throw problem('conflict', 'This user did not ask to be deleted.');
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

	// ------------------------------------------------------------------------------------------------------ roles

	/** @param {any} ctx */
	const listRoles = async (ctx) => ({ items: await (await service.site(ctx)).store.roles.list() });

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
			]),
		});
		return role;
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
