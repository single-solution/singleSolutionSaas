/**
 * My account (PLAN 0.8.6): what a signed-in user does with their own account through the browser token plus their
 * sign-in (`SS-Sign-In` header): profile and addresses, devices, password, two-step, consents, download my data, delete
 * my account and the Orders tab.
 * @module
 */
import { problem } from '@ss/app-kit';
import { constantTimeEqual, randomToken, sha256Hex } from '@ss/protocol';
import { checkCustomValues, checkName, selfView } from '../core/profile.js';
import { CODE_ATTEMPTS } from '../core/limits.js';
import { generateRecoveryCodes, generateTotpSecret, matchRecoveryCode, totpUri, verifyTotp } from '../adapters/crypto.js';
import { invalid } from './flows.js';
import { bodyOf, parseSecret } from './service.js';

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Service} Service */
/** @typedef {import('./flows.js').Flows} Flows */

/**
 * @param {Product} product
 * @param {Service} service
 * @param {Flows} flows
 */
export const createAccount = (product, service, flows) => {
	const { now, sealer } = product;

	/**
	 * The user as they see themselves, with their role's name while Roles is on and whether the role shows as a
	 * membership ("Member since", A4, A5).
	 * @param {import('./service.js').Site} s @param {import('../core/profile.js').UserRecord} user
	 */
	const meView = async (s, user) => {
		const role = s.on.includes('roles') ? await service.roleOf(s, user) : null;
		return {
			...selfView(user, await s.store.fields.list()),
			roleName: role?.name ?? null,
			membership: role?.membership === true,
		};
	};

	/** @param {any} ctx */
	const me = async (ctx) => {
		const { s, user } = await service.signedIn(ctx);
		return meView(s, user);
	};

	/** Name, custom fields and addresses (email and phone are sign-in addresses and change only by signing in). @param {any} ctx */
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
			const checked = checkCustomValues(await s.store.fields.list(), body.custom, {
				complete: false,
				current: user.custom,
				by: 'user',
			});
			if (!checked.ok) throw invalid(checked.field, checked.message);
			set.custom = checked.value;
		}
		if (body.addresses !== undefined) set.addresses = await service.addressesOf(s, body.addresses, user);
		return meView(s, (await s.store.users.update(user.id, set)) ?? user);
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

	/**
	 * Set or change the password (the current one is asked when there is one): users with an email address while Email
	 * + password is on, and users with a phone number while Phone + password is on (A2), each with that method's rules.
	 * @param {any} ctx
	 */
	const changePassword = async (ctx) => {
		const { s, user, session } = await service.signedIn(ctx);
		const body = bodyOf(ctx.body);
		const method = service.passwordMethodOf(s, user);
		if (!method) throw problem('validation_failed', 'Passwords go with an email address or a phone number.');
		if (user.passwordHash && (typeof body.current !== 'string' || !(await service.checkPassword(s, user, body.current))))
			throw problem('sign_in_failed', 'The current password is wrong.');
		const passwordHash = await flows.newPassword(s, body.password, { method, who: user });
		const changedAt = new Date(now());
		await s.store.users.update(user.id, { passwordHash, passwordChangedAt: changedAt });
		// this device stays signed in; the other devices sign in again
		await s.store.sessions.keep(session.id, changedAt);
		for (const other of await s.store.sessions.ofUser(user.id))
			if (other.id !== session.id) await s.store.sessions.revoke(user.id, other.id);
		return undefined;
	};

	/**
	 * Two-step setup: a new secret, kept in a 10-minute step until a code confirms it. Two-step that is on counts as not
	 * set up when its secret no longer opens (`ENCRYPTION_KEY` lost, ST-18): the user, signed in with a recovery code,
	 * sets it up again.
	 * @param {any} ctx
	 */
	const twoStepSetup = async (ctx) => {
		const { s, user } = await service.signedIn(ctx);
		if (user.twoStep?.enabledAt && sealer.open(user.twoStep.sealed, service.totpAad(s.websiteId, user.id)) !== null)
			throw problem('conflict', 'Two-step sign-in is already on.');
		const secret = generateTotpSecret();
		const challenge = randomToken(32);
		const id = await s.store.codes.add({
			kind: 'step',
			target: user.id,
			hash: sha256Hex(challenge),
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
			!constantTimeEqual(record.hash, sha256Hex(parsed.secret))
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
				recovery: hashes.map((hash) => ({ hash, format: 'v1' })),
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

	/**
	 * New recovery codes (K-27): the old ones stop working and the new ones are shown once. The user proves the second
	 * step again with a code from the authenticator app or one of their recovery codes (someone who lost the phone gets
	 * new codes with one of the old). Wrong codes count toward the lock as at sign-in, and the route is refused while
	 * the lock lasts.
	 * @param {any} ctx
	 */
	const newRecoveryCodes = async (ctx) => {
		const { s, user, session } = await service.signedIn(ctx);
		const state = user.twoStep;
		if (!state?.enabledAt) throw problem('conflict', 'Two-step sign-in is off.');
		if (user.lockedUntil && user.lockedUntil.getTime() > now())
			throw problem('locked', 'Too many wrong tries. Try again later.', {
				extensions: { lockedUntil: user.lockedUntil.toISOString() },
			});
		const body = bodyOf(ctx.body);
		/** @type {number | null | undefined} the authenticator step now used up; undefined: the code is wrong */
		let step;
		if (typeof body.recoveryCode === 'string')
			step = matchRecoveryCode(body.recoveryCode, state.recovery) >= 0 ? state.lastStep : undefined;
		else {
			const secret = sealer.open(state.sealed, service.totpAad(s.websiteId, user.id));
			const checked = secret ? verifyTotp(secret, body.code, { now: now(), lastStep: state.lastStep }) : null;
			step = checked?.ok ? checked.step : undefined;
		}
		if (step === undefined) {
			await flows.countFailure(s, user, session.method);
			throw problem('code_invalid', 'The code is not valid.');
		}
		const { codes, hashes } = generateRecoveryCodes();
		await s.store.users.update(user.id, {
			'twoStep.recovery': hashes.map((hash) => ({ hash, format: 'v1' })),
			'twoStep.lastStep': step,
		});
		await service.logSignIn(s, user, 'user.recovery_codes_replaced', { codes: codes.length });
		return { recoveryCodes: codes };
	};

	/**
	 * Give or withdraw consents (A2): `{ consents: { [key]: true | false } }`, each recorded in its current version with
	 * the time; a required agreement cannot be withdrawn. Answers the user as `GET /v1/me` does.
	 * @param {any} ctx
	 */
	const saveConsents = async (ctx) => {
		const { s, user } = await service.signedIn(ctx);
		const answers = bodyOf(ctx.body).consents;
		if (typeof answers !== 'object' || answers === null)
			throw invalid('consents', 'Send { consents: { key: true or false } }.');
		const next = await service.consentsFor(s, user.consents ?? {}, answers, { ask: false });
		return meView(s, (await s.store.users.update(user.id, { consents: next })) ?? user);
	};

	/** Download my data: Accounts' records and every connected product's, as one single-use link (15 minutes). @param {any} ctx */
	const exportData = async (ctx) => {
		const { s, user } = await service.signedIn(ctx);
		return service.exportFor(s, user);
	};

	/** The download itself (the link's only delivery: single use, 15 minutes). @param {any} ctx */
	const download = async (ctx) => {
		const { websiteId, token } = ctx.params;
		const parsed = parseSecret(token);
		const serving = /^web_[0-9a-z]{10,64}$/.test(websiteId) ? await product.serving(websiteId, { after: ctx.after }) : null;
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
		return new Response(JSON.stringify(selfView(updated ?? user, []).deletion), {
			status: 202,
			headers: { 'content-type': 'application/json' },
		});
	};

	/**
	 * The Orders tab: the user's last 20 orders from Ecommerce, through the pasted Ecommerce token
	 * (`GET /v1/customers/<userId>/orders` → `{ items: [{ id, number, status, statusLabel, total, totalText, currency,
	 * createdAt }] }`), answered as given (`total` in minor units; the widget shows it in this website's Format).
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
		newRecoveryCodes,
		saveConsents,
		exportData,
		download,
		requestDeletion,
		orders,
	});
};
