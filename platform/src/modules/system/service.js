/**
 * Public service of the `system` module (other modules reach it with `ctx.service('system')`): Settings (PLAN 0.8.2:
 * e-mail sending, branding, support contact, security), the public branding, Activity (PLAN 0.5.12) and the admin
 * Overview. Every Settings change is written to Activity.
 * @module
 */
import { MAIL_FROM, SETTINGS_BOUNDS } from '../../infra/config.js';
import { problem } from '../../infra/http.js';
import { createSmtpMailer } from '../../infra/mailer.js';
import { LOGO_MAX_BYTES, LOGO_TYPES } from '../../infra/system.js';
import { createActivity } from './activity.js';

/** @typedef {import('../../infra/modules.js').ModuleContext} ModuleContext */
/** @typedef {import('../../infra/rbac.js').Actor} Actor */
/** @typedef {{ path: string, message: string }} FieldError */

const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;
const ACCENT = /^#[0-9a-fA-F]{6}$/;
const PHONE = /^[0-9+()\-.\s]{3,40}$/;

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
	if (v.length > max || [...v].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)) return { ok: false };
	return { ok: true, value: v };
};

/**
 * @param {ModuleContext} ctx
 */
export const createSystemService = (ctx) => {
	/** @returns {import('../../infra/system.js').SystemStore} */
	const system = () => {
		if (!ctx.system) throw problem('unavailable', 'The Portal settings store is not available.');
		return ctx.system;
	};
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
		const doc = await system().settings();
		const state = (await system().load()).state;
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
						passwordUnreadable: Boolean(mail.passSealed) && !system().passwordReadable(mail.passSealed),
					}
				: null,
			security: { ...ctx.config.settings.security, ...(state.settings?.security ?? {}) },
			branding: { ...ctx.config.settings.branding, ...(state.settings?.branding ?? {}) },
			support: { ...ctx.config.settings.support, ...(state.settings?.support ?? {}) },
			billing: { ...ctx.config.settings.billing, ...(state.settings?.billing ?? {}) },
			bounds: SETTINGS_BOUNDS,
			version: doc?.version ?? 0,
		};
	};

	const activity = createActivity(ctx);

	return {
		settings,

		/**
		 * Set or clear e-mail sending (SMTP host, port, user, password, sender name and address). The password is sealed
		 * with `ENCRYPTION_KEY`; omit it to keep the stored one.
		 * @param {{ mail: unknown, actor: Actor, requestId: string, ip: string | null }} input
		 */
		setMail: async ({ mail, actor, requestId, ip }) => {
			if (mail === null) {
				await system().update({ mail: null });
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
			const address = typeof input.senderAddress === 'string' ? input.senderAddress.trim() : '';
			if (!EMAIL.test(address) || address.length > 254)
				errors.push({ path: '/senderAddress', message: 'must be an e-mail address' });
			const name = optionalLine(input.senderName, 100);
			if (!name.ok || (name.value ?? '').includes('<'))
				errors.push({ path: '/senderName', message: 'must be 1..100 characters' });
			const from = name.ok && name.value ? `${name.value} <${address}>` : address;
			if (errors.length === 0 && !MAIL_FROM.test(from))
				errors.push({ path: '/senderAddress', message: 'must be an e-mail address' });
			refuse(errors, 'The e-mail settings are invalid.');
			await system().update({ mail: { host, port, secure, user, ...(pass === undefined ? {} : { pass }), from } });
			await record(actor, 'mail', {
				after: { host, port, secure, password: pass === undefined ? 'kept' : pass ? 'set' : 'removed' },
				requestId,
				ip,
			});
			return settings();
		},

		/**
		 * Send test e-mail: to the signed-in admin, with the stored settings (not waiting for other instances to notice).
		 * @param {{ actor: Actor, requestId: string, ip: string | null }} input
		 */
		sendTestMail: async ({ actor, requestId, ip }) => {
			const { state } = await system().load();
			if (!state.mail) throw problem('conflict', 'Set e-mail sending up first.');
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
				context: () => ({ brand: ctx.config.settings.branding.name, support: ctx.config.settings.support }),
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
			if (!ACCENT.test(accent)) errors.push({ path: '/accent', message: 'must be a colour such as #4f46e5' });
			refuse(errors, 'The branding is invalid.');
			await system().update({ branding: { name: /** @type {string} */ (name.ok ? name.value : ''), accent } });
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
				await system().setLogo(null);
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
			await system().setLogo({ type, data: /** @type {Buffer} */ (data) });
			await record(actor, 'branding_logo', { after: { logo: 'set', type, bytes: data?.length ?? 0 }, requestId, ip });
			return settings();
		},

		/**
		 * Support contact: e-mail, phone and optional WhatsApp.
		 * @param {{ body: unknown, actor: Actor, requestId: string, ip: string | null }} input
		 */
		setSupport: async ({ body, actor, requestId, ip }) => {
			const input = objectOf(body);
			/** @type {FieldError[]} */
			const errors = [];
			const email = optionalLine(input.email, 254);
			if (!email.ok || (email.value && !EMAIL.test(email.value)))
				errors.push({ path: '/email', message: 'must be an e-mail address' });
			const phone = optionalLine(input.phone, 40);
			if (!phone.ok || (phone.value && !PHONE.test(phone.value)))
				errors.push({ path: '/phone', message: 'must be a phone number with country code' });
			const whatsapp = optionalLine(input.whatsapp, 40);
			if (!whatsapp.ok || (whatsapp.value && !PHONE.test(whatsapp.value)))
				errors.push({ path: '/whatsapp', message: 'must be a phone number with country code' });
			refuse(errors, 'The support contact is invalid.');
			const support = {
				email: email.ok ? email.value : null,
				phone: phone.ok ? phone.value : null,
				whatsapp: whatsapp.ok ? whatsapp.value : null,
			};
			await system().update({ support });
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
			await system().update({ security });
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
			await system().update({ billing });
			await record(actor, 'billing', { after: billing, requestId, ip });
			return settings();
		},

		/** What sign-in pages, consoles and e-mails show: the Branding and the support contact. */
		publicBranding: async () => {
			const { branding, support } = ctx.config.settings;
			return {
				name: branding.name,
				accent: branding.accent,
				logoUrl: branding.hasLogo ? `${ctx.config.portalUrl}/branding/logo?v=${branding.logoVersion}` : null,
				support,
			};
		},

		/** The Branding logo as an image response (404 when none). */
		logoResponse: async () => {
			const logo = await system().logo();
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
		 * Admin Overview: counts, the e-mail warning (PLAN 0.5.10), recent activity and the per-product numbers (PLAN
		 * 0.8.2: for each connected product, the websites using it and the credits it earned this month, with the last
		 * 30 UTC days).
		 */
		overview: async () => {
			const names = ctx.moduleNames();
			const connected = names.includes('catalog') ? await ctx.service('catalog').listProducts() : [];
			/** @type {Map<string, Record<string, any>>} */
			const numbers = new Map(
				(names.includes('commerce') ? await ctx.service('commerce').allProductNumbers() : []).map(
					(/** @type {Record<string, any>} */ n) => [String(n.productId), n],
				),
			);
			return {
				mailConfigured: Boolean(ctx.config.mail.smtp),
				...(await ctx.service('identity').counts()),
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
