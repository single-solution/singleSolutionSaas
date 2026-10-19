/**
 * Public service of the `system` module (other modules reach it with `ctx.service('system')`): Settings (PLAN 0.8.2:
 * email sending, branding, support contact, security), the public branding, Activity (PLAN 0.5.12) and the admin
 * Overview. Every Settings change is written to Activity.
 * @module
 */
import { LOGO_MAX_BYTES, LOGO_TYPES } from '../../infra/branding.js';
import { MAIL_FROM, SETTINGS_BOUNDS, logoUrlOf } from '../../infra/config.js';
import { sumCounts } from '../../infra/crypto.js';
import { problem } from '../../infra/http.js';
import { createSmtpMailer, mailContextOf } from '../../infra/mailer.js';
import { normalizeEmail } from '@ss/contracts/email';
import { SUPPORT_CHANNELS_MAX, supportChannelProblem, supportChannelUrl } from '@ss/contracts/text';
import { hasControlCharacters } from '../../infra/util.js';
import { createActivity } from './activity.js';

/** @typedef {import('../../infra/modules.js').ModuleContext} ModuleContext */
/** @typedef {import('../../infra/rbac.js').Actor} Actor */
/** @typedef {{ path: string, message: string }} FieldError */

const ACCENT = /^#[0-9a-fA-F]{6}$/;

/**
 * @param {FieldError[]} errors
 * @param {string} title
 */
const refuse = (errors, title) => {
	if (errors.length > 0) throw problem('validation_failed', title, { errors });
};

/**
 * @param {unknown} body
 * @returns {Record<string, unknown>}
 */
const objectOf = (body) =>
	typeof body === 'object' && body !== null && !Array.isArray(body) ? /** @type {Record<string, unknown>} */ (body) : {};

/**
 * Optional single-line text: '' or null clears it.
 * @param {unknown} value
 * @param {number} max
 * @returns {{ ok: true, value: string | null } | { ok: false }}
 */
const optionalLine = (value, max) => {
	if (value === null || value === undefined || value === '') return { ok: true, value: null };
	if (typeof value !== 'string') return { ok: false };
	const v = value.trim();
	if (v.length === 0) return { ok: true, value: null };
	if (v.length > max || hasControlCharacters(v)) return { ok: false };
	return { ok: true, value: v };
};

/**
 * @param {ModuleContext} ctx
 */
export const createSystemService = (ctx) => {
	const system = ctx.system;
	/**
	 * @param {Actor} actor
	 * @param {string} setting
	 * @param {{ after?: unknown, requestId: string, ip: string | null }} input
	 */
	const record = (actor, setting, { after, requestId, ip }) =>
		ctx.audit.record({
			actor: { type: 'admin', id: actor.id, name: actor.name ?? null },
			action: 'settings.changed',
			target: { type: 'setting', id: setting },
			...(after === undefined ? {} : { after }),
			requestId,
			ip,
		});

	/** The settings as the Settings screen shows them (never the SMTP password). */
	const settings = async () => {
		const doc = await system.settings();
		const state = (await system.load()).state;
		const mail = doc?.mail ?? null;
		const from = mail ? /^(.*) <([^>]+)>$/.exec(mail.from) : null;
		return {
			mail: mail
				? {
						host: mail.host,
						port: mail.port,
						secure: mail.secure,
						user: mail.user,
						senderName: from ? (from[1] ?? null) : null,
						senderAddress: from ? (from[2] ?? mail.from) : mail.from,
						hasPassword: Boolean(mail.passSealed),
						// sealed under another ENCRYPTION_KEY: the Owner enters it again (PLAN 0.4.8)
						passwordUnreadable: Boolean(mail.passSealed) && !system.passwordReadable(mail.passSealed),
					}
				: null,
			security: { ...ctx.config.settings.security, ...(state.settings?.security ?? {}) },
			branding: { ...ctx.config.settings.branding, ...(state.settings?.branding ?? {}) },
			support: { ...ctx.config.settings.support, ...(state.settings?.support ?? {}) },
			billing: { ...ctx.config.settings.billing, ...(state.settings?.billing ?? {}) },
			bounds: SETTINGS_BOUNDS,
		};
	};

	const activity = createActivity(ctx);

	return {
		settings,

		/**
		 * Settings → Encryption key → Re-seal (PLAN 0.4.8, 0.11; RT-14): after the owner changes `ENCRYPTION_KEY` (the old
		 * key set as `ENCRYPTION_KEY_PREVIOUS`), every stored secret is sealed again with the current key — the signing
		 * keys, the SMTP password, server tokens, two-step secrets, the websites' database, storage and AI key connections and the link tokens. Values already on it stay; values neither key opens are counted
		 * and left alone, and `unreadableIn` names the parts they are in (`signingKeys`, `mailPassword`, `serverTokens`,
		 * `twoStep`, `websiteConnections`, `linkTokens`) with how many, so the Owner knows what to type or make again. Pressing again is safe. Written to
		 * Activity.
		 * @param {{ actor: Actor, requestId: string, ip: string | null }} input
		 */
		reseal: async ({ actor, requestId, ip }) => {
			const parts = {
				...(await system.reseal()),
				...(await ctx.service('identity').resealSecrets()),
				...(await ctx.service('website').resealSecrets()),
			};
			const counts = sumCounts(Object.values(parts));
			const unreadableIn = Object.fromEntries(
				Object.entries(parts)
					.filter(([, part]) => part.unreadable > 0)
					.map(([name, part]) => [name, part.unreadable]),
			);
			const result = { keyId: ctx.secretBox.keyId, previousKeyId: ctx.secretBox.previousKeyId, ...counts, unreadableIn };
			await record(actor, 'encryption_key', { after: { resealed: result }, requestId, ip });
			return result;
		},

		/**
		 * Set or clear email sending (SMTP host, port, user, password, sender name and address). The password is sealed
		 * with `ENCRYPTION_KEY`; omit it to keep the stored one.
		 * @param {{ mail: unknown, actor: Actor, requestId: string, ip: string | null }} input
		 */
		setMail: async ({ mail, actor, requestId, ip }) => {
			if (mail === null) {
				await system.update({ mail: null });
				await record(actor, 'mail', { after: { mail: 'removed' }, requestId, ip });
				return settings();
			}
			const input = objectOf(mail);
			/** @type {FieldError[]} */
			const errors = [];
			const host = typeof input.host === 'string' ? input.host.trim() : '';
			if (!/^[A-Za-z0-9.-]{1,253}$/.test(host)) errors.push({ path: '/host', message: 'must be a host name' });
			const port = Number(input.port ?? 587);
			if (!Number.isInteger(port) || port < 1 || port > 65_535) errors.push({ path: '/port', message: 'must be a port' });
			const secure = input.secure === true || (input.secure === undefined && port === 465);
			const user = typeof input.user === 'string' && input.user.trim() !== '' ? input.user.trim().slice(0, 320) : null;
			const pass =
				input.password === undefined
					? undefined
					: typeof input.password === 'string' && input.password !== ''
						? input.password
						: null;
			if (typeof pass === 'string' && pass.length > 1024) errors.push({ path: '/password', message: 'is too long' });
			const address = normalizeEmail(input.senderAddress) ?? '';
			if (address === '') errors.push({ path: '/senderAddress', message: 'must be an email address' });
			const name = optionalLine(input.senderName, 100);
			if (!name.ok || (name.value ?? '').includes('<'))
				errors.push({ path: '/senderName', message: 'must be 1..100 characters' });
			const from = name.ok && name.value ? `${name.value} <${address}>` : address;
			if (errors.length === 0 && !MAIL_FROM.test(from))
				errors.push({ path: '/senderAddress', message: 'must be an email address' });
			refuse(errors, 'The email settings are invalid.');
			await system.update({ mail: { host, port, secure, user, ...(pass === undefined ? {} : { pass }), from } });
			await record(actor, 'mail', {
				after: { host, port, secure, password: pass === undefined ? 'kept' : pass ? 'set' : 'removed' },
				requestId,
				ip,
			});
			return settings();
		},

		/**
		 * Send test email: to the signed-in admin, with the stored settings (not waiting for other instances to notice).
		 * @param {{ actor: Actor, requestId: string, ip: string | null }} input
		 */
		sendTestMail: async ({ actor, requestId, ip }) => {
			const { state } = await system.load();
			if (!state.mail) throw problem('conflict', 'Set email sending up first.');
			const admin = await ctx.service('identity').getAdmin(actor.id);
			const mailer = createSmtpMailer({
				smtp: {
					host: state.mail.host,
					port: state.mail.port,
					secure: state.mail.secure,
					user: state.mail.user,
					pass: state.mail.pass,
				},
				from: state.mail.from,
				isProduction: ctx.config.isProduction,
				logger: ctx.logger,
				context: mailContextOf(ctx.config.settings),
			});
			try {
				await mailer.send({ to: admin.email, template: 'test_email', data: {} });
			} finally {
				await mailer.close?.();
			}
			await record(actor, 'mail_test', { requestId, ip });
			return { sentTo: admin.email };
		},

		/**
		 * Branding name and accent (PLAN 0.8.2 Branding).
		 * @param {{ body: unknown, actor: Actor, requestId: string, ip: string | null }} input
		 */
		setBranding: async ({ body, actor, requestId, ip }) => {
			const input = objectOf(body);
			/** @type {FieldError[]} */
			const errors = [];
			const name = optionalLine(input.name, 60);
			if (!name.ok || !name.value) errors.push({ path: '/name', message: 'must be 1..60 characters' });
			const accent = typeof input.accent === 'string' ? input.accent.trim().toLowerCase() : '';
			if (!ACCENT.test(accent)) errors.push({ path: '/accent', message: 'must be a color such as #2226f7' });
			refuse(errors, 'The branding is invalid.');
			await system.update({ branding: { name: /** @type {string} */ (name.ok ? name.value : ''), accent } });
			await record(actor, 'branding', { after: { name: name.ok ? name.value : null, accent }, requestId, ip });
			return settings();
		},

		/**
		 * Upload (or remove, `null`) the Branding logo: PNG, JPEG or WebP, at most 200 kB, never SVG; checked by its
		 * magic bytes, not only its declared type.
		 * @param {{ logo: unknown, actor: Actor, requestId: string, ip: string | null }} input
		 */
		setLogo: async ({ logo, actor, requestId, ip }) => {
			if (logo === null) {
				await system.setLogo(null);
				await record(actor, 'branding_logo', { after: { logo: 'removed' }, requestId, ip });
				return settings();
			}
			const input = objectOf(logo);
			const type = typeof input.type === 'string' ? input.type : '';
			const data =
				typeof input.data === 'string' && /^[A-Za-z0-9+/]+=*$/.test(input.data) ? Buffer.from(input.data, 'base64') : null;
			/** @type {FieldError[]} */
			const errors = [];
			if (!LOGO_TYPES.includes(type)) errors.push({ path: '/type', message: 'must be image/png, image/jpeg or image/webp' });
			if (!data || data.length === 0) errors.push({ path: '/data', message: 'must be the base64 file' });
			else if (data.length > LOGO_MAX_BYTES) errors.push({ path: '/data', message: 'must be at most 200 kB' });
			else if (!magicMatches(type, data)) errors.push({ path: '/data', message: 'is not a PNG, JPEG or WebP file' });
			refuse(errors, 'The logo is invalid.');
			await system.setLogo({ type, data: /** @type {Buffer} */ (data) });
			await record(actor, 'branding_logo', { after: { logo: 'set', type, bytes: data?.length ?? 0 }, requestId, ip });
			return settings();
		},

		/**
		 * Support contact (fixed-choices audit K10): `{ channels: [{ type, label, url }] }`, at most
		 * `SUPPORT_CHANNELS_MAX`, in the order people see them. `type` is `email`, `phone` or `link`; `url` may be typed
		 * as people write it (an address, a number with its country code, an https link) and is kept as `mailto:`,
		 * `tel:+…` or the link; `label` is the operator's own ("WhatsApp", "Help center"). An empty list removes the
		 * contact.
		 * @param {{ body: unknown, actor: Actor, requestId: string, ip: string | null }} input
		 */
		setSupport: async ({ body, actor, requestId, ip }) => {
			const input = objectOf(body);
			/** @type {FieldError[]} */
			const errors = Object.keys(input)
				.filter((key) => key !== 'channels')
				.map((key) => ({ path: `/${key}`, message: 'is not a support setting' }));
			const given = Array.isArray(input.channels) ? input.channels : null;
			if (given === null) errors.push({ path: '/channels', message: 'must be a list' });
			else if (given.length > SUPPORT_CHANNELS_MAX)
				errors.push({ path: '/channels', message: `must have at most ${SUPPORT_CHANNELS_MAX} channels` });
			/** @type {import('@ss/contracts/text').SupportChannel[]} */
			const channels = [];
			for (const [index, raw] of (given ?? []).entries()) {
				const entry = objectOf(raw);
				const type = typeof entry.type === 'string' ? entry.type : '';
				const label = typeof entry.label === 'string' ? entry.label.trim() : '';
				const url = supportChannelUrl(type, typeof entry.url === 'string' ? entry.url : '');
				const channel = { type, label, url: url ?? String(entry.url ?? '') };
				const wrong = hasControlCharacters(label) ? 'label must be plain text' : supportChannelProblem(channel);
				if (wrong) errors.push({ path: `/channels/${index}`, message: wrong });
				else channels.push(/** @type {import('@ss/contracts/text').SupportChannel} */ (channel));
			}
			refuse(errors, 'The support contact is invalid.');
			const support = { channels };
			await system.update({ support });
			await record(actor, 'support', { requestId, ip });
			return settings();
		},

		/**
		 * Security: Session length (whole hours) and Require two-step for admins.
		 * @param {{ body: unknown, actor: Actor, requestId: string, ip: string | null }} input
		 */
		setSecurity: async ({ body, actor, requestId, ip }) => {
			const input = objectOf(body);
			const { min, max } = SETTINGS_BOUNDS.sessionHours;
			/** @type {FieldError[]} */
			const errors = [];
			const hours = input.sessionHours;
			if (!Number.isInteger(hours) || /** @type {number} */ (hours) < min || /** @type {number} */ (hours) > max)
				errors.push({ path: '/sessionHours', message: `must be a whole number of hours ${min}..${max}` });
			if (typeof input.requireTwoStepForAdmins !== 'boolean')
				errors.push({ path: '/requireTwoStepForAdmins', message: 'must be true or false' });
			refuse(errors, 'The security settings are invalid.');
			const security = {
				sessionHours: /** @type {number} */ (hours),
				requireTwoStepForAdmins: /** @type {boolean} */ (input.requireTwoStepForAdmins),
			};
			await system.update({ security });
			await record(actor, 'security', { after: security, requestId, ip });
			return settings();
		},

		/**
		 * Billing rules (PLAN 0.5.4): grace days 0–30 and the low-balance threshold 1–30 days of spend, whole days. A
		 * change applies to grace periods that start later.
		 * @param {{ body: unknown, actor: Actor, requestId: string, ip: string | null }} input
		 */
		setBilling: async ({ body, actor, requestId, ip }) => {
			const input = objectOf(body);
			/** @type {FieldError[]} */
			const errors = [];
			for (const name of /** @type {const} */ (['graceDays', 'lowBalanceDays'])) {
				const { min, max } = SETTINGS_BOUNDS[name];
				const value = input[name];
				if (!Number.isInteger(value) || /** @type {number} */ (value) < min || /** @type {number} */ (value) > max)
					errors.push({ path: `/${name}`, message: `must be a whole number of days ${min}..${max}` });
			}
			refuse(errors, 'The billing rules are invalid.');
			const billing = {
				graceDays: /** @type {number} */ (input.graceDays),
				lowBalanceDays: /** @type {number} */ (input.lowBalanceDays),
			};
			await system.update({ billing });
			await record(actor, 'billing', { after: billing, requestId, ip });
			return settings();
		},

		/** What sign-in pages, consoles and emails show: the Branding and the support contact. */
		publicBranding: async () => {
			const { branding, support } = ctx.config.settings;
			return {
				name: branding.name,
				accent: branding.accent,
				logoUrl: logoUrlOf(ctx.config.portalUrl, branding),
				support,
			};
		},

		/** The Branding logo as an image response (404 when none). */
		logoResponse: async () => {
			const logo = await system.logo();
			if (!logo) return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } });
			return new Response(new Uint8Array(logo.data), {
				status: 200,
				headers: {
					'content-type': logo.type,
					'cache-control': 'public, max-age=300',
					'x-content-type-options': 'nosniff',
					'content-security-policy': "default-src 'none'",
				},
			});
		},

		/**
		 * Admin Overview: counts, the credits added this UTC month (every receipt, summed in the database), the email
		 * warning (PLAN 0.5.10), recent activity and the per-product numbers (PLAN 0.8.2: for each connected product, the
		 * websites using it and the credits it earned this month, with the last 30 UTC days).
		 */
		overview: async () => {
			const connected = await ctx.service('catalog').listProducts();
			const commerce = ctx.service('commerce');
			/** @type {Map<string, Record<string, any>>} */
			const numbers = new Map(
				(await commerce.allProductNumbers()).map((/** @type {Record<string, any>} */ n) => [String(n.productId), n]),
			);
			return {
				mailConfigured: Boolean(ctx.config.mail.smtp),
				...(await ctx.service('identity').counts()),
				creditsAddedThisMonth: await commerce.creditsAddedThisMonth(),
				products: connected.map((/** @type {Record<string, any>} */ p) => ({
					productId: p.productId,
					name: p.name,
					status: p.status,
					websites: numbers.get(p.productId)?.websites ?? 0,
					earnedThisMonth: numbers.get(p.productId)?.earnedThisMonth ?? 0,
					days: numbers.get(p.productId)?.days ?? [],
				})),
				recentActivity: (await activity.list({ viewer: { type: 'admin' }, limit: 10, before: null })).items,
			};
		},

		activity,
	};
};

/**
 * The file's first bytes match its declared image type (PNG, JPEG, WebP).
 * @param {string} type
 * @param {Buffer} data
 */
const magicMatches = (type, data) => {
	if (type === 'image/png') return data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
	if (type === 'image/jpeg') return data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
	if (type === 'image/webp')
		return data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP';
	return false;
};
/** @typedef {ReturnType<typeof createSystemService>} SystemService */
