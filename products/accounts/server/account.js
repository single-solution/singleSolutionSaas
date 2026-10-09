/**
 * My account (PLAN 0.8.6): what a signed-in user does with their own account through the browser token plus their
 * sign-in (`SS-Sign-In` header): profile and addresses, devices, password, two-step, terms, download my data, delete
 * my account and the Orders tab.
 * @module
 */
import { problem } from '@ss/app-kit';
import { checkAddresses, checkCustomValues, checkName, selfView } from '../core/profile.js';
import { CODE_ATTEMPTS } from '../core/rules.js';
import {
	generateRecoveryCodes,
	generateTotpSecret,
	randomSecret,
	safeEqual,
	sha256,
	totpUri,
	verifyPassword,
	verifyTotp,
} from '../adapters/crypto.js';
import { invalid } from './flows.js';
import { parseSecret } from './service.js';

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Service} Service */
/** @typedef {import('./flows.js').Flows} Flows */

/** @param {unknown} value */
const bodyOf = (value) => (typeof value === 'object' && value !== null ? /** @type {Record<string, any>} */ (value) : {});

/**
 * @param {Product} product
 * @param {Service} service
 * @param {Flows} flows
 */
export const createAccount = (product, service, flows) => {
	const { now, sealer } = product;

	/** @param {any} ctx */
	const me = async (ctx) => selfView((await service.signedIn(ctx)).user);

	/** Name, custom fields and addresses (e-mail and phone are sign-in addresses and change only by signing in). @param {any} ctx */
	const updateMe = async (ctx) => {
		const { s, user } = await service.signedIn(ctx);
		const body = bodyOf(ctx.body);
		/** @type {Record<string, unknown>} */
		const set = {};
		if (body.name !== undefined) {
			const name = checkName(body.name);
			if (name === null) throw invalid('name', 'The name is too long.');
			set.name = name;
		}
		if (body.custom !== undefined) {
			if (!s.on.includes('custom_fields')) throw problem('feature_off', 'Custom fields are off.');
			const checked = checkCustomValues(await s.store.fields.list(), body.custom, { complete: false, current: user.custom });
			if (!checked.ok) throw invalid(checked.field, checked.message);
			set.custom = checked.value;
		}
		if (body.addresses !== undefined) {
			const checked = checkAddresses(body.addresses, () => service.newAddressId());
			if (!checked.ok) throw invalid(checked.field, checked.message);
			set.addresses = checked.value;
		}
		return selfView((await s.store.users.update(user.id, set)) ?? user);
	};

	/** @param {any} ctx */
	const sessions = async (ctx) => {
		const { s, user, session } = await service.signedIn(ctx);
		return {
			items: (await s.store.sessions.ofUser(user.id)).map((x) => ({
				id: x.id,
				device: x.device,
				method: x.method,
				signedInAt: x.createdAt.toISOString(),
				lastUsedAt: x.lastUsedAt.toISOString(),
				current: x.id === session.id,
			})),
		};
	};

	/** @param {any} ctx */
	const signOutDevice = async (ctx) => {
		const { s, user } = await service.signedIn(ctx);
		if (!(await s.store.sessions.revoke(user.id, ctx.params.id))) throw problem('not_found', 'No such device.');
		return undefined;
	};

	/** Sign out of every device, this one too. @param {any} ctx */
	const signOutEverywhere = async (ctx) => {
		const { s, user } = await service.signedIn(ctx);
		await s.store.sessions.revokeAll(user.id);
		return undefined;
	};

	/** Set or change the password (the current one is asked when there is one). @param {any} ctx */
	const changePassword = async (ctx) => {
		const { s, user, session } = await service.signedIn(ctx);
		const body = bodyOf(ctx.body);
		if (!user.email) throw problem('validation_failed', 'Passwords go with an e-mail address.');
		if (user.passwordHash && (typeof body.current !== 'string' || !(await verifyPassword(body.current, user.passwordHash))))
			throw problem('sign_in_failed', 'The current password is wrong.');
		const passwordHash = await flows.newPassword(s, body.password);
		await s.store.users.update(user.id, { passwordHash });
		// the other devices sign in again
		for (const other of await s.store.sessions.ofUser(user.id))
			if (other.id !== session.id) await s.store.sessions.revoke(user.id, other.id);
		return undefined;
	};

	/** Two-step setup: a new secret, kept in a 10-minute step until a code confirms it. @param {any} ctx */
	const twoStepSetup = async (ctx) => {
		const { s, user } = await service.signedIn(ctx);
		if (user.twoStep?.enabledAt) throw problem('conflict', 'Two-step sign-in is already on.');
		const secret = generateTotpSecret();
		const challenge = randomSecret(32);
		const id = await s.store.codes.add({
			kind: 'step',
			target: user.id,
			hash: sha256(challenge),
			expireAt: new Date(now() + 10 * 60_000),
			data: { setup: sealer.seal(secret, service.totpAad(s.websiteId, user.id)), userId: user.id, enable: true },
			replace: true,
		});
		const business = (await product.business(s.websiteId)).name;
		return {
			challenge: `${id}.${challenge}`,
			secret,
			otpauthUrl: totpUri({ secret, issuer: business, account: user.email ?? user.phone ?? user.id }),
		};
	};

	/** @param {any} ctx */
	const twoStepEnable = async (ctx) => {
		const { s, user } = await service.signedIn(ctx);
		const body = bodyOf(ctx.body);
		const parsed = parseSecret(body.challenge);
		const record = parsed ? await s.store.codes.get(parsed.id) : null;
		if (
			!parsed ||
			!record ||
			record.kind !== 'step' ||
			record.target !== user.id ||
			!safeEqual(record.hash, sha256(parsed.secret))
		)
			throw problem('code_invalid', 'Start the setup again.');
		const secret = sealer.open(record.data.setup, service.totpAad(s.websiteId, user.id));
		const checked = secret ? verifyTotp(secret, body.code, { now: now(), lastStep: null }) : { ok: false };
		if (!checked.ok) {
			if ((await s.store.codes.attempt(record.id)) >= CODE_ATTEMPTS) await s.store.codes.consume(record.id);
			throw problem('code_invalid', 'The code is not valid.');
		}
		if (!(await s.store.codes.consume(record.id))) throw problem('code_invalid', 'Start the setup again.');
		const { codes, hashes } = generateRecoveryCodes();
		await s.store.users.update(user.id, {
			twoStep: {
				sealed: record.data.setup,
				lastStep: /** @type {{ step: number }} */ (checked).step,
				recovery: hashes,
				enabledAt: new Date(now()),
			},
		});
		return { recoveryCodes: codes };
	};

	/** Turn two-step off with a current code (refused when the user's role requires it). @param {any} ctx */
	const twoStepDisable = async (ctx) => {
		const { s, user } = await service.signedIn(ctx);
		const state = user.twoStep;
		if (!state?.enabledAt) return undefined;
		if ((await service.roleOf(s, user)).twoStep === 'required')
			throw problem('two_step_required', 'Your role requires two-step sign-in.');
		const secret = sealer.open(state.sealed, service.totpAad(s.websiteId, user.id));
		const checked = secret
			? verifyTotp(secret, bodyOf(ctx.body).code, { now: now(), lastStep: state.lastStep })
			: { ok: false };
		if (!checked.ok) throw problem('code_invalid', 'The code is not valid.');
		await s.store.users.update(user.id, { twoStep: null });
		return undefined;
	};

	/** Accept the current terms version. @param {any} ctx */
	const acceptTerms = async (ctx) => {
		const { s, user } = await service.signedIn(ctx);
		const { version } = await service.settings(s, 'terms');
		if (bodyOf(ctx.body).accept !== true) throw invalid('accept', 'Send { accept: true }.');
		return selfView((await s.store.users.update(user.id, { terms: { version, acceptedAt: new Date(now()) } })) ?? user);
	};

	/** Download my data: Accounts' records and every connected product's, as one single-use link (15 minutes). @param {any} ctx */
	const exportData = async (ctx) => {
		const { s, user } = await service.signedIn(ctx);
		return service.exportFor(s, ctx, user);
	};

	/** The download itself (the link's only delivery: single use, 15 minutes). @param {any} ctx */
	const download = async (ctx) => {
		const { websiteId, token } = ctx.params;
		const parsed = parseSecret(token);
		const serving = /^web_[0-9a-z]{10,64}$/.test(websiteId) ? await product.serving(websiteId) : null;
		if (!parsed || !serving?.ok) return problem('not_found', 'This link is not valid or has expired.');
		/** @type {import('@ss/app-kit').WebsiteData} */
		let data;
		try {
			data = await product.data.forWebsite(websiteId, { merchantId: serving.status.merchantId });
		} catch {
			return problem('not_found', 'This link is not valid or has expired.');
		}
		const s = await service.siteOf({ websiteId, merchantId: serving.status.merchantId, domain: '', base: '', data });
		const record = await service.takeSecret(s, token, 'export');
		if (!record) return problem('not_found', 'This link is not valid or has expired.');
		return new Response(String(record.data.json), {
			headers: {
				'content-type': 'application/json; charset=utf-8',
				'content-disposition': 'attachment; filename="my-data.json"',
				'cache-control': 'no-store',
			},
		});
	};

	/** Delete my account: waits for the merchant's approval, or for the days set in Settings. @param {any} ctx */
	const requestDeletion = async (ctx) => {
		const { s, user } = await service.signedIn(ctx);
		const { deleteAfterDays } = await service.settings(s, 'data_rights');
		const deletion = {
			requestedAt: new Date(now()),
			dueAt: deleteAfterDays > 0 ? new Date(now() + deleteAfterDays * 86_400_000) : null,
		};
		const updated = user.deletion ? user : await s.store.users.update(user.id, { deletion });
		return new Response(JSON.stringify(selfView(updated ?? user).deletion), {
			status: 202,
			headers: { 'content-type': 'application/json' },
		});
	};

	/**
	 * The Orders tab: the user's last 20 orders from Ecommerce, through the pasted Ecommerce token
	 * (`GET /v1/customers/<userId>/orders` → `{ items: [{ id, number, status, statusLabel, total, totalText, currency,
	 * createdAt }] }`), shown as given.
	 * @param {any} ctx
	 */
	const orders = async (ctx) => {
		const { s, user } = await service.signedIn(ctx);
		const answer = await product.callProduct(
			s.websiteId,
			'ecommerce',
			`/v1/customers/${encodeURIComponent(user.id)}/orders?limit=20`,
		);
		if (!answer.ok)
			throw problem(
				'product_not_connected',
				answer.reason === 'not_connected' ? 'Ecommerce not connected.' : 'Orders cannot be loaded right now.',
			);
		const items = bodyOf(answer.body).items;
		return { items: Array.isArray(items) ? items : [] };
	};

	return Object.freeze({
		me,
		updateMe,
		sessions,
		signOutDevice,
		signOutEverywhere,
		changePassword,
		twoStepSetup,
		twoStepEnable,
		twoStepDisable,
		acceptTerms,
		exportData,
		download,
		requestDeletion,
		orders,
	});
};
