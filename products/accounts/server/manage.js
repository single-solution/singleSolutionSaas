/**
 * The merchant's side (PLAN 0.8.6): users (list, search, block, roles, notes, invites, approvals and deletion
 * requests) and roles with their permissions, through the merchant's server (server token) and the Users and Roles
 * admin widgets (tickets); the activity-log copies other products send; and the custom fields set in the dashboard.
 * Every change made through the server token or a ticket is written to the activity log.
 * @module
 */
import { paginate, problem } from '@ss/app-kit';
import { validateActivityCopy } from '@ss/contracts';
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

/**
 * @param {Product} product
 * @param {Service} service
 * @param {Flows} flows
 */
export const createManage = (product, service, flows) => {
	const { now } = product;
	/** Permission lists of pasted products, per website and product (5 minutes). @type {Map<string, { until: number, permissions: Array<{ key: string, name: string }> }>} */
	const permissionCache = new Map();

	/** Who acts: the member of staff in the ticket, or the merchant's server. @param {any} ctx */
	const actorOf = (ctx) =>
		ctx.ticket
			? { kind: 'staff', id: String(ctx.ticket.user.id), name: String(ctx.ticket.user.name) }
			: { kind: 'server', id: 'server' };

	/** @param {any} ctx @param {string} action @param {string} target */
	const log = (ctx, action, target) =>
		product.activity.record(
			{ websiteId: ctx.websiteId, merchantId: ctx.merchantId, after: ctx.after },
			{
				actor: actorOf(ctx),
				action,
				target,
			},
		);

	/** @param {import('./service.js').Site} s @param {string} id */
	const userOr404 = async (s, id) => {
		const user = await s.store.users.get(id);
		if (!user) throw problem('not_found', 'No such user.');
		return user;
	};

	// ------------------------------------------------------------------------------------------------------ users

	/** `?cursor=&limit=&q=&role=&status=` (active, pending, invited, blocked) `&deletion=1`. @param {any} ctx */
	const listUsers = async (ctx) => {
		const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url }, { defaultLimit: 25 });
		const s = await service.site(ctx);
		const status = ['active', 'pending', 'invited', 'blocked'].includes(ctx.query.status) ? ctx.query.status : undefined;
		const rows = await s.store.users.list({
			after: /** @type {[string, string] | null} */ (page.after),
			limit: page.fetchLimit,
			...(typeof ctx.query.q === 'string' && ctx.query.q.trim() ? { q: ctx.query.q.trim() } : {}),
			...(typeof ctx.query.role === 'string' && ROLE_KEY.test(ctx.query.role) ? { role: ctx.query.role } : {}),
			...(status ? { status } : {}),
			deletion: ctx.query.deletion === '1',
		});
		return page.respond(rows.map(staffView), (user) => [user.createdAt, user.id]);
	};

	/** @param {any} ctx */
	const getUser = async (ctx) => staffView(await userOr404(await service.site(ctx), ctx.params.id));

	/** Role, notes, blocked (with a reason), name and custom fields. @param {any} ctx */
	const updateUser = async (ctx) => {
		const s = await service.site(ctx);
		const user = await userOr404(s, ctx.params.id);
		const body = bodyOf(ctx.body);
		/** @type {Record<string, unknown>} */
		const set = {};
		/** @type {string[]} */
		const changes = [];
		if (body.role !== undefined) {
			if (typeof body.role !== 'string' || !(await s.store.roles.get(body.role)))
				throw invalid('role', 'There is no such role.');
			set.role = body.role;
			changes.push('role');
		}
		if (body.notes !== undefined) {
			if (typeof body.notes !== 'string' || body.notes.length > 5000)
				throw invalid('notes', 'Notes are text of at most 5000 characters.');
			set.notes = body.notes;
			changes.push('notes');
		}
		if (body.blocked !== undefined) {
			const reason = typeof body.blockedReason === 'string' ? body.blockedReason.trim().slice(0, 300) : '';
			set.blocked = body.blocked === true ? { at: new Date(now()), reason } : null;
			changes.push(body.blocked === true ? 'blocked' : 'unblocked');
		}
		if (body.name !== undefined) {
			const name = checkName(body.name);
			if (name === null) throw invalid('name', 'The name is too long.');
			set.name = name;
			changes.push('name');
		}
		if (body.custom !== undefined) {
			const checked = checkCustomValues(await s.store.fields.list(), body.custom, { complete: false, current: user.custom });
			if (!checked.ok) throw invalid(checked.field, checked.message);
			set.custom = checked.value;
			changes.push('custom');
		}
		const updated = (await s.store.users.update(user.id, set)) ?? user;
		// a blocked user is signed out everywhere at once (sign-ins already issued end within 15 minutes)
		if (body.blocked === true) await s.store.sessions.revokeAll(user.id);
		for (const change of changes)
			await log(ctx, `user.${change === 'blocked' || change === 'unblocked' ? change : `${change}_changed`}`, user.id);
		return staffView(updated);
	};

	/** Sign a user out of every device. @param {any} ctx */
	const signOutUser = async (ctx) => {
		const s = await service.site(ctx);
		const user = await userOr404(s, ctx.params.id);
		await s.store.sessions.revokeAll(user.id);
		await log(ctx, 'user.signed_out', user.id);
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
		try {
			if (email) await service.notify(s, 'email', 'accounts.invite', { email }, values);
			else {
				const { channel } = await service.settings(s, 'phone_code');
				await service.notify(
					s,
					s.on.includes('phone_code') ? channel : 'sms',
					'accounts.invite',
					{ phone: /** @type {string} */ (phone) },
					values,
				);
			}
		} catch (error) {
			await s.store.users.remove(user.id);
			throw error;
		}
		await log(ctx, 'user.invited', user.id);
		return new Response(JSON.stringify(staffView(user)), { status: 201, headers: { 'content-type': 'application/json' } });
	};

	/** Approve a sign-up that waits for approval. @param {any} ctx */
	const approve = async (ctx) => {
		const s = await service.site(ctx);
		const user = await userOr404(s, ctx.params.id);
		if (user.status !== 'pending') throw problem('conflict', 'This user is not waiting for approval.');
		const updated = await s.store.users.update(user.id, { status: 'active' });
		await log(ctx, 'user.approved', user.id);
		return staffView(updated ?? user);
	};

	/** Decline a sign-up that waits for approval: the account is removed. @param {any} ctx */
	const decline = async (ctx) => {
		const s = await service.site(ctx);
		const user = await userOr404(s, ctx.params.id);
		if (user.status !== 'pending') throw problem('conflict', 'This user is not waiting for approval.');
		await s.store.users.remove(user.id);
		await log(ctx, 'user.declined', user.id);
		return undefined;
	};

	/** Approve a "delete my account" request: erased here and in every connected product. @param {any} ctx */
	const approveDeletion = async (ctx) => {
		const s = await service.site(ctx);
		const user = await userOr404(s, ctx.params.id);
		if (!user.deletion) throw problem('conflict', 'This user did not ask to be deleted.');
		const { pending } = await service.erase(s, user, actorOf(ctx), ctx);
		return { deleted: true, pending };
	};

	/** Keep the account: the deletion request is dropped. @param {any} ctx */
	const rejectDeletion = async (ctx) => {
		const s = await service.site(ctx);
		const user = await userOr404(s, ctx.params.id);
		if (!user.deletion) throw problem('conflict', 'This user did not ask to be deleted.');
		const updated = await s.store.users.update(user.id, { deletion: null });
		await log(ctx, 'user.deletion_rejected', user.id);
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
		if (!(await s.store.roles.get(checked.value.key)) && (await s.store.roles.count()) >= MAX_ROLES)
			throw problem('validation_failed', `A website can have at most ${MAX_ROLES} roles.`);
		const role = await s.store.roles.save(checked.value);
		await log(ctx, 'role.saved', role.key);
		return role;
	};

	/** Delete one of the merchant's own roles; its users get the Customer role. @param {any} ctx */
	const deleteRole = async (ctx) => {
		const s = await service.site(ctx);
		if (!(await s.store.roles.remove(ctx.params.key)))
			throw problem('not_found', 'No such role of your own (ready-made roles stay).');
		await s.store.users.resetRole(ctx.params.key);
		await log(ctx, 'role.deleted', ctx.params.key);
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
		await log(ctx, 'permissions.saved', `${checked.value.length}`);
		return { permissions: checked.value };
	};

	// --------------------------------------------------------------------------------------- activity-log copies

	/** Another product sends one activity-log entry (PLAN 0.4.11), with this website's Accounts server token. @param {any} ctx */
	const receiveCopy = async (ctx) => {
		const checked = validateActivityCopy(ctx.body);
		if (!checked.ok || checked.value.websiteId !== ctx.websiteId)
			return problem('validation_failed', 'Send { websiteId, productId, actor, action, target, at } for this website.');
		const s = await service.site(ctx);
		const { productId, actor, action, target, at } = checked.value;
		await s.store.copies.add({ productId, actor, action, target, at: new Date(at) });
		return new Response(JSON.stringify({ received: true }), { status: 201, headers: { 'content-type': 'application/json' } });
	};

	/** `?cursor=&limit=&productId=`, newest first. @param {any} ctx */
	const listCopies = async (ctx) => {
		const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url }, { defaultLimit: 50 });
		const s = await service.site(ctx);
		const rows = await s.store.copies.list({
			after: /** @type {[string, string] | null} */ (page.after),
			limit: page.fetchLimit,
			...(typeof ctx.query.productId === 'string' && /^[a-z][a-z0-9-]{1,30}$/.test(ctx.query.productId)
				? { productId: ctx.query.productId }
				: {}),
		});
		return page.respond(
			rows.map((row) => ({ ...row, at: row.at.toISOString() })),
			(row) => [row.at, row.id],
		);
	};

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
		listFields,
		saveField,
		deleteField,
	});
};
