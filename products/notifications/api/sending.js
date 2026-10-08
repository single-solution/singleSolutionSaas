/**
 * Sending (PLAN 0.8.5): accepting a message, attempting it, retries on the next uses, the fallback channel, opt-out,
 * quiet hours, send limits, delayed send and outgoing webhooks. There is no background work: a message due now is
 * attempted inside the request that sends it; waiting messages and webhook events are sent right after (`after()`)
 * the next requests for the website (`drain`), a few at a time.
 * @module
 */
import { createId } from '@ss/contracts';
import { problem } from '@ss/app-kit';
import { CHANNEL_CONNECTIONS, CHANNEL_FEATURES, FALLBACK_CHANNELS, addressFor, normaliseEmail } from '../core/channels.js';
import { DEFAULT_LANGUAGE, pickVersion, renderTemplate } from '../core/templates.js';
import {
	DRAIN_BATCH,
	LEASE_MS,
	MAX_WEBHOOK_ATTEMPTS,
	WEBHOOK_DELAYS_MS,
	nextAttemptAt,
	quietUntil,
	withinLimits,
} from '../core/timing.js';
import { SIGNATURE_HEADER, webhookUrls } from '../core/webhooks.js';
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
 * @property {string | null} language
 * @property {number | null} sendAt
 * @property {'api' | 'staff'} source
 */

/** Rendered words of a message on one channel. */
/** @typedef {Pick<MessageRecord, 'subject' | 'text' | 'parameters' | 'providerTemplate' | 'language'>} Words */

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
	 * The words of a template on a channel for a recipient, with the unsubscribe link of optional messages.
	 * @param {Site} s
	 * @param {{ key: string, channel: Channel, address: string, values: Record<string, string>, language: string | null }} input
	 * @returns {Promise<{ required: boolean, urgent: boolean, words: Words } | null>} null when there is no template
	 */
	const fromTemplate = async (s, { key, channel, address, values, language }) => {
		const version = pickVersion(await s.store.templates.versions(key, channel), language, s.on.includes('multi_language'));
		if (!version) return null;
		/** @type {Record<string, string>} */
		const all = { ...values };
		if (!version.required)
			all.unsubscribeUrl = `${s.base}/unsubscribe/${s.websiteId}/${await s.store.recipients.codeOf(address)}`;
		const rendered = renderTemplate(version, all);
		return {
			required: version.required,
			urgent: version.urgent,
			words: { ...rendered, providerTemplate: version.providerTemplate, language: version.language },
		};
	};

	/**
	 * Queue outgoing webhook events (sent right after the request, signed).
	 * @param {Site} s
	 * @param {string} type
	 * @param {Record<string, unknown>} data
	 */
	const emit = async (s, type, data) => {
		if (!s.on.includes('webhooks')) return;
		if (typeof (await product.connections.value(s.websiteId, 'webhook_secret')) !== 'string') return;
		const { urls, events } = await product.settings.values(s.websiteId, 'webhooks');
		if (!Array.isArray(events) || !events.includes(type)) return;
		const body = JSON.stringify({
			id: createId('evt'),
			type,
			createdAt: new Date(now()).toISOString(),
			websiteId: s.websiteId,
			data,
		});
		await s.store.events.add(webhookUrls(urls).map((url) => ({ type, url, body })));
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
	 * recipient has an address there, a template exists for it and they did not unsubscribe there.
	 * @param {Site} s
	 * @param {MessageRecord} message
	 * @returns {Promise<(Words & { channel: Channel, address: string }) | null>}
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
			return {
				channel: target,
				address,
				subject: target === 'email' ? message.subject : '',
				text: message.text,
				parameters: [],
				providerTemplate: '',
				language: DEFAULT_LANGUAGE,
			};
		}
		const made = await fromTemplate(s, {
			key: message.template,
			channel: target,
			address,
			values: message.values,
			language: message.to.language,
		});
		return made ? { channel: target, address, ...made.words } : null;
	};

	/**
	 * Attempt a message now and save the outcome: sent; retrying later; on to the fallback channel; or failed. Every
	 * attempt is added to the delivery log.
	 * @param {Site} s
	 * @param {MessageRecord} message
	 * @returns {Promise<MessageRecord>}
	 */
	const attempt = async (s, message) => {
		const result = await deliver(s, message);
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
			});
			await emit(s, 'message.sent', eventData(sent));
			return sent;
		}
		const failed = message.channelAttempts + 1;
		const next = result.retryable ? nextAttemptAt(failed, now()) : null;
		if (next !== null)
			return s.store.messages.update(message.id, {
				status: 'retrying',
				reason: result.error ?? null,
				attempts,
				channelAttempts: failed,
				dueAt: new Date(next),
				leaseUntil: null,
			});
		const fallback = await fallbackOf(s, message);
		if (fallback) {
			const moved = await s.store.messages.update(message.id, {
				...fallback,
				attempts,
				channelAttempts: 0,
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
		});
		await emit(s, 'message.failed', eventData(final));
		return final;
	};

	/**
	 * Accept a message: opt-out, send limits, quiet hours and delayed send decide when (or whether) it goes; a message
	 * due now is attempted at once.
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
		/** @type {{ required: boolean, urgent: boolean, words: Words }} */
		let made;
		if (input.template !== null) {
			const found = await fromTemplate(s, {
				key: input.template,
				channel: input.channel,
				address,
				values: input.values,
				language: input.language,
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
			made = {
				required: true,
				urgent: true,
				words: {
					subject: content.subject,
					text: content.text,
					parameters: [],
					providerTemplate: '',
					language: DEFAULT_LANGUAGE,
				},
			};
		}
		const t = now();
		/** @type {Omit<MessageRecord, 'id' | 'createdAt'>} */
		const base = {
			template: input.template,
			source: input.source,
			channel: input.channel,
			to: input.to,
			address,
			values: input.values,
			...made.words,
			required: made.required,
			urgent: made.urgent,
			status: 'queued',
			reason: null,
			attempts: [],
			channelAttempts: 0,
			fellBack: false,
			dueAt: new Date(t),
			leaseUntil: null,
			sentAt: null,
		};
		if (!made.required && (await s.store.optouts.has(address)))
			return { ok: true, message: await s.store.messages.add({ ...base, status: 'skipped', reason: 'unsubscribed' }) };
		if (s.on.includes('send_limits')) {
			const limits = await product.settings.values(s.websiteId, 'send_limits');
			const sent = {
				lastHour: await s.store.messages.sentSince(address, t - 3_600_000),
				lastDay: await s.store.messages.sentSince(address, t - 86_400_000),
			};
			if (!withinLimits(sent, { perHour: Number(limits.perHour), perDay: Number(limits.perDay) }))
				return { ok: true, message: await s.store.messages.add({ ...base, status: 'skipped', reason: 'limited' }) };
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
			return s.store.events.update(event.id, { status: 'delivered', attempts: event.attempts + 1, lastError: null });
		const attempts = event.attempts + 1;
		const next = nextAttemptAt(attempts, now(), { max: MAX_WEBHOOK_ATTEMPTS, delays: WEBHOOK_DELAYS_MS });
		return s.store.events.update(event.id, {
			attempts,
			lastError: error,
			...(next === null ? { status: 'failed' } : { dueAt: new Date(next) }),
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
				await s.store.messages.update(message.id, { status: 'skipped', reason: 'unsubscribed', leaseUntil: null });
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

	return Object.freeze({ site, accept, drain, unsubscribe });
};

/** @typedef {ReturnType<typeof createSending>} Sending */
