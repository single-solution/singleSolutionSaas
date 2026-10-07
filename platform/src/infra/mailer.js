/**
 * The platform mailer (`ctx.mailer`): the e-mails the Portal itself sends (PLAN 0.5.10) — merchant setup links, admin
 * invites, password resets, login e-mail changes, two-step turned off by an Owner and the test e-mail. The SMTP
 * account is the one an Owner sets in Settings → E-mail sending.
 *
 * - SMTP via nodemailer: one pooled transport per Portal instance (created on first send), 10 s connection,
 *   greeting and socket timeouts, TLS ≥ 1.2 with certificate verification; in production a `smtp://` URL must
 *   upgrade with STARTTLS (`requireTLS`), so mail never leaves in clear text. File and URL access are disabled.
 * - Texts live in `src/texts/mail.js`: plain text plus simple inline-styled HTML with no external assets; every
 *   variable is HTML-escaped and links must be absolute http(s) URLs. Every e-mail carries the Branding name and the
 *   support contact.
 * - Without SMTP settings e-mails are skipped (`available: false`; setup links can still be copied) and admin Overview
 *   shows a warning. Development and test log instead (the link is logged — never in production).
 * @module
 */
import { problem } from './http.js';
import { MAIL_TEXTS, supportLine } from '../texts/mail.js';

/** @typedef {import('./logger.js').Logger} Logger */
/** @typedef {import('./config.js').SmtpConfig} SmtpConfig */

/**
 * @typedef {keyof typeof MAIL_TEXTS} MailTemplate
 *
 * @typedef {object} MailMessage
 * @property {string} to recipient address
 * @property {MailTemplate} template
 * @property {Record<string, string | null | undefined>} data template variables (`link`, `merchantName`, …)
 *
 * @typedef {object} Mailer
 * @property {boolean} available false when nothing can be sent (the e-mail is skipped)
 * @property {(message: MailMessage) => Promise<void>} send
 * @property {() => Promise<void>} [close] close pooled connections
 *
 * @typedef {{ subject: string, text: string, html: string }} RenderedMail
 * @typedef {{ brand: string, support: { email: string | null, phone: string | null, whatsapp: string | null } }} MailContext
 *
 * @typedef {{ sendMail: (message: Record<string, unknown>) => Promise<unknown>, close: () => void }} Transport
 * @typedef {(options: Record<string, unknown>) => Transport | Promise<Transport>} TransportFactory
 */

const TIMEOUT_MS = 10_000;
const ADDRESS =
	/^[^\s@<>()",;:\\[\]]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
/** @type {MailContext} */
const DEFAULT_CONTEXT = Object.freeze({ brand: 'Single Solution', support: { email: null, phone: null, whatsapp: null } });

/**
 * @param {string} text
 * @returns {string}
 */
export const escapeHtml = (text) =>
	text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export const MAIL_TEMPLATES = Object.freeze(/** @type {MailTemplate[]} */ (Object.keys(MAIL_TEXTS)));

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
 * @param {MailContext} [context] Branding name and support contact
 * @returns {RenderedMail}
 */
export const renderMail = (template, data, context = DEFAULT_CONTEXT) => {
	if (!Object.hasOwn(MAIL_TEXTS, template)) throw new TypeError(`unknown mail template: ${template}`);
	const spec = /** @type {import('../texts/mail.js').MailText} */ (MAIL_TEXTS[template]);
	const link = spec.action ? checkedLink(data.link) : null;
	/** @type {Record<string, string>} */
	const d = { brand: context.brand };
	for (const [key, value] of Object.entries(data)) {
		// single line, bounded: values land in the subject too
		if (typeof value === 'string') d[key] = value.replace(/[\r\n\t]+/g, ' ').slice(0, 200);
	}
	d.brand = context.brand.replace(/[\r\n\t]+/g, ' ').slice(0, 60);
	const subject = spec.subject(d);
	const lines = spec.lines(d);
	const support = supportLine(context.support);
	const text = [
		...lines,
		...(link && spec.action ? ['', `${spec.action}: ${link}`] : []),
		'',
		spec.footer,
		...(support ? ['', support] : []),
		'',
		`— ${d.brand}`,
	].join('\n');
	const p = (/** @type {string} */ t) => `<p style="margin:0 0 16px">${escapeHtml(t)}</p>`;
	const html = [
		'<!doctype html><html><body style="margin:0;padding:24px;background:#f6f6f6;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a">',
		'<div style="max-width:560px;margin:0 auto;background:#ffffff;padding:32px;border-radius:8px">',
		`<p style="margin:0 0 24px;font-weight:bold;font-size:18px">${escapeHtml(d.brand)}</p>`,
		...lines.map(p),
		...(link && spec.action
			? [
					`<p style="margin:24px 0"><a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 20px;background:#1a1a1a;color:#ffffff;text-decoration:none;border-radius:6px">${escapeHtml(spec.action)}</a></p>`,
					`<p style="margin:0 0 16px;font-size:13px;color:#555555">If the button does not work, open this link: ${escapeHtml(link)}</p>`,
				]
			: []),
		`<p style="margin:0 0 16px;font-size:13px;color:#555555">${escapeHtml(spec.footer)}</p>`,
		...(support ? [`<p style="margin:0;font-size:13px;color:#555555">${escapeHtml(support)}</p>`] : []),
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
	import('nodemailer').then((/** @type {any} */ nodemailer) => (nodemailer.default ?? nodemailer).createTransport(options));

/**
 * SMTP mailer (pooled; the transport is created on first send).
 * @param {{ smtp: SmtpConfig, from: string, isProduction: boolean, logger: Logger, createTransport?: TransportFactory,
 *   context?: () => MailContext }} options
 * @returns {Mailer}
 */
export const createSmtpMailer = ({ smtp, from, isProduction, logger, createTransport = nodemailerTransport, context }) => {
	/** @type {Promise<Transport> | null} */
	let transport = null;
	const options = smtpTransportOptions(smtp, { isProduction });
	return Object.freeze({
		available: true,
		send: async ({ to, template, data }) => {
			const rendered = renderMail(template, data, context?.() ?? DEFAULT_CONTEXT);
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
 * @param {() => MailContext} [context]
 * @returns {Mailer}
 */
export const createLogMailer = (logger, context) =>
	Object.freeze({
		available: true,
		send: async ({ to, template, data }) => {
			const rendered = renderMail(template, data, context?.() ?? DEFAULT_CONTEXT);
			logger.info('mail (development mailer)', { to: checkedRecipient(to), template, subject: rendered.subject, ...data });
		},
	});

/**
 * No mail transport (production without SMTP settings): callers skip e-mails (`available: false`); a send anyway
 * fails with 503.
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
 * @param {{ config: Pick<import('./config.js').PortalConfig, 'env' | 'isProduction' | 'mail'> & { settings?: import('./config.js').PortalSettings },
 *   logger: Logger, createTransport?: TransportFactory }} options
 * @returns {Mailer}
 */
export const createPlatformMailer = ({ config, logger, createTransport }) => {
	const { smtp, from } = config.mail;
	/** @returns {MailContext} */
	const context = () => ({
		brand: config.settings?.branding.name ?? DEFAULT_CONTEXT.brand,
		support: config.settings?.support ?? DEFAULT_CONTEXT.support,
	});
	if (smtp && from)
		return createSmtpMailer({
			smtp,
			from,
			isProduction: config.isProduction,
			logger,
			context,
			...(createTransport ? { createTransport } : {}),
		});
	if (config.env === 'production') return createUnavailableMailer();
	return createLogMailer(logger, context);
};
