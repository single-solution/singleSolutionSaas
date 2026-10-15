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
 * - `http` (any SMS or WhatsApp gateway with an HTTP API, fixed-choices N1): the merchant builds the request — `{ method?:
 *   POST | GET | PUT | PATCH, url (template), contentType?: json | form | text | none, headers? (JSON object text), body?
 *   (template; none for GET or none), secret?, from? }` — and its success rule — `{ successStatus? (codes, ranges or
 *   classes: 200, 200-204, 2xx; default 2xx), successPath? (a JSON path such as result.code), successValue? (the value
 *   it must have, as text), idPath? (where the message id is) }`. Never words in the answer. Replies to it (unsubscribe
 *   keywords, N4): `{ inboundToken? (at least 16 characters, in the reply address as ?token=), inboundFrom, inboundText
 *   (where the sender and the text are: a JSON path or a form field) }`. In the URL, headers and
 *   body, `{to}` (international number, +…), `{toDigits}` (digits only), `{text}`, `{from}` and `{secret}` are filled,
 *   encoded for where they go (URL, JSON string, form field or plain text).
 * @module
 */
import { isObject } from '@ss/contracts/util';
import { checkUrl, isNetError, signV4 } from '@ss/net';
import { JSON_PATH, SUCCESS_2XX, detailOf, failed, failureMessage, httpOutcome, parseStatusRule } from '../core/gateway.js';
import { createSmtpMessaging } from './smtp.js';
import { isMailbox } from './util.js';

/** @typedef {import('../core/gateway.js').SendOutcome} SendOutcome */
/** @typedef {(url: string, init?: import('@ss/net').SafeFetchInit) => Promise<import('@ss/net').SafeResponse>} OutboundSend */
/** @typedef {Record<string, string | number | boolean>} ProviderValue */
/**
 * One message for a provider.
 * @typedef {object} ProviderMessage
 * @property {string} to email address or international phone number
 * @property {string} subject email only
 * @property {string} text
 * @property {string[]} parameters WhatsApp provider templates: body parameters
 * @property {string} providerTemplate WhatsApp: approved Meta template name (`''` = plain text)
 * @property {import('../core/templates.js').Button[]} [buttons] WhatsApp templates at Meta: the buttons' values
 * @property {string} language WhatsApp templates at Meta: the language code Meta approved the template in
 * @property {string} [replyTo] email
 * @property {Record<string, string>} [headers] email headers (List-Unsubscribe)
 */

/** Graph API version for WhatsApp Cloud API calls. */
const META_API_VERSION = 'v21.0';
/** Timeout of one provider call. */
const PROVIDER_TIMEOUT_MS = 15_000;

/** Providers each connection may use. */
const PROVIDERS = Object.freeze({
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
	http: ['url'],
});

/** Methods a gateway request may use. */
const GATEWAY_METHODS = Object.freeze(['POST', 'GET', 'PUT', 'PATCH']);
/** Body types of a gateway request. */
const GATEWAY_BODIES = Object.freeze(['json', 'form', 'text', 'none']);
/** The content type each body type is sent with. */
const BODY_TYPES = Object.freeze({
	json: 'application/json',
	form: 'application/x-www-form-urlencoded',
	text: 'text/plain; charset=utf-8',
});
/** Where each known provider answers the message id (they answer a refusal with an HTTP error status). */
const ID_PATHS = Object.freeze({ resend: 'id', mailgun: 'id', ses: 'MessageId', twilio: 'sid', meta: 'messages.0.id' });

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
	if (missing.length > 0) return `Fill out: ${missing.join(', ')}.`;
	if (name === 'email' && !isMailbox(value.from)) return 'from must be an email address or Name <address>.';
	if (provider === 'mailgun' && value.region !== undefined && value.region !== 'us' && value.region !== 'eu')
		return 'region must be us or eu.';
	if (provider === 'ses' && !/^[a-z]{2}(-[a-z]+)+-\d$/.test(String(value.region))) return 'region must be an AWS region.';
	if (provider === 'meta' && !/^\d{5,20}$/.test(String(value.phoneNumberId))) return 'phoneNumberId must be digits.';
	if (provider === 'twilio' && !/^AC[0-9a-f]{32}$/i.test(String(value.accountSid))) return 'accountSid starts with AC.';
	if (provider === 'http') {
		if (!/^https:\/\/\S+$/.test(String(value.url))) return 'url must be an https address.';
		const method = value.method ?? 'POST';
		if (!GATEWAY_METHODS.includes(String(method))) return `method must be ${GATEWAY_METHODS.join(', ')}.`;
		const type = value.contentType ?? 'json';
		if (!GATEWAY_BODIES.includes(String(type))) return `contentType must be ${GATEWAY_BODIES.join(', ')}.`;
		if (method !== 'GET' && type !== 'none' && (typeof value.body !== 'string' || value.body.trim() === ''))
			return 'Fill out: body (or pick the body type none).';
		if (value.headers !== undefined && headersOf(value.headers) === null)
			return 'headers must be a JSON object of text values.';
		if (value.successStatus !== undefined && parseStatusRule(value.successStatus) === null)
			return 'successStatus lists codes, ranges or classes, for example 200, 200-204 or 2xx.';
		for (const field of /** @type {const} */ (['successPath', 'idPath']))
			if (value[field] !== undefined && value[field] !== '' && !JSON_PATH.test(String(value[field])))
				return `${field} must be a JSON path such as result.code or data.0.id.`;
		if (value.successPath && String(value.successValue ?? '').trim() === '')
			return 'successValue is the value successPath must have, for example true, 0 or queued.';
		// replies (fixed-choices N4): a token of at least 16 characters, and where the sender and the text are
		if (value.inboundToken !== undefined && value.inboundToken !== '') {
			if (String(value.inboundToken).length < 16) return 'inboundToken has at least 16 characters.';
			for (const field of /** @type {const} */ (['inboundFrom', 'inboundText']))
				if (!JSON_PATH.test(String(value[field] ?? '')))
					return `${field} is where the reply has it: a JSON path or a form field, such as from or message.text.`;
		}
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
		/** @type {Array<[string, string]>} */
		const entries = [];
		for (const [key, v] of Object.entries(parsed)) {
			if (!/^[A-Za-z0-9-]{1,64}$/.test(key) || typeof v !== 'string' || /[\r\n]/.test(v)) return null;
			entries.push([key, v]);
		}
		return Object.fromEntries(entries);
	} catch {
		return null;
	}
};

/**
 * Fill a gateway template: `{to}`, `{toDigits}`, `{text}`, `{from}` and `{secret}`, each encoded by `encode`.
 * @param {string} template
 * @param {Record<string, string>} values
 * @param {(value: string) => string} encode
 */
const fillGateway = (template, values, encode) =>
	template.replace(/\{(to|toDigits|text|from|secret)\}/g, (_, name) => encode(values[name] ?? ''));

/**
 * The success rule of a gateway connection (fixed-choices N1).
 * @param {ProviderValue} v
 * @returns {import('../core/gateway.js').SuccessRule}
 */
const gatewayRule = (v) => ({
	statuses: parseStatusRule(v.successStatus) ?? SUCCESS_2XX,
	...(v.successPath ? { path: String(v.successPath), value: String(v.successValue ?? '') } : {}),
	...(v.idPath ? { idPath: String(v.idPath) } : {}),
});

/** @param {string} value text inside a JSON string literal */
const jsonInner = (value) => JSON.stringify(value).slice(1, -1);

/**
 * @param {{ send: OutboundSend, policy: import('@ss/net').OutboundPolicy, now: () => number,
 *   createTransport?: import('./smtp.js').CreateSmtpTransport }} options
 */
export const createProviders = ({ send, policy, now, createTransport }) => {
	/**
	 * One HTTP call to a provider, as a send outcome by its success rule (default: any 2xx; no id). `idHeader` names a
	 * response header holding the message id (SendGrid's X-Message-Id).
	 * @param {string} url
	 * @param {{ method?: string, headers?: Record<string, string>, body?: string,
	 *   rule?: import('../core/gateway.js').SuccessRule, idHeader?: string }} init
	 * @returns {Promise<SendOutcome>}
	 */
	const call = async (url, { method = 'POST', headers = {}, body, rule = { statuses: SUCCESS_2XX }, idHeader } = {}) => {
		try {
			const response = await send(url, {
				method,
				headers: { accept: 'application/json', ...headers },
				...(body === undefined ? {} : { body }),
				timeoutMs: PROVIDER_TIMEOUT_MS,
				redirect: 'error',
			});
			const outcome = httpOutcome(response.status, response.body.toString('utf8'), rule);
			const headerId = idHeader ? response.headers[idHeader] : undefined;
			return outcome.ok && headerId ? { ok: true, id: headerId } : outcome;
		} catch (error) {
			const cause = isNetError(error) ? error.code : 'network';
			return failed('provider_unreachable', { values: { cause }, retryable: cause !== 'ssrf_blocked' });
		}
	};

	/** @param {string} user @param {string} password */
	const basic = (user, password) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

	/** @param {Record<string, string>} fields */
	const form = (fields) => new URLSearchParams(fields).toString();

	/**
	 * Send an email.
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
				return failed('provider_error', {
					values: { cause: typeof code === 'string' ? code : 'smtp' },
					detail: detailOf(error instanceof Error ? error.message : '', [secret]),
					retryable: code === 'timeout' || code === 'upstream_error',
				});
			}
		}
		if (v.provider === 'resend')
			return call('https://api.resend.com/emails', {
				rule: { statuses: SUCCESS_2XX, idPath: ID_PATHS.resend },
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
				idHeader: 'x-message-id',
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
				rule: { statuses: SUCCESS_2XX, idPath: ID_PATHS.mailgun },
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
		return call(url, { headers: signed, body, rule: { statuses: SUCCESS_2XX, idPath: ID_PATHS.ses } });
	};

	/**
	 * Send through a generic HTTP gateway.
	 * @param {ProviderValue} v
	 * @param {ProviderMessage} m
	 * @returns {Promise<SendOutcome>}
	 */
	const gateway = async (v, m) => {
		const values = {
			to: m.to,
			toDigits: m.to.replace(/\D/g, ''),
			text: m.text,
			from: String(v.from ?? ''),
			secret: String(v.secret ?? ''),
		};
		const method = String(v.method ?? 'POST');
		const type = /** @type {'json' | 'form' | 'text' | 'none'} */ (method === 'GET' ? 'none' : (v.contentType ?? 'json'));
		const extra = Object.fromEntries(
			Object.entries(headersOf(v.headers) ?? {}).map(([name, val]) => [name.toLowerCase(), fillGateway(val, values, String)]),
		);
		const encode = type === 'json' ? jsonInner : type === 'form' ? encodeURIComponent : String;
		return call(fillGateway(String(v.url), values, encodeURIComponent), {
			method,
			headers: { ...(type === 'none' ? {} : { 'content-type': BODY_TYPES[type] }), ...extra },
			...(type === 'none' ? {} : { body: fillGateway(String(v.body ?? ''), values, encode) }),
			rule: gatewayRule(v),
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
			rule: { statuses: SUCCESS_2XX, idPath: ID_PATHS.twilio },
			headers: { authorization: basic(sid, String(v.secret)), 'content-type': 'application/x-www-form-urlencoded' },
			body: form(fields),
		});
	};

	/**
	 * The components of an approved template: the values as body parameters, then each button's value (PLAN 0.8.10 N1).
	 * A URL button takes its variable part as text. A copy-code button is sent as Meta's authentication templates take
	 * it: a `url` button whose text parameter is the code.
	 * @param {ProviderMessage} m
	 */
	const metaComponents = (m) => [
		...(m.parameters.length > 0 ? [{ type: 'body', parameters: m.parameters.map((text) => ({ type: 'text', text })) }] : []),
		...(m.buttons ?? []).map((button) => ({
			type: 'button',
			sub_type: 'url',
			index: String(button.index),
			parameters: [{ type: 'text', text: button.value }],
		})),
	];

	/**
	 * Send through the WhatsApp Cloud API: plain text, or an approved template with the values as body parameters and
	 * its buttons' values.
	 * @param {ProviderValue} v
	 * @param {ProviderMessage} m
	 */
	const meta = (v, m) => {
		const components = metaComponents(m);
		return call(`https://graph.facebook.com/${META_API_VERSION}/${encodeURIComponent(String(v.phoneNumberId))}/messages`, {
			rule: { statuses: SUCCESS_2XX, idPath: ID_PATHS.meta },
			headers: { authorization: `Bearer ${String(v.secret)}`, 'content-type': 'application/json' },
			body: JSON.stringify({
				messaging_product: 'whatsapp',
				to: m.to.replace(/\D/g, ''),
				...(m.providerTemplate
					? {
							type: 'template',
							template: {
								name: m.providerTemplate,
								language: { code: m.language },
								...(components.length > 0 ? { components } : {}),
							},
						}
					: { type: 'text', text: { body: m.text } }),
			}),
		});
	};

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
			return { ...failed('connection_unusable', { values: { connection: channel }, detail: violation }), provider };
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
			// the address with sample values in its placeholders (a gateway cannot be checked without sending)
			const sample = fillGateway(
				String(v.url),
				{ to: '+10000000000', toDigits: '10000000000', text: 'test' },
				encodeURIComponent,
			);
			const checked = checkUrl(sample, policy);
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
		return outcome.ok ? { ok: true } : { ok: false, message: failureMessage(outcome) };
	};

	return Object.freeze({ sendMessage, test });
};
