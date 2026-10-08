/**
 * Messaging providers (PLAN 0.8.5), with the merchant's own keys from Connections. Every call goes through the
 * outbound `send` (`@ss/net` `safeFetch` under the product's policy: https only, every DNS answer vetted, no
 * redirects); SMTP through the SMTP adapter. Credentials never appear in errors or logs.
 *
 * Connection values (flat fields; the secret is always `secret`, so screens show its last 4 characters):
 * - `email`: `smtp` `{ host, port?, secure?, username, secret, from }` · `resend` / `sendgrid` `{ secret, from }` ·
 *   `mailgun` `{ domain, region: us | eu, secret, from }` · `ses` `{ region, accessKeyId, secret, from }`
 * - `sms`: `twilio` `{ accountSid, secret, from }` · `http` (below)
 * - `whatsapp`: `meta` `{ phoneNumberId, secret, appSecret?, verifyToken? }` · `twilio` `{ accountSid, secret, from }` ·
 *   `http` (below)
 * - `http` (any gateway, e.g. Connectivity.pk or a local SMS gateway): `{ url, contentType: json | form, headers?
 *   (JSON object text), body (template), secret? }`. In `headers` and `body`, `{to}` (international number),
 *   `{toDigits}` (digits only), `{text}` and `{secret}` are filled, encoded for the content type.
 * @module
 */
import { checkUrl, isNetError, signV4 } from '@ss/net';
import { gatewayOutcome } from '../core/gateway.js';
import { createSmtpMessaging } from './smtp.js';
import { isObject } from './util.js';

/** @typedef {import('@ss/app-kit').RequestContext} RequestContext */
/** @typedef {import('../core/gateway.js').SendOutcome} SendOutcome */
/** @typedef {(url: string, init?: import('@ss/net').SafeFetchInit) => Promise<import('@ss/net').SafeResponse>} OutboundSend */
/** @typedef {Record<string, string | number | boolean>} ProviderValue */
/**
 * One message for a provider.
 * @typedef {object} ProviderMessage
 * @property {string} to e-mail address or international phone number
 * @property {string} subject e-mail only
 * @property {string} text
 * @property {string[]} parameters WhatsApp provider templates: body parameters
 * @property {string} providerTemplate WhatsApp: approved Meta template name (`''` = plain text)
 * @property {string} language the template's language (`''` = default)
 * @property {string} [replyTo] e-mail
 * @property {Record<string, string>} [headers] e-mail headers (List-Unsubscribe)
 */

/** Graph API version for WhatsApp Cloud API calls. */
export const META_API_VERSION = 'v21.0';
/** Timeout of one provider call. */
export const PROVIDER_TIMEOUT_MS = 15_000;

/** Providers each connection may use. */
export const PROVIDERS = Object.freeze({
	email: Object.freeze(['smtp', 'resend', 'sendgrid', 'mailgun', 'ses']),
	sms: Object.freeze(['twilio', 'http']),
	whatsapp: Object.freeze(['meta', 'twilio', 'http']),
});

/** Fields each provider needs (all strings unless the check says otherwise). */
const REQUIRED = Object.freeze({
	smtp: ['host', 'username', 'secret', 'from'],
	resend: ['secret', 'from'],
	sendgrid: ['secret', 'from'],
	mailgun: ['domain', 'secret', 'from'],
	ses: ['region', 'accessKeyId', 'secret', 'from'],
	twilio: ['accountSid', 'secret', 'from'],
	meta: ['phoneNumberId', 'secret'],
	http: ['url', 'body'],
});

const MAILBOX = /^(?:[^<>\r\n"\\]{0,128}<[^\s@<>]+@[^\s@<>]+>|[^\s@<>]+@[^\s@<>]+)$/;

/**
 * Why a provider connection value is not usable, or null.
 * @param {'email' | 'sms' | 'whatsapp'} name
 * @param {unknown} value
 * @returns {string | null}
 */
export const providerViolation = (name, value) => {
	if (!isObject(value) || typeof value.provider !== 'string' || !PROVIDERS[name].includes(value.provider))
		return `Pick a provider: ${PROVIDERS[name].join(', ')}.`;
	const provider = /** @type {keyof typeof REQUIRED} */ (value.provider);
	const missing = REQUIRED[provider].filter((field) => typeof value[field] !== 'string' || value[field].trim() === '');
	if (missing.length > 0) return `Fill in: ${missing.join(', ')}.`;
	if (name === 'email' && !MAILBOX.test(String(value.from))) return 'from must be an e-mail address or Name <address>.';
	if (provider === 'mailgun' && value.region !== undefined && value.region !== 'us' && value.region !== 'eu')
		return 'region must be us or eu.';
	if (provider === 'ses' && !/^[a-z]{2}(-[a-z]+)+-\d$/.test(String(value.region))) return 'region must be an AWS region.';
	if (provider === 'meta' && !/^\d{5,20}$/.test(String(value.phoneNumberId))) return 'phoneNumberId must be digits.';
	if (provider === 'twilio' && !/^AC[0-9a-f]{32}$/i.test(String(value.accountSid))) return 'accountSid starts with AC.';
	if (provider === 'http') {
		if (!/^https:\/\/\S+$/.test(String(value.url))) return 'url must be an https address.';
		if (value.contentType !== undefined && value.contentType !== 'json' && value.contentType !== 'form')
			return 'contentType must be json or form.';
		if (value.headers !== undefined && headersOf(value.headers) === null)
			return 'headers must be a JSON object of text values.';
	}
	return null;
};

/**
 * Extra headers of a generic gateway (JSON object text), or null when invalid.
 * @param {unknown} text
 * @returns {Record<string, string> | null}
 */
const headersOf = (text) => {
	if (text === undefined || text === '') return {};
	try {
		const parsed = JSON.parse(String(text));
		if (!isObject(parsed) || Object.keys(parsed).length > 20) return null;
		const entries = Object.entries(parsed);
		return entries.every(([key, v]) => /^[A-Za-z0-9-]{1,64}$/.test(key) && typeof v === 'string' && !/[\r\n]/.test(v))
			? Object.fromEntries(entries)
			: null;
	} catch {
		return null;
	}
};

/**
 * Fill a gateway template: `{to}`, `{toDigits}`, `{text}` and `{secret}`, each encoded by `encode`.
 * @param {string} template
 * @param {Record<string, string>} values
 * @param {(value: string) => string} encode
 */
const fillGateway = (template, values, encode) =>
	template.replace(/\{(to|toDigits|text|secret)\}/g, (_, name) => encode(values[name] ?? ''));

/** @param {string} value text inside a JSON string literal */
const jsonInner = (value) => JSON.stringify(value).slice(1, -1);

/**
 * @param {{ send: OutboundSend, policy: import('@ss/net').OutboundPolicy, now: () => number,
 *   createTransport?: import('./smtp.js').CreateSmtpTransport }} options
 */
export const createProviders = ({ send, policy, now, createTransport }) => {
	/**
	 * One HTTP call to a provider, as a send outcome.
	 * @param {string} url
	 * @param {{ method?: string, headers?: Record<string, string>, body?: string }} init
	 * @returns {Promise<SendOutcome>}
	 */
	const call = async (url, { method = 'POST', headers = {}, body } = {}) => {
		try {
			const response = await send(url, {
				method,
				headers: { accept: 'application/json', ...headers },
				...(body === undefined ? {} : { body }),
				timeoutMs: PROVIDER_TIMEOUT_MS,
				redirect: 'error',
			});
			return gatewayOutcome(response.status, response.body.toString('utf8'));
		} catch (error) {
			const reason = isNetError(error) ? error.code : 'network';
			return { ok: false, error: `The provider could not be reached (${reason}).`, retryable: reason !== 'ssrf_blocked' };
		}
	};

	/** @param {string} user @param {string} password */
	const basic = (user, password) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

	/** @param {Record<string, string>} fields */
	const form = (fields) => new URLSearchParams(fields).toString();

	/**
	 * Send an e-mail.
	 * @param {ProviderValue} v
	 * @param {ProviderMessage} m
	 * @returns {Promise<SendOutcome>}
	 */
	const email = async (v, m) => {
		const from = String(v.from);
		const secret = String(v.secret);
		const headers = m.headers ?? {};
		if (v.provider === 'smtp') {
			try {
				const smtp = createSmtpMessaging({
					descriptor: { ...v, password: secret },
					policy,
					...(createTransport ? { createTransport } : {}),
				});
				const info = await smtp.send({
					to: m.to,
					from,
					subject: m.subject,
					text: m.text,
					...(m.replyTo ? { replyTo: m.replyTo } : {}),
					...(Object.keys(headers).length > 0 ? { headers } : {}),
				});
				return { ok: true, id: info.id };
			} catch (error) {
				const code = /** @type {{ code?: string }} */ (error).code;
				return {
					ok: false,
					error: error instanceof Error ? error.message : 'smtp delivery failed',
					retryable: code === 'timeout' || code === 'upstream_error',
				};
			}
		}
		if (v.provider === 'resend')
			return call('https://api.resend.com/emails', {
				headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
				body: JSON.stringify({
					from,
					to: [m.to],
					subject: m.subject,
					text: m.text,
					...(m.replyTo ? { reply_to: m.replyTo } : {}),
					...(Object.keys(headers).length > 0 ? { headers } : {}),
				}),
			});
		if (v.provider === 'sendgrid') {
			const match = /^(.*?)\s*<([^>]+)>$/.exec(from);
			return call('https://api.sendgrid.com/v3/mail/send', {
				headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
				body: JSON.stringify({
					personalizations: [{ to: [{ email: m.to }] }],
					from: match ? { email: match[2], ...(match[1] ? { name: match[1] } : {}) } : { email: from },
					subject: m.subject,
					content: [{ type: 'text/plain', value: m.text }],
					...(m.replyTo ? { reply_to: { email: m.replyTo } } : {}),
					...(Object.keys(headers).length > 0 ? { headers } : {}),
				}),
			});
		}
		if (v.provider === 'mailgun') {
			const host = v.region === 'eu' ? 'api.eu.mailgun.net' : 'api.mailgun.net';
			/** @type {Record<string, string>} */
			const fields = { from, to: m.to, subject: m.subject, text: m.text };
			if (m.replyTo) fields['h:Reply-To'] = m.replyTo;
			for (const [name, val] of Object.entries(headers)) fields[`h:${name}`] = val;
			return call(`https://${host}/v3/${encodeURIComponent(String(v.domain))}/messages`, {
				headers: { authorization: basic('api', secret), 'content-type': 'application/x-www-form-urlencoded' },
				body: form(fields),
			});
		}
		// Amazon SES (API v2, SigV4)
		const url = `https://email.${v.region}.amazonaws.com/v2/email/outbound-emails`;
		const body = JSON.stringify({
			FromEmailAddress: from,
			Destination: { ToAddresses: [m.to] },
			...(m.replyTo ? { ReplyToAddresses: [m.replyTo] } : {}),
			Content: {
				Simple: {
					Subject: { Data: m.subject, Charset: 'UTF-8' },
					Body: { Text: { Data: m.text, Charset: 'UTF-8' } },
					...(Object.keys(headers).length > 0
						? { Headers: Object.entries(headers).map(([Name, Value]) => ({ Name, Value })) }
						: {}),
				},
			},
		});
		const signed = signV4({
			method: 'POST',
			url,
			headers: { 'content-type': 'application/json' },
			body,
			region: String(v.region),
			service: 'ses',
			accessKeyId: String(v.accessKeyId),
			secretAccessKey: secret,
			now: now(),
			contentSha256Header: false,
		});
		return call(url, { headers: signed, body });
	};

	/**
	 * Send through a generic HTTP gateway.
	 * @param {ProviderValue} v
	 * @param {ProviderMessage} m
	 * @returns {Promise<SendOutcome>}
	 */
	const gateway = async (v, m) => {
		const values = { to: m.to, toDigits: m.to.replace(/\D/g, ''), text: m.text, secret: String(v.secret ?? '') };
		const json = v.contentType !== 'form';
		const extra = Object.fromEntries(
			Object.entries(headersOf(v.headers) ?? {}).map(([name, val]) => [name.toLowerCase(), fillGateway(val, values, String)]),
		);
		return call(String(v.url), {
			headers: { 'content-type': json ? 'application/json' : 'application/x-www-form-urlencoded', ...extra },
			body: fillGateway(String(v.body), values, json ? jsonInner : encodeURIComponent),
		});
	};

	/**
	 * Send through Twilio (SMS, or WhatsApp with the `whatsapp:` prefix).
	 * @param {ProviderValue} v
	 * @param {ProviderMessage} m
	 * @param {boolean} whatsapp
	 */
	const twilio = (v, m, whatsapp) => {
		const sid = String(v.accountSid);
		const from = String(v.from);
		const prefix = whatsapp ? 'whatsapp:' : '';
		/** @type {Record<string, string>} */
		const fields = { To: `${prefix}${m.to}`, Body: m.text };
		if (!whatsapp && /^MG[0-9a-f]{32}$/i.test(from)) fields.MessagingServiceSid = from;
		else fields.From = `${prefix}${from}`;
		return call(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
			headers: { authorization: basic(sid, String(v.secret)), 'content-type': 'application/x-www-form-urlencoded' },
			body: form(fields),
		});
	};

	/**
	 * Send through the WhatsApp Cloud API: plain text, or an approved template with the values as body parameters.
	 * @param {ProviderValue} v
	 * @param {ProviderMessage} m
	 */
	const meta = (v, m) =>
		call(`https://graph.facebook.com/${META_API_VERSION}/${encodeURIComponent(String(v.phoneNumberId))}/messages`, {
			headers: { authorization: `Bearer ${String(v.secret)}`, 'content-type': 'application/json' },
			body: JSON.stringify({
				messaging_product: 'whatsapp',
				to: m.to.replace(/\D/g, ''),
				...(m.providerTemplate
					? {
							type: 'template',
							template: {
								name: m.providerTemplate,
								language: { code: m.language || 'en' },
								...(m.parameters.length > 0
									? { components: [{ type: 'body', parameters: m.parameters.map((text) => ({ type: 'text', text })) }] }
									: {}),
							},
						}
					: { type: 'text', text: { body: m.text } }),
			}),
		});

	/**
	 * Send one message through the channel's connection value.
	 * @param {'email' | 'sms' | 'whatsapp'} channel
	 * @param {ProviderValue} value
	 * @param {ProviderMessage} message
	 * @returns {Promise<SendOutcome & { provider: string }>}
	 */
	const sendMessage = async (channel, value, message) => {
		const provider = String(value.provider);
		const violation = providerViolation(channel, value);
		if (violation)
			return { ok: false, error: `The ${channel} connection is not usable: ${violation}`, retryable: false, provider };
		/** @type {SendOutcome} */
		let outcome;
		if (channel === 'email') outcome = await email(value, message);
		else if (provider === 'http') outcome = await gateway(value, message);
		else if (provider === 'twilio') outcome = await twilio(value, message, channel === 'whatsapp');
		else outcome = await meta(value, message);
		return { ...outcome, provider };
	};

	/**
	 * Test a provider connection live without sending a message: each provider's read-only account call, SMTP sign-in;
	 * generic gateways cannot be checked without sending, so only their address is checked.
	 * @param {'email' | 'sms' | 'whatsapp'} name
	 * @param {unknown} value
	 * @returns {Promise<{ ok: boolean, message?: string }>}
	 */
	const test = async (name, value) => {
		const violation = providerViolation(name, value);
		if (violation) return { ok: false, message: violation };
		const v = /** @type {ProviderValue} */ (value);
		const secret = String(v.secret);
		/** @type {SendOutcome} */
		let outcome;
		if (v.provider === 'smtp') {
			try {
				await createSmtpMessaging({
					descriptor: { ...v, password: secret },
					policy,
					...(createTransport ? { createTransport } : {}),
				}).verify();
				return { ok: true };
			} catch (error) {
				return { ok: false, message: error instanceof Error ? error.message : 'The SMTP sign-in failed.' };
			}
		}
		if (v.provider === 'http') {
			const checked = checkUrl(String(v.url), policy);
			return checked.ok ? { ok: true } : { ok: false, message: `The gateway address is refused (${checked.reason}).` };
		}
		if (v.provider === 'resend')
			outcome = await call('https://api.resend.com/domains', {
				method: 'GET',
				headers: { authorization: `Bearer ${secret}` },
			});
		else if (v.provider === 'sendgrid')
			outcome = await call('https://api.sendgrid.com/v3/scopes', {
				method: 'GET',
				headers: { authorization: `Bearer ${secret}` },
			});
		else if (v.provider === 'mailgun')
			outcome = await call(
				`https://${v.region === 'eu' ? 'api.eu.mailgun.net' : 'api.mailgun.net'}/v3/domains/${encodeURIComponent(String(v.domain))}`,
				{ method: 'GET', headers: { authorization: basic('api', secret) } },
			);
		else if (v.provider === 'ses') {
			const url = `https://email.${v.region}.amazonaws.com/v2/email/account`;
			const headers = signV4({
				method: 'GET',
				url,
				region: String(v.region),
				service: 'ses',
				accessKeyId: String(v.accessKeyId),
				secretAccessKey: secret,
				now: now(),
				contentSha256Header: false,
			});
			outcome = await call(url, { method: 'GET', headers });
		} else if (v.provider === 'twilio')
			outcome = await call(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(String(v.accountSid))}.json`, {
				method: 'GET',
				headers: { authorization: basic(String(v.accountSid), secret) },
			});
		else
			outcome = await call(
				`https://graph.facebook.com/${META_API_VERSION}/${encodeURIComponent(String(v.phoneNumberId))}?fields=id`,
				{ method: 'GET', headers: { authorization: `Bearer ${secret}` } },
			);
		return outcome.ok ? { ok: true } : { ok: false, message: outcome.error };
	};

	return Object.freeze({ sendMessage, test });
};
