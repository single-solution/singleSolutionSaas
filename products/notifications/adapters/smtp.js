/**
 * SMTP e-mail adapter (moved here from the kit, PLAN 0.12 step 6): sends e-mail through the merchant's own SMTP server
 * with nodemailer, using the merchant's `email` connection.
 *
 * - **Value**: `{ baseUrl: 'smtps://host:465' | 'smtp://host:587', username, apiKey (the password), from? }`. The
 *   explicit form `{ host, port?, secure?, username, password }` is accepted too. `smtps://` (or port 465) means implicit TLS. `smtp://` means STARTTLS, which is required.
 * - **TLS** is required (implicit TLS, or `requireTLS` STARTTLS) and certificates are verified against the host name,
 *   TLS 1.2 or later. Only hosts on the development allowlist (the outbound policy's `allowHosts`, emptied by app-kit in
 *   production) may talk plain SMTP.
 * - **SSRF:** the host is checked up front (`@ss/net` `checkHost`, ports 25/465/587/2525 unless allowlisted). Each
 *   send resolves the host once through `resolveVetted` (every DNS answer classified) and connects to the vetted IP,
 *   with the host name as TLS `servername`, so there is no second resolution between the check and the connection.
 * - **Timeouts:** connection 10 s, greeting 10 s, socket 30 s by default.
 * - **Header injection:** addresses, the subject and extra headers must not contain CR/LF; reserved headers cannot be
 *   overridden. nodemailer never reads files or URLs for content (`disableFileAccess`, `disableUrlAccess`).
 * - Errors are `kitError('timeout' | 'upstream_error', …)` with `details: { reason, responseCode? }` only — never
 *   credentials or the server's reply text.
 * @module
 */
import { checkHost, isNetError, resolveVetted } from '@ss/net';
import { isObject, providerError as kitError } from './util.js';

/** Ports SMTP may use for hosts that are not allowlisted. */
export const SMTP_PORTS = Object.freeze([25, 465, 587, 2525]);

const DEFAULT_TIMEOUTS = Object.freeze({ connectionMs: 10_000, greetingMs: 10_000, socketMs: 30_000 });
const MAX_RECIPIENTS = 50;
const MAX_BODY = 1024 * 1024;
const ADDRESS = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const DISPLAY = /^([^<>\r\n"\\]{0,128}?)\s*<([^<>\s]+)>$/;
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const RESERVED_HEADERS = new Set([
	'from',
	'to',
	'cc',
	'bcc',
	'sender',
	'reply-to',
	'subject',
	'date',
	'message-id',
	'return-path',
	'mime-version',
	'content-type',
	'content-transfer-encoding',
	'content-disposition',
	'received',
	'dkim-signature',
]);

/**
 * The nodemailer transport options this adapter builds.
 * @typedef {object} SmtpTransportOptions
 * @property {string} host the vetted IP address to connect to
 * @property {number} port
 * @property {boolean} secure implicit TLS
 * @property {boolean} requireTLS STARTTLS required
 * @property {string} [servername]
 * @property {{ user: string, pass: string }} auth
 * @property {{ servername?: string, minVersion: 'TLSv1.2', rejectUnauthorized: true }} tls
 * @property {number} connectionTimeout
 * @property {number} greetingTimeout
 * @property {number} socketTimeout
 * @property {false} pool
 */
/**
 * A nodemailer-compatible transport (the subset this adapter uses).
 * @typedef {{ sendMail: (mail: Record<string, unknown>) => Promise<{ messageId?: string, accepted?: unknown[], rejected?: unknown[] }>,
 *   verify?: () => Promise<unknown>, close?: () => void }} SmtpTransport
 */
/** @typedef {(options: SmtpTransportOptions) => SmtpTransport | Promise<SmtpTransport>} CreateSmtpTransport */

/**
 * @typedef {object} SmtpMessage
 * @property {string | string[]} to one address or up to 50
 * @property {string} subject
 * @property {string} [text]
 * @property {string} [html]
 * @property {string} [from] `addr@host` or `Name <addr@host>`; default the descriptor's `from`, else the username
 * @property {string} [replyTo]
 * @property {Record<string, string>} [headers] extra headers (no reserved names, no CR/LF)
 */

/** @type {CreateSmtpTransport} */
const nodemailerTransport = (options) =>
	import('nodemailer').then((/** @type {any} */ mod) => (mod.default ?? mod).createTransport(options));

/**
 * @param {unknown} value
 * @returns {value is string}
 */
const isAddress = (value) => typeof value === 'string' && value.length <= 320 && ADDRESS.test(value);

/**
 * `addr` or `Name <addr>`, without CR/LF.
 * @param {unknown} value
 * @returns {boolean}
 */
const isMailbox = (value) => {
	if (typeof value !== 'string' || value.length > 400 || /[\r\n]/.test(value)) return false;
	if (isAddress(value)) return true;
	const match = DISPLAY.exec(value);
	return match !== null && isAddress(match[2]);
};

/**
 * Normalised connection settings of an SMTP descriptor.
 * @param {Record<string, unknown>} descriptor
 * @param {import('@ss/net').OutboundPolicy} policy
 * @returns {{ host: string, port: number, secure: boolean, allowlisted: boolean, ip: boolean, username: string,
 *   password: string, from?: string }}
 */
export const smtpSettingsOf = (descriptor, policy) => {
	/** @type {string | undefined} */
	let host;
	/** @type {number | undefined} */
	let port;
	/** @type {boolean | undefined} */
	let secure;
	const url = descriptor.baseUrl ?? descriptor.url;
	if (url !== undefined) {
		/** @type {URL} */
		let parsed;
		try {
			parsed = new URL(String(url));
		} catch {
			throw kitError('connection_invalid', 'smtp connection url is not valid');
		}
		if (parsed.protocol !== 'smtp:' && parsed.protocol !== 'smtps:')
			throw kitError('connection_invalid', 'smtp connection url must be smtp:// or smtps://');
		if (parsed.username !== '' || parsed.password !== '')
			throw kitError('connection_invalid', 'smtp connection url must not carry credentials');
		if ((parsed.pathname !== '' && parsed.pathname !== '/') || parsed.search !== '' || parsed.hash !== '')
			throw kitError('connection_invalid', 'smtp connection url must be plain');
		host = parsed.hostname.replace(/^\[|\]$/g, '');
		secure = parsed.protocol === 'smtps:';
		port = parsed.port === '' ? (secure ? 465 : 587) : Number(parsed.port);
	} else {
		if (typeof descriptor.host !== 'string') throw kitError('connection_invalid', 'smtp connection needs a host');
		host = descriptor.host;
		if (descriptor.secure !== undefined && typeof descriptor.secure !== 'boolean')
			throw kitError('connection_invalid', 'smtp connection secure must be a boolean');
		if (descriptor.port !== undefined && !Number.isInteger(descriptor.port))
			throw kitError('connection_invalid', 'smtp connection port must be an integer');
		port = /** @type {number | undefined} */ (descriptor.port);
		secure = /** @type {boolean | undefined} */ (descriptor.secure) ?? (port === undefined || port === 465);
		port ??= secure ? 465 : 587;
	}
	if (!Number.isInteger(port) || port < 1 || port > 65_535) throw kitError('connection_invalid', 'smtp port is not valid');
	const checked = checkHost(host, policy);
	if (!checked.ok) throw kitError('connection_invalid', `smtp host refused (${checked.reason})`);
	if (!checked.allowlisted && !SMTP_PORTS.includes(port)) throw kitError('connection_invalid', 'smtp host refused (port)');
	const username = descriptor.username ?? descriptor.user;
	const password = descriptor.password ?? descriptor.apiKey;
	if (typeof username !== 'string' || username === '' || typeof password !== 'string' || password === '')
		throw kitError('connection_invalid', 'smtp connection needs username and password');
	if (descriptor.from !== undefined && !isMailbox(descriptor.from))
		throw kitError('connection_invalid', 'smtp connection from is not a valid address');
	return {
		host: checked.host,
		port,
		secure,
		allowlisted: checked.allowlisted,
		ip: checked.ip,
		username,
		password,
		...(typeof descriptor.from === 'string' ? { from: descriptor.from } : {}),
	};
};

/**
 * Validate a message and build the nodemailer mail object.
 * @param {unknown} message
 * @param {string | undefined} defaultFrom
 * @returns {Record<string, unknown>}
 */
const mailOf = (message, defaultFrom) => {
	if (!isObject(message)) throw kitError('invalid_argument', 'message must be an object');
	const to = Array.isArray(message.to) ? message.to : [message.to];
	if (to.length === 0 || to.length > MAX_RECIPIENTS || !to.every(isAddress))
		throw kitError('invalid_argument', `message.to must be 1..${MAX_RECIPIENTS} e-mail addresses`);
	const { subject, text, html, replyTo, headers } = message;
	if (typeof subject !== 'string' || subject.length === 0 || subject.length > 998 || /[\r\n]/.test(subject))
		throw kitError('invalid_argument', 'message.subject must be 1..998 characters on one line');
	if (text === undefined && html === undefined) throw kitError('invalid_argument', 'message needs text or html');
	for (const [name, value] of /** @type {const} */ ([
		['text', text],
		['html', html],
	])) {
		if (value !== undefined && (typeof value !== 'string' || value.length > MAX_BODY))
			throw kitError('invalid_argument', `message.${name} must be a string up to 1 MiB`);
	}
	const from = message.from ?? defaultFrom;
	if (!isMailbox(from)) throw kitError('invalid_argument', 'message.from must be an e-mail address');
	if (replyTo !== undefined && !isMailbox(replyTo))
		throw kitError('invalid_argument', 'message.replyTo must be an e-mail address');
	/** @type {Record<string, string>} */
	const extra = {};
	if (headers !== undefined) {
		if (!isObject(headers) || Object.keys(headers).length > 20)
			throw kitError('invalid_argument', 'message.headers must be an object of up to 20 headers');
		for (const [name, value] of Object.entries(headers)) {
			if (!HEADER_NAME.test(name) || RESERVED_HEADERS.has(name.toLowerCase()))
				throw kitError('invalid_argument', 'message.headers has a reserved or invalid name');
			if (typeof value !== 'string' || value.length > 998 || /[\r\n\0]/.test(value))
				throw kitError('invalid_argument', 'message.headers values must be single-line strings');
			extra[name] = value;
		}
	}
	return {
		from,
		to,
		subject,
		...(text === undefined ? {} : { text }),
		...(html === undefined ? {} : { html }),
		...(replyTo === undefined ? {} : { replyTo }),
		...(Object.keys(extra).length > 0 ? { headers: extra } : {}),
		disableFileAccess: true,
		disableUrlAccess: true,
	};
};

/**
 * @param {unknown} list
 * @returns {string[]}
 */
const addressesOf = (list) =>
	Array.isArray(list)
		? list.map((entry) => (typeof entry === 'string' ? entry : String(/** @type {any} */ (entry)?.address ?? '')))
		: [];

/**
 * @param {{ descriptor: Record<string, unknown>, policy: import('@ss/net').OutboundPolicy,
 *   createTransport?: CreateSmtpTransport, timeouts?: { connectionMs?: number, greetingMs?: number, socketMs?: number } }} options
 *   `createTransport` replaces nodemailer's (tests); `timeouts` in milliseconds
 */
export const createSmtpMessaging = ({ descriptor, policy, createTransport = nodemailerTransport, timeouts = {} }) => {
	const s = smtpSettingsOf(descriptor, policy);
	const t = { ...DEFAULT_TIMEOUTS, ...timeouts };
	const defaultFrom = s.from ?? (isAddress(s.username) ? s.username : undefined);
	// plain SMTP only for allowlisted development hosts; everyone else uses implicit TLS or required STARTTLS
	const requireTLS = !s.secure && !s.allowlisted;

	/**
	 * @param {unknown} error
	 * @returns {never}
	 */
	const fail = (error) => {
		const code = isNetError(error) ? error.code : String(/** @type {{ code?: unknown }} */ (error)?.code ?? 'ESMTP');
		const responseCode = /** @type {{ responseCode?: unknown }} */ (error)?.responseCode;
		const timeout = code === 'timeout' || code === 'ETIMEDOUT';
		throw kitError(timeout ? 'timeout' : 'upstream_error', 'smtp delivery failed', {
			reason: code,
			...(typeof responseCode === 'number' ? { responseCode } : {}),
		});
	};

	/**
	 * Open a transport to the vetted address and run `use` with it; the transport is always closed.
	 * @template T
	 * @param {(transport: SmtpTransport) => Promise<T>} use
	 * @returns {Promise<T>}
	 */
	const withTransport = async (use) => {
		/** @type {string} */
		let address;
		try {
			address = s.ip ? s.host : /** @type {{ address: string }} */ ((await resolveVetted(policy, s.host))[0]).address;
		} catch (error) {
			return fail(error);
		}
		const servername = s.ip ? undefined : s.host;
		/** @type {SmtpTransport | undefined} */
		let transport;
		try {
			transport = await createTransport({
				host: address,
				port: s.port,
				secure: s.secure,
				requireTLS,
				...(servername ? { servername } : {}),
				auth: { user: s.username, pass: s.password },
				tls: { ...(servername ? { servername } : {}), minVersion: 'TLSv1.2', rejectUnauthorized: true },
				connectionTimeout: t.connectionMs,
				greetingTimeout: t.greetingMs,
				socketTimeout: t.socketMs,
				pool: false,
			});
			return await use(transport);
		} catch (error) {
			return fail(error);
		} finally {
			transport?.close?.();
		}
	};

	return Object.freeze({
		kind: 'messaging',
		provider: 'smtp',
		/**
		 * Send one e-mail.
		 * @param {SmtpMessage} message
		 * @returns {Promise<{ id: string | null, accepted: string[], rejected: string[] }>}
		 */
		send: async (message) => {
			const mail = mailOf(message, defaultFrom);
			return withTransport(async (transport) => {
				const info = await transport.sendMail(mail);
				return {
					id: typeof info?.messageId === 'string' ? info.messageId : null,
					accepted: addressesOf(info?.accepted),
					rejected: addressesOf(info?.rejected),
				};
			});
		},
		/**
		 * Sign in to the server without sending (the connection test): nodemailer's `verify`, when the transport has it.
		 * @returns {Promise<true>}
		 */
		verify: () =>
			withTransport(async (transport) => {
				if (transport.verify) await transport.verify();
				return /** @type {const} */ (true);
			}),
	});
};
