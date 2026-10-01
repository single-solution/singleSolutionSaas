/**
 * The platform mailer (`ctx.mailer`): transactional mail the Portal itself sends — e-mail verification, password
 * resets, team invitations, staff account setup. It is a Portal concern, not a client connector: the SMTP account
 * is the operator's (`PLATFORM_SMTP_URL`, `PLATFORM_MAIL_FROM`).
 *
 * - SMTP via nodemailer: one pooled transport per Portal instance (created on first send), 10 s connection,
 *   greeting and socket timeouts, TLS ≥ 1.2 with certificate verification; in production a `smtp://` URL must
 *   upgrade with STARTTLS (`requireTLS`), so mail never leaves in clear text. File and URL access are disabled.
 * - Templates are plain text plus simple inline-styled HTML with no external assets (no images, fonts or
 *   trackers); every variable is HTML-escaped and links must be absolute http(s) URLs.
 * - Without SMTP: development and test use a logging mailer (the link is logged — never in production); production
 *   gets an unavailable mailer whose sends fail with 503, and flows that must send refuse up front (`available`).
 *
 * The interface (`{ available, send({ to, template, data }) }`) is the identity module's `Mailer` port.
 * @module
 */
import { problem } from './http.js';

/** @typedef {import('./logger.js').Logger} Logger */
/** @typedef {import('./config.js').SmtpConfig} SmtpConfig */

/**
 * @typedef {'verify_email' | 'account_exists' | 'password_reset' | 'invite' | 'staff_welcome'} MailTemplate
 *
 * @typedef {object} MailMessage
 * @property {string} to recipient address
 * @property {MailTemplate} template
 * @property {Record<string, string | null | undefined>} data template variables (`link`, `merchantName`)
 *
 * @typedef {object} Mailer
 * @property {boolean} available false when nothing can be sent (flows that must send answer 503)
 * @property {(message: MailMessage) => Promise<void>} send
 * @property {() => Promise<void>} [close] close pooled connections
 *
 * @typedef {{ subject: string, text: string, html: string }} RenderedMail
 *
 * @typedef {{ sendMail: (message: Record<string, unknown>) => Promise<unknown>, close: () => void }} Transport
 * @typedef {(options: Record<string, unknown>) => Transport | Promise<Transport>} TransportFactory
 */

const BRAND = 'Single Solution';
const TIMEOUT_MS = 10_000;
const ADDRESS =
	/^[^\s@<>()",;:\\[\]]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

/**
 * @param {string} text
 * @returns {string}
 */
export const escapeHtml = (text) =>
	text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * @typedef {object} TemplateSpec
 * @property {(d: Record<string, string>) => string} subject
 * @property {(d: Record<string, string>) => string[]} lines paragraphs before the button
 * @property {string} action button label
 * @property {string} footer paragraph after the button
 */

/** @type {Readonly<Record<MailTemplate, TemplateSpec>>} */
const TEMPLATES = Object.freeze({
	verify_email: {
		subject: () => `Confirm your e-mail address for ${BRAND}`,
		lines: (d) => [
			d.merchantName
				? `Confirm your e-mail address to finish creating the ${d.merchantName} account on ${BRAND}.`
				: `Confirm your e-mail address to finish creating your ${BRAND} account.`,
		],
		action: 'Confirm e-mail address',
		footer: 'The link expires soon and works once. If you did not sign up, ignore this message.',
	},
	account_exists: {
		subject: () => `Sign-in to ${BRAND}`,
		lines: () => [`Someone tried to sign up with this address, but it already has a ${BRAND} account.`],
		action: 'Sign in',
		footer: 'If you forgot your password, use "Forgot password" on the sign-in page. If this was not you, ignore this message.',
	},
	password_reset: {
		subject: () => `Reset your ${BRAND} password`,
		lines: () => ['We received a request to reset your password.'],
		action: 'Choose a new password',
		footer:
			'The link expires soon and works once. If you did not ask for a reset, ignore this message; your password is unchanged.',
	},
	invite: {
		subject: (d) => (d.merchantName ? `You are invited to ${d.merchantName} on ${BRAND}` : `You are invited to ${BRAND}`),
		lines: (d) => [
			d.merchantName
				? `You have been invited to join the ${d.merchantName} team on ${BRAND}.`
				: `You have been invited to ${BRAND}.`,
		],
		action: 'Accept invitation',
		footer: 'The invitation expires. If you did not expect it, ignore this message.',
	},
	staff_welcome: {
		subject: () => `Set up your ${BRAND} staff account`,
		lines: () => [
			`A ${BRAND} staff account was created for you.`,
			'Choose a password and enrol two-factor authentication to activate it.',
		],
		action: 'Set up account',
		footer: 'The link expires and works once. If you did not expect this, contact your administrator.',
	},
});

export const MAIL_TEMPLATES = Object.freeze(/** @type {MailTemplate[]} */ (Object.keys(TEMPLATES)));

/**
 * @param {unknown} link
 * @returns {string}
 */
const checkedLink = (link) => {
	if (typeof link !== 'string') throw new TypeError('mail data.link is required');
	/** @type {URL} */
	let url;
	try {
		url = new URL(link);
	} catch {
		throw new TypeError('mail data.link must be an absolute URL');
	}
	if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password)
		throw new TypeError('mail data.link must be an http(s) URL without credentials');
	return url.href;
};

/**
 * Render a template (pure).
 * @param {MailTemplate} template
 * @param {Record<string, string | null | undefined>} data
 * @returns {RenderedMail}
 */
export const renderMail = (template, data) => {
	if (!Object.hasOwn(TEMPLATES, template)) throw new TypeError(`unknown mail template: ${template}`);
	const spec = TEMPLATES[template];
	const link = checkedLink(data.link);
	/** @type {Record<string, string>} */
	const d = {};
	for (const [key, value] of Object.entries(data)) {
		// single line, bounded: values land in the subject too
		if (typeof value === 'string') d[key] = value.replace(/[\r\n\t]+/g, ' ').slice(0, 200);
	}
	const subject = spec.subject(d);
	const lines = spec.lines(d);
	const text = [...lines, '', `${spec.action}: ${link}`, '', spec.footer, '', `— ${BRAND}`].join('\n');
	const p = (/** @type {string} */ t) => `<p style="margin:0 0 16px">${escapeHtml(t)}</p>`;
	const html = [
		'<!doctype html><html><body style="margin:0;padding:24px;background:#f6f6f6;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a">',
		'<div style="max-width:560px;margin:0 auto;background:#ffffff;padding:32px;border-radius:8px">',
		`<p style="margin:0 0 24px;font-weight:bold;font-size:18px">${escapeHtml(BRAND)}</p>`,
		...lines.map(p),
		`<p style="margin:24px 0"><a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 20px;background:#1a1a1a;color:#ffffff;text-decoration:none;border-radius:6px">${escapeHtml(spec.action)}</a></p>`,
		`<p style="margin:0 0 16px;font-size:13px;color:#555555">If the button does not work, open this link: ${escapeHtml(link)}</p>`,
		`<p style="margin:0;font-size:13px;color:#555555">${escapeHtml(spec.footer)}</p>`,
		'</div></body></html>',
	].join('');
	return { subject, text, html };
};

/**
 * @param {unknown} to
 * @returns {string}
 */
const checkedRecipient = (to) => {
	if (typeof to !== 'string' || to.length > 254 || !ADDRESS.test(to)) throw new TypeError('mail recipient is invalid');
	return to;
};

/**
 * nodemailer transport options for an SMTP configuration.
 * @param {SmtpConfig} smtp
 * @param {{ isProduction: boolean }} options
 */
export const smtpTransportOptions = (smtp, { isProduction }) => ({
	pool: true,
	maxConnections: 3,
	maxMessages: 100,
	host: smtp.host,
	port: smtp.port,
	secure: smtp.secure,
	requireTLS: !smtp.secure && isProduction,
	...(smtp.user ? { auth: { user: smtp.user, pass: smtp.pass ?? '' } } : {}),
	tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true, servername: smtp.host },
	connectionTimeout: TIMEOUT_MS,
	greetingTimeout: TIMEOUT_MS,
	socketTimeout: TIMEOUT_MS,
	dnsTimeout: TIMEOUT_MS,
	disableFileAccess: true,
	disableUrlAccess: true,
});

/**
 * nodemailer, loaded on first send (it ships no type declarations).
 * @type {TransportFactory}
 */
const nodemailerTransport = (options) =>
	// @ts-expect-error -- nodemailer has no bundled types and @types/nodemailer is not a dependency
	import('nodemailer').then((/** @type {any} */ nodemailer) => (nodemailer.default ?? nodemailer).createTransport(options));

/**
 * SMTP mailer (pooled; the transport is created on first send).
 * @param {{ smtp: SmtpConfig, from: string, isProduction: boolean, logger: Logger, createTransport?: TransportFactory }} options
 * @returns {Mailer}
 */
export const createSmtpMailer = ({ smtp, from, isProduction, logger, createTransport = nodemailerTransport }) => {
	/** @type {Promise<Transport> | null} */
	let transport = null;
	const options = smtpTransportOptions(smtp, { isProduction });
	return Object.freeze({
		available: true,
		send: async ({ to, template, data }) => {
			const rendered = renderMail(template, data);
			const recipient = checkedRecipient(to);
			transport ??= Promise.resolve(createTransport(options));
			try {
				await (await transport).sendMail({ from, to: recipient, ...rendered });
			} catch (error) {
				// never log the data (links carry live tokens)
				logger.warn('mail delivery failed', { template, error });
				throw problem('unavailable', 'E-mail could not be sent.', { headers: { 'retry-after': '60' } });
			}
		},
		close: async () => {
			const current = transport;
			transport = null;
			if (current) (await current).close();
		},
	});
};

/**
 * Development mailer: logs the rendered text (including its one-time link). Never used in production.
 * @param {Logger} logger
 * @returns {Mailer}
 */
export const createLogMailer = (logger) =>
	Object.freeze({
		available: true,
		send: async ({ to, template, data }) => {
			const rendered = renderMail(template, data);
			logger.info('mail (development mailer)', { to: checkedRecipient(to), template, subject: rendered.subject, ...data });
		},
	});

/**
 * No mail transport: every send fails with 503.
 * @returns {Mailer}
 */
export const createUnavailableMailer = () =>
	Object.freeze({
		available: false,
		send: async () => {
			throw problem('unavailable', 'E-mail delivery is not configured.', { headers: { 'retry-after': '3600' } });
		},
	});

/**
 * The Portal's mailer for a configuration: SMTP when configured, else logging (development/test) or unavailable
 * (production and preview).
 * @param {{ config: Pick<import('./config.js').PortalConfig, 'env' | 'isProduction' | 'mail'>, logger: Logger, createTransport?: TransportFactory }} options
 * @returns {Mailer}
 */
export const createPlatformMailer = ({ config, logger, createTransport }) => {
	const { smtp, from } = config.mail;
	if (smtp && from)
		return createSmtpMailer({
			smtp,
			from,
			isProduction: config.isProduction,
			logger,
			...(createTransport ? { createTransport } : {}),
		});
	if (config.env === 'production' || config.env === 'preview') return createUnavailableMailer();
	return createLogMailer(logger);
};
