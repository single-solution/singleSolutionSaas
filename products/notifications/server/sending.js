/**
 * Sending (PLAN 0.8.5): accepting a message, attempting it, retries on the next uses, the fallback channel, opt-out,
 * quiet hours, send limits, delayed send and outgoing webhooks. There is no background work: a message due now is
 * attempted inside the request that sends it; waiting messages and webhook events are sent right after (`after()`)
 * the next requests for the website (`drain`), a few at a time. Nothing accepted is lost (PLAN 0.8.10 D7): a message
 * is saved before its first attempt, and an attempt that breaks off (a database or provider briefly unreachable) is a
 * failed attempt, retried by the plan like any other. The delivery log never keeps a secret (PLAN 0.8.10
 * D11): the values of a sensitive message (and those the sender names as secret) are replaced in its saved words, and
 * the real ones are kept sealed only while it has attempts to make. A finished message or webhook event gets the time
 * the database's expiry index removes it, by the setting "keep the delivery log for N days" (default forever).
 * @module
 */
import { createId } from '@ss/contracts';
import { problem } from '@ss/app-kit';
import { CHANNEL_CONNECTIONS, CHANNEL_FEATURES, FALLBACK_CHANNELS, addressFor, normaliseEmail } from '../core/channels.js';
import {
	DEFAULT_LANGUAGE,
	hiddenNamesOf,
	hideValues,
	isRequired,
	isSensitive,
	pickVersion,
	renderTemplate,
} from '../core/templates.js';
import {
	DRAIN_BATCH,
	LEASE_MS,
	MAX_WEBHOOK_ATTEMPTS,
	RETRY_PLANS,
	WEBHOOK_DELAYS_MS,
	nextAttemptAt,
	quietUntil,
	retryPlanOf,
	withinLimits,
} from '../core/timing.js';
import { SIGNATURE_HEADER, urlsFor } from '../core/webhooks.js';
import { signWebhook } from '../adapters/signatures.js';
import { createStore } from '../adapters/store.js';

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('../adapters/store.js').MessageRecord} MessageRecord */
/** @typedef {import('../adapters/store.js').Store} Store */
/** @typedef {import('../core/channels.js').Channel} Channel */
/** @typedef {import('../core/channels.js').Recipient} Recipient */
/**
 * A website while sending: its store, switched-on features and the product's own address (for unsubscribe links).
 * @typedef {{ websiteId: string, store: Store, on: string[], base: string }} Site
 */
/**
 * @typedef {object} SendInput
 * @property {Channel} channel
 * @property {string | null} template the template key; null for a one-off message
 * @property {{ subject: string, text: string } | null} content a one-off message's words
 * @property {Recipient} to
 * @property {Record<string, string>} values
 * @property {string[]} secretValues the values the sender names as secret: the delivery log hides them
 * @property {boolean} required the sender marks the message required (sent whatever the recipient unsubscribed from)
 * @property {string | null} language
 * @property {number | null} sendAt
 * @property {'api' | 'staff'} source
 */

/** Rendered words of a message on one channel. */
/** @typedef {Pick<MessageRecord, 'subject' | 'text' | 'parameters' | 'providerTemplate' | 'language'> & { buttons: import('../core/templates.js').Button[] }} Words */
/**
 * The words of a message as sent (`words`) and as the delivery log keeps them (`shown`: the `hidden` values replaced).
 * @typedef {{ words: Words, shown: Words, hidden: string[] }} Made
 */

/**
 * A message as the API and the delivery log answer it.
 * @param {MessageRecord} message
 */
export const messageView = (message) => ({
	id: message.id,
	template: message.template,
	source: message.source,
	channel: message.channel,
	to: message.address,
	status: message.status,
	reason: message.reason,
	subject: message.subject,
	text: message.text,
	attempts: message.attempts.map((attempt) => ({
		channel: attempt.channel,
		provider: attempt.provider,
		at: new Date(attempt.at).toISOString(),
		outcome: attempt.outcome,
		...(attempt.error ? { error: attempt.error } : {}),
	})),
	dueAt: new Date(message.dueAt).toISOString(),
	sentAt: message.sentAt ? new Date(message.sentAt).toISOString() : null,
	createdAt: new Date(message.createdAt).toISOString(),
});

/**
 * @param {Product} product
 */
export const createSending = (product) => {
	const { now } = product;

	/**
	 * The website as sending sees it.
	 * @param {{ websiteId: string, merchantId: string | null, base: string }} input
	 * @returns {Promise<Site>}
	 */
	const site = async ({ websiteId, merchantId, base }) => ({
		websiteId,
		store: createStore(await product.data.forWebsite(websiteId, merchantId ? { merchantId } : {}), { now }),
		on: await product.featuresOn(websiteId),
		base,
	});

	/**
	 * The words of a template on a channel for a recipient, with the unsubscribe link of optional templates: as sent, and
	 * as the delivery log keeps them, with every value of a sensitive template and the values named secret hidden.
	 * Accounts' templates are always required.
	 * @param {Site} s
	 * @param {{ key: string, channel: Channel, address: string, values: Record<string, string>, language: string | null,
	 *   secretValues: string[] }} input
	 * @returns {Promise<({ required: boolean, urgent: boolean } & Made) | null>} null when there is no template
	 */
	const fromTemplate = async (s, { key, channel, address, values, language, secretValues }) => {
		const version = pickVersion(await s.store.templates.versions(key, channel), language, s.on.includes('multi_language'));
		if (!version) return null;
		/** @type {Record<string, string>} */
		const builtIn = version.required
			? {}
			: { unsubscribeUrl: `${s.base}/unsubscribe/${s.websiteId}/${await s.store.recipients.codeOf(address)}` };
		/** @param {Record<string, string>} filled @returns {Words} */
		const wordsOf = (filled) => ({
			...renderTemplate(version, { ...filled, ...builtIn }),
			providerTemplate: version.providerTemplate,
			language: version.language,
		});
		const hidden = hiddenNamesOf(values, { sensitive: isSensitive(version), secretValues });
		const words = wordsOf(values);
		return {
			required: isRequired(version),
			urgent: version.urgent,
			words,
			shown: hidden.length === 0 ? words : wordsOf(hideValues(values, hidden)),
			hidden,
		};
	};

	/** @param {Site} s @param {Channel} channel @param {string} address */
	const aadOf = (s, channel, address) => `message|${s.websiteId}|${channel}|${address}`;

	/**
	 * What a message keeps of its values and words: them with the hidden values replaced, and the real ones sealed for
	 * its attempts (to the website and the recipient), else null.
	 * @param {Site} s
	 * @param {{ channel: Channel, address: string, values: Record<string, string> } & Made} input
	 * @returns {Words & Pick<MessageRecord, 'values' | 'hidden' | 'sealed'>}
	 */
	const keep = (s, { channel, address, values, words, shown, hidden }) => ({
		...shown,
		values: hideValues(values, hidden),
		hidden,
		sealed:
			hidden.length === 0
				? null
				: product.sealer.seal(
						JSON.stringify({
							values,
							subject: words.subject,
							text: words.text,
							parameters: words.parameters,
							buttons: words.buttons,
						}),
						aadOf(s, channel, address),
					),
	});

	/**
	 * A message as it is sent: with its real values and words when it hides some, or null when they cannot be opened
	 * (the encryption key changed).
	 * @param {Site} s
	 * @param {MessageRecord} message
	 * @returns {MessageRecord | null}
	 */
	const reveal = (s, message) => {
		if (!message.hidden?.length) return message;
		const opened = product.sealer.open(message.sealed, aadOf(s, message.channel, message.address));
		return opened === null ? null : { ...message, ...JSON.parse(opened) };
	};

	/**
	 * The retry plan of a channel's setting `retryPlan` (e-mail, SMS and WhatsApp; push channels retry on the short
	 * plan). A message keeps the plan it was accepted with (PLAN 0.8.10 N3).
	 * @param {Site} s
	 * @param {Channel} channel
	 * @returns {Promise<import('../core/timing.js').RetryPlan>}
	 */
	const planOf = async (s, channel) =>
		channel === 'email' || channel === 'sms' || channel === 'whatsapp'
			? retryPlanOf((await product.settings.values(s.websiteId, channel)).retryPlan)
			: 'short';

	/**
	 * When a finished message or webhook event (sent, failed or skipped) leaves the delivery log: the setting's days from
	 * now, else never (null, the default; PLAN 0.8.5 and 0.8.10 D11). A waiting one never expires.
	 * @param {Site} s
	 * @returns {Promise<Date | null>}
	 */
	const expiryOf = async (s) => {
		const days = Number((await product.settings.values(s.websiteId, 'delivery_log')).retentionDays);
		return days > 0 ? new Date(now() + days * 86_400_000) : null;
	};

	/**
	 * Queue outgoing webhook events (sent right after the request, signed): Notifications' own events that the Events
	 * setting picks, to the URLs that take the type.
	 * @param {Site} s
	 * @param {string} type
	 * @param {Record<string, unknown>} data
	 */
	const emit = async (s, type, data) => {
		if (!s.on.includes('webhooks')) return;
		if (typeof (await product.connections.value(s.websiteId, 'webhook_secret')) !== 'string') return;
		const { events } = await product.settings.values(s.websiteId, 'webhooks');
		if (!Array.isArray(events) || !events.includes(type)) return;
		const targets = urlsFor(await product.lists.webhookUrls(s.websiteId), type);
		if (targets.length === 0) return;
		const body = JSON.stringify({
			id: createId('evt'),
			type,
			createdAt: new Date(now()).toISOString(),
			websiteId: s.websiteId,
			data,
		});
		await s.store.events.add(targets.map((url) => ({ type, url, body })));
	};

	/**
	 * Queue another product's event (for example `payments.payment.paid`, PLAN 0.8.7 and 0.8.10 K5) for the merchant's
	 * webhook URLs, signed and retried like Notifications' own. The webhook keeps the product's own event id and time
	 * when it sent them (so the merchant's server can match it with that product's `GET /v1/events`), else it gets a
	 * new id and now. Each event goes to the URLs that take its type (PLAN 0.8.10 N5); the Events setting picks among
	 * Notifications' own events only.
	 * @param {Site} s
	 * @param {import('../core/webhooks.js').ForwardedEvent} event
	 * @returns {Promise<number>} deliveries queued (0 without the signing secret or URLs)
	 */
	const relay = async (s, { id, type, at, data }) => {
		if (typeof (await product.connections.value(s.websiteId, 'webhook_secret')) !== 'string') return 0;
		const targets = urlsFor(await product.lists.webhookUrls(s.websiteId), type);
		if (targets.length === 0) return 0;
		const body = JSON.stringify({
			id: id ?? createId('evt'),
			type,
			createdAt: new Date(at ?? now()).toISOString(),
			websiteId: s.websiteId,
			data,
		});
		await s.store.events.add(targets.map((url) => ({ type, url, body })));
		return targets.length;
	};

	/** @param {MessageRecord} message */
	const eventData = (message) => ({
		messageId: message.id,
		template: message.template,
		channel: message.channel,
		to: message.address,
		status: message.status,
		reason: message.reason,
		attempts: message.attempts.length,
	});

	/**
	 * One attempt on the message's channel.
	 * @param {Site} s
	 * @param {MessageRecord} message
	 * @returns {Promise<{ ok: boolean, provider: string, error?: string, retryable?: boolean }>}
	 */
	const deliver = async (s, message) => {
		const { channel } = message;
		if (!s.on.includes(CHANNEL_FEATURES[channel]))
			return { ok: false, provider: 'none', error: `The ${CHANNEL_FEATURES[channel]} feature is off.`, retryable: false };
		const value = await product.connections.value(s.websiteId, CHANNEL_CONNECTIONS[channel]);
		if (typeof value !== 'object' || value === null)
			return { ok: false, provider: 'none', error: `Not connected: ${CHANNEL_CONNECTIONS[channel]}.`, retryable: false };
		if (channel === 'email' || channel === 'sms' || channel === 'whatsapp') {
			/** @type {{ replyTo?: string, headers?: Record<string, string> }} */
			const extra = {};
			if (channel === 'email') {
				const replyTo = normaliseEmail((await product.settings.values(s.websiteId, 'email')).replyTo);
				if (replyTo) extra.replyTo = replyTo;
				if (!message.required) {
					const link = `${s.base}/unsubscribe/${s.websiteId}/${await s.store.recipients.codeOf(message.address)}`;
					extra.headers = { 'List-Unsubscribe': `<${link}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
				}
			}
			return product.providers.sendMessage(channel, value, {
				to: message.address,
				subject: message.subject,
				text: message.text,
				parameters: message.parameters,
				providerTemplate: message.providerTemplate,
				buttons: message.buttons ?? [],
				language: message.language,
				...extra,
			});
		}
		const url =
			typeof message.values.url === 'string' && /^(https:\/\/|\/)\S*$/.test(message.values.url)
				? message.values.url
				: undefined;
		const payload = { title: message.subject, body: message.text, ...(url ? { url } : {}) };
		const subscriptions =
			channel === 'push'
				? [await s.store.subscriptions.get(message.address)].filter((sub) => sub !== null)
				: await s.store.subscriptions.ofStaff(message.address);
		if (subscriptions.length === 0)
			return { ok: false, provider: 'webpush', error: 'No browser is subscribed for this recipient.', retryable: false };
		/** @type {Array<{ ok: boolean, error?: string, retryable?: boolean }>} */
		const results = [];
		for (const subscription of /** @type {import('../adapters/store.js').SubscriptionRecord[]} */ (subscriptions)) {
			const result = await product.webpush.push(value, subscription, payload);
			if (!result.ok && result.gone) await s.store.subscriptions.remove(subscription.id);
			results.push(result);
		}
		const failed = results.find((result) => !result.ok);
		return results.some((result) => result.ok) || !failed
			? { ok: true, provider: 'webpush' }
			: { ok: false, provider: 'webpush', error: failed.error, retryable: results.some((result) => result.retryable) };
	};

	/**
	 * Where a failed message goes next: the fallback channel of its channel (settings), when that feature is on, the
	 * recipient has an address there, a template exists for it and they did not unsubscribe there. The answer is what
	 * the message keeps there (its values still hidden).
	 * @param {Site} s
	 * @param {MessageRecord} message with its real values and words
	 * @returns {Promise<(ReturnType<typeof keep> & { channel: Channel, address: string }) | null>}
	 */
	const fallbackOf = async (s, message) => {
		if (message.fellBack || !s.on.includes('fallback') || !FALLBACK_CHANNELS.includes(/** @type {any} */ (message.channel)))
			return null;
		const target = /** @type {Channel | 'none'} */ ((await product.settings.values(s.websiteId, 'fallback'))[message.channel]);
		if (target === 'none' || !s.on.includes(CHANNEL_FEATURES[target])) return null;
		const address = addressFor(target, message.to);
		if (!address) return null;
		if (!message.required && (await s.store.optouts.has(address))) return null;
		if (message.template === null) {
			if (target === 'email' && message.subject === '') return null;
			/** @type {Words} */
			const words = {
				subject: target === 'email' ? message.subject : '',
				text: message.text,
				parameters: [],
				providerTemplate: '',
				buttons: [],
				language: DEFAULT_LANGUAGE,
			};
			return {
				channel: target,
				address,
				...keep(s, { channel: target, address, values: message.values, words, shown: words, hidden: [] }),
			};
		}
		const made = await fromTemplate(s, {
			key: message.template,
			channel: target,
			address,
			values: message.values,
			language: message.to.language,
			secretValues: message.hidden ?? [],
		});
		return made
			? { channel: target, address, ...keep(s, { channel: target, address, values: message.values, ...made }) }
			: null;
	};

	/**
	 * Attempt a message now and save the outcome: sent; retrying later; on to the fallback channel; or failed. Every
	 * attempt is added to the delivery log; a sent or failed message keeps no sealed words. An attempt that throws
	 * (a read of the connection, the settings or the subscriptions failing) is a failed attempt that may be retried.
	 * @param {Site} s
	 * @param {MessageRecord} message
	 * @returns {Promise<MessageRecord>}
	 */
	const attempt = async (s, message) => {
		const real = reveal(s, message);
		const result = real
			? await deliver(s, real).catch(() => ({
					ok: false,
					provider: 'none',
					error: 'It could not be sent now (a database or provider was briefly unreachable).',
					retryable: true,
				}))
			: { ok: false, provider: 'none', error: 'Its hidden values cannot be read: the encryption key changed.' };
		const attempts = [
			...message.attempts,
			{
				channel: message.channel,
				provider: result.provider,
				at: new Date(now()),
				outcome: /** @type {'sent' | 'failed'} */ (result.ok ? 'sent' : 'failed'),
				...(result.ok ? {} : { error: result.error }),
			},
		];
		if (result.ok) {
			const sent = await s.store.messages.update(message.id, {
				status: 'sent',
				reason: null,
				attempts,
				sentAt: new Date(now()),
				leaseUntil: null,
				sealed: null,
				expireAt: await expiryOf(s),
			});
			await emit(s, 'message.sent', eventData(sent));
			return sent;
		}
		const failed = message.channelAttempts + 1;
		const next = result.retryable ? nextAttemptAt(failed, now(), RETRY_PLANS[retryPlanOf(message.retryPlan)]) : null;
		if (next !== null)
			return s.store.messages.update(message.id, {
				status: 'retrying',
				reason: result.error ?? null,
				attempts,
				channelAttempts: failed,
				dueAt: new Date(next),
				leaseUntil: null,
			});
		const fallback = real ? await fallbackOf(s, real) : null;
		if (fallback) {
			const moved = await s.store.messages.update(message.id, {
				...fallback,
				attempts,
				channelAttempts: 0,
				retryPlan: await planOf(s, fallback.channel),
				fellBack: true,
				status: 'queued',
				reason: null,
				dueAt: new Date(now()),
				leaseUntil: new Date(now() + LEASE_MS),
			});
			return attempt(s, moved);
		}
		const final = await s.store.messages.update(message.id, {
			status: 'failed',
			reason: result.error ?? null,
			attempts,
			channelAttempts: failed,
			leaseUntil: null,
			sealed: null,
			expireAt: await expiryOf(s),
		});
		await emit(s, 'message.failed', eventData(final));
		return final;
	};

	/**
	 * Accept a message: opt-out, send limits, quiet hours and delayed send decide when (or whether) it goes; a message
	 * due now is attempted at once. Opt-out stops only optional messages: a required one (by its template, Accounts'
	 * templates or the sender) is always sent (PLAN 0.8.5).
	 * @param {Site} s
	 * @param {SendInput} input
	 * @returns {Promise<{ ok: true, message: MessageRecord } | { ok: false, problem: ReturnType<typeof problem> }>}
	 */
	const accept = async (s, input) => {
		const address = addressFor(input.channel, input.to);
		if (!address)
			return {
				ok: false,
				problem: problem('validation_failed', `The recipient has no address for ${input.channel}.`, {
					errors: [{ path: '/to', message: `Give the recipient's address for ${input.channel}.`, code: 'no_address' }],
				}),
			};
		/** @type {{ required: boolean, urgent: boolean } & Made} */
		let made;
		if (input.template !== null) {
			const found = await fromTemplate(s, {
				key: input.template,
				channel: input.channel,
				address,
				values: input.values,
				language: input.language,
				secretValues: input.secretValues,
			});
			if (!found)
				return {
					ok: false,
					problem: problem(
						'template_not_found',
						`There is no ${input.channel} template ${input.template}. Add it in the templates.`,
					),
				};
			made = found;
		} else {
			const content = /** @type {{ subject: string, text: string }} */ (input.content);
			// a one-off message from the merchant's staff is written for this person now: required and urgent
			/** @type {Words} */
			const words = {
				subject: content.subject,
				text: content.text,
				parameters: [],
				providerTemplate: '',
				buttons: [],
				language: DEFAULT_LANGUAGE,
			};
			made = { required: true, urgent: true, words, shown: words, hidden: [] };
		}
		const t = now();
		/** @type {Omit<MessageRecord, 'id' | 'createdAt'>} */
		const base = {
			template: input.template,
			source: input.source,
			channel: input.channel,
			to: input.to,
			address,
			...keep(s, { channel: input.channel, address, values: input.values, ...made }),
			required: made.required || input.required,
			urgent: made.urgent,
			status: 'queued',
			reason: null,
			attempts: [],
			channelAttempts: 0,
			retryPlan: await planOf(s, input.channel),
			fellBack: false,
			dueAt: new Date(t),
			leaseUntil: null,
			sentAt: null,
		};
		if (!base.required && (await s.store.optouts.has(address)))
			return {
				ok: true,
				message: await s.store.messages.add({
					...base,
					status: 'skipped',
					reason: 'unsubscribed',
					sealed: null,
					expireAt: await expiryOf(s),
				}),
			};
		if (s.on.includes('send_limits')) {
			const limits = await product.settings.values(s.websiteId, 'send_limits');
			const sent = {
				lastHour: await s.store.messages.sentSince(address, t - 3_600_000),
				lastDay: await s.store.messages.sentSince(address, t - 86_400_000),
			};
			if (!withinLimits(sent, { perHour: Number(limits.perHour), perDay: Number(limits.perDay) }))
				return {
					ok: true,
					message: await s.store.messages.add({
						...base,
						status: 'skipped',
						reason: 'limited',
						sealed: null,
						expireAt: await expiryOf(s),
					}),
				};
		}
		let dueAt = input.sendAt ?? t;
		if (!made.urgent && s.on.includes('quiet_hours')) {
			const quiet = await product.settings.values(s.websiteId, 'quiet_hours');
			const timeZone = input.to.timeZone ?? (await product.business(s.websiteId)).timeZone ?? 'UTC';
			dueAt = quietUntil(dueAt, { startHour: Number(quiet.startHour), endHour: Number(quiet.endHour) }, timeZone);
		}
		const now_ = dueAt <= t;
		const message = await s.store.messages.add({
			...base,
			dueAt: new Date(dueAt),
			leaseUntil: now_ ? new Date(t + LEASE_MS) : null,
		});
		return { ok: true, message: now_ ? await attempt(s, message) : message };
	};

	/**
	 * Deliver one outgoing webhook event (signed); a failure is retried on later uses.
	 * @param {Site} s
	 * @param {import('../adapters/store.js').WebhookEventRecord} event
	 */
	const deliverEvent = async (s, event) => {
		const secret = await product.connections.value(s.websiteId, 'webhook_secret');
		/** @type {string | null} */
		let error = null;
		if (typeof secret !== 'string') error = 'Not connected: webhook_secret.';
		else {
			try {
				const response = await product.send(event.url, {
					method: 'POST',
					headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: signWebhook(event.body, secret, now()) },
					body: event.body,
					timeoutMs: 10_000,
					redirect: 'error',
				});
				if (response.status < 200 || response.status > 299) error = `The URL answered HTTP ${response.status}.`;
			} catch {
				error = 'The URL could not be reached.';
			}
		}
		if (error === null)
			return s.store.events.update(event.id, {
				status: 'delivered',
				attempts: event.attempts + 1,
				lastError: null,
				expireAt: await expiryOf(s),
			});
		const attempts = event.attempts + 1;
		const next = nextAttemptAt(attempts, now(), { max: MAX_WEBHOOK_ATTEMPTS, delays: WEBHOOK_DELAYS_MS });
		return s.store.events.update(event.id, {
			attempts,
			lastError: error,
			...(next === null ? { status: 'failed', expireAt: await expiryOf(s) } : { dueAt: new Date(next) }),
		});
	};

	/**
	 * Right after a use of the website: send due messages (delayed, after quiet hours, retries) and due webhook events,
	 * a few of each.
	 * @param {Site} s
	 */
	const drain = async (s) => {
		for (let i = 0; i < DRAIN_BATCH; i += 1) {
			const message = await s.store.messages.claimDue();
			if (!message) break;
			if (!message.required && (await s.store.optouts.has(message.address)))
				await s.store.messages.update(message.id, {
					status: 'skipped',
					reason: 'unsubscribed',
					leaseUntil: null,
					sealed: null,
					expireAt: await expiryOf(s),
				});
			else await attempt(s, message);
		}
		for (let i = 0; i < DRAIN_BATCH; i += 1) {
			const event = await s.store.events.claimDue();
			if (!event) break;
			await deliverEvent(s, event);
		}
	};

	/**
	 * Unsubscribe an address from optional messages (link or keyword); tells the webhooks once.
	 * @param {Site} s
	 * @param {string} address
	 * @param {'link' | 'keyword'} via
	 */
	const unsubscribe = async (s, address, via) => {
		if (await s.store.optouts.add(address, via)) await emit(s, 'recipient.unsubscribed', { address, via });
	};

	return Object.freeze({ site, accept, drain, unsubscribe, relay });
};

/** @typedef {ReturnType<typeof createSending>} Sending */
