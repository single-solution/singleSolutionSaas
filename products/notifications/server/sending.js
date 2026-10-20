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
 *
 * Default templates (parity P1): a product's send carries the default words of its message per channel (`defaults`);
 * they are used while the website has no template of its own for the channel, and kept on a waiting message for its
 * fallback channel. WhatsApp never has a default (it sends only templates approved at Meta): a product's message
 * without the merchant's WhatsApp template is recorded as failed, "not set up", and goes to the fallback channel when
 * one is set — never dropped without a trace. A product's message the merchant switched off on a channel is skipped
 * (reason `switched_off`). A send may name a `fallbackTemplate`: the website's template for that key is used when it has
 * none of its own for the send's key, before the defaults (a product's message per status falls back to its general
 * message); the message is skipped when either key is switched off on the channel.
 *
 * Long values (a product's message names them in `longValues`, up to 50,000 characters each): email sends them whole;
 * on SMS, WhatsApp and push, and in a subject, title or button, they are cut to fit, ending with the website's text
 * `message.shortened`. A waiting message keeps their names for its fallback channel.
 * @module
 */
import { createId } from '@ss/contracts';
import { normalizeEmail } from '@ss/contracts/email';
import { isNetError } from '@ss/net';
import { problem } from '@ss/app-kit';
import { signWebhook } from '@ss/protocol';
import { CHANNEL_CONNECTIONS, CHANNEL_FEATURES, addressFor } from '../core/channels.js';
import { fallbackChainOf } from '../core/choices.js';
import {
	DEFAULT_LANGUAGE,
	hiddenNamesOf,
	hideValues,
	isAccountKey,
	isRequired,
	isSensitive,
	isTitled,
	isUrgent,
	metaLanguageOf,
	pickVersion,
	renderTemplate,
} from '../core/templates.js';
import {
	ACCOUNT_CEILINGS,
	CHANNEL_MINUTE_CEILINGS,
	RECIPIENT_CEILINGS,
	RETRY_WAITS,
	WEBHOOK_RETRY_WAITS,
} from '../core/limits.js';
import { DRAIN_BATCH, LEASE_MS, nextAttemptAt, quietUntil, withinLimits } from '../core/timing.js';
import { SIGNATURE_HEADER, urlsFor } from '../core/webhooks.js';
import { messageAadOf } from '../adapters/crypto.js';
import { createStore } from '../adapters/store.js';
import { failed } from '../core/gateway.js';

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
 * @property {boolean} required the sender marks the message required (sent whatever the recipient unsubscribed from); a
 *   one-off message is required and urgent (transactional) or neither (marketing, fixed-choices N9)
 * @property {string | null} language
 * @property {number | null} sendAt
 * @property {'api' | 'staff'} source
 * @property {Partial<Record<Channel, import('../core/templates.js').DefaultTemplate>>} defaults a product's message: the default words its send carries per
 *   channel (parity P1), `{}` for none
 * @property {string | null} fallbackTemplate the template key whose website template is used when the website has none
 *   of its own for `template`, before the defaults (null: none)
 * @property {string[]} longValues the values of a product's message that hold long text (`[]`: none)
 * @property {string | null} [topic] a one-off marketing message's unsubscribe topic (a template's comes from its settings)
 */
/** @typedef {import('../core/templates.js').Template} Template */
/** @typedef {import('../core/gateway.js').SendOutcome} SendOutcome */

/** Rendered words of a message on one channel. */
/** @typedef {Pick<MessageRecord, 'subject' | 'text' | 'parameters' | 'providerTemplate' | 'language'> & { buttons: import('../core/templates.js').Button[] }} Words */
/**
 * The words of a message as sent (`words`) and as the delivery log keeps them (`shown`: the `hidden` values replaced).
 * @typedef {{ words: Words, shown: Words, hidden: string[] }} Made
 */

/**
 * Why a product's message on WhatsApp is not sent: the merchant has no WhatsApp template for it (parity P1), as the
 * code `not_set_up` with the template keys to add.
 * @param {string} key @param {string | null} fallbackKey the send's `fallbackTemplate`
 * @returns {import('../core/gateway.js').Failure}
 */
const notSetUpFailure = (key, fallbackKey) => ({
	reason: 'not_set_up',
	values: { template: key, ...(fallbackKey ? { fallbackTemplate: fallbackKey } : {}) },
});

/** The skip reason of a product's message the merchant switched off on its channel (parity P1). */
export const SWITCHED_OFF = 'switched_off';

/** The words of a message that has none (switched off, or WhatsApp not set up). @type {Readonly<Words>} */
const NO_WORDS = Object.freeze({
	subject: '',
	text: '',
	parameters: [],
	providerTemplate: '',
	buttons: [],
	language: DEFAULT_LANGUAGE,
});

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
	reasonValues: message.reasonValues ?? {},
	topic: message.topic,
	subject: message.subject,
	text: message.text,
	attempts: message.attempts.map((attempt) => ({
		channel: attempt.channel,
		provider: attempt.provider,
		at: new Date(attempt.at).toISOString(),
		outcome: attempt.outcome,
		...(attempt.reason ? { reason: attempt.reason } : {}),
		...(attempt.reasonValues ? { reasonValues: attempt.reasonValues } : {}),
		...(attempt.detail ? { detail: attempt.detail } : {}),
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
	 * The unsubscribe link of an address: on a message with a topic it names the topic (one-click unsubscribes from it
	 * only; the page lets the recipient choose per topic).
	 * @param {Site} s @param {string} address @param {string | null} topic
	 */
	const unsubscribeLinkOf = async (s, address, topic) =>
		`${s.base}/unsubscribe/${s.websiteId}/${await s.store.recipients.codeOf(address)}${topic ? `?topic=${topic}` : ''}`;

	/**
	 * The merchant's settings of a template key (fixed-choices N2, N5, N7) and the website's topics: its topic counts only
	 * while it is still one of the topics.
	 * @param {Site} s @param {string | null} key
	 */
	const settingsOf = async (s, key) => {
		const [templates, topics] = await Promise.all([
			product.lists.templateSettings(s.websiteId),
			product.lists.topics(s.websiteId),
		]);
		const own = key === null ? undefined : templates.find((entry) => entry.key === key);
		const topic = own?.topic && topics.some((entry) => entry.id === own.topic) ? own.topic : null;
		return { templates, topic, capped: own?.capped ?? null };
	};

	/**
	 * Whether an address unsubscribed from a message: from every optional message, or from its topic.
	 * @param {Site} s @param {string} address @param {string | null} topic
	 */
	const optedOut = async (s, address, topic) =>
		(await s.store.optouts.has(address)) || (topic !== null && (await s.store.topicOptouts.has(address, topic)));

	/**
	 * The words of a template on a channel for a recipient, with the unsubscribe link of optional templates: as sent, and
	 * as the delivery log keeps them, with every value of a sensitive template and the values named secret hidden.
	 * The website's own template comes first (the recipient's language, else its default version), then its template
	 * for the send's fallback key, else the product's default words on that channel (parity P1). Accounts' templates are
	 * always required and urgent. Long values are cut to fit where the channel or the part needs it, ending with the
	 * website's text `message.shortened`.
	 * @param {Site} s
	 * @param {{ key: string, fallbackKey: string | null, channel: Channel, address: string, values: Record<string, string>,
	 *   language: string | null, secretValues: string[], defaults: Partial<Record<Channel, import('../core/templates.js').DefaultTemplate>>,
	 *   longValues: string[], topic: string | null }} input
	 * @returns {Promise<({ required: boolean, urgent: boolean } & Made) | null>} null when there is no template
	 */
	const fromTemplate = async (
		s,
		{ key, fallbackKey, channel, address, values, language, secretValues, defaults, longValues, topic },
	) => {
		/** @param {string} templateKey */
		const ownOf = async (templateKey) =>
			pickVersion(await s.store.templates.versions(templateKey, channel), language, s.on.includes('multi_language'));
		// the product's default words: in the recipient's language when the product has them (exact, then its base
		// language), else its US-English words (fixed-choices N11)
		const declared = defaults[channel];
		const fromDefaults = declared
			? pickVersion([{ ...declared, translations: undefined }, ...(declared.translations ?? [])], language, true)
			: null;
		const version = (await ownOf(key)) ?? (fallbackKey ? await ownOf(fallbackKey) : null) ?? fromDefaults ?? null;
		if (!version) return null;
		/** @type {Record<string, string>} */
		const builtIn = version.required ? {} : { unsubscribeUrl: await unsubscribeLinkOf(s, address, topic) };
		const fit = {
			longValues,
			note: longValues.length === 0 ? '' : String((await product.settings.texts(s.websiteId))['message.shortened']),
		};
		/** @param {Record<string, string>} filled @returns {Words} */
		const wordsOf = (filled) => ({
			...renderTemplate(version, { ...filled, ...builtIn }, fit),
			providerTemplate: version.providerTemplate,
			language: version.language,
		});
		const hidden = hiddenNamesOf(values, { sensitive: isSensitive(version), secretValues });
		const words = wordsOf(values);
		return {
			required: isRequired(version),
			urgent: isUrgent(version),
			words,
			shown: hidden.length === 0 ? words : wordsOf(hideValues(values, hidden)),
			hidden,
		};
	};

	/** @param {Site} s @param {Channel} channel @param {string} address */
	const aadOf = (s, channel, address) => messageAadOf(s.websiteId, channel, address);

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
		if (message.hidden.length === 0) return message;
		const opened = product.sealer.open(message.sealed, aadOf(s, message.channel, message.address));
		return opened === null ? null : { ...message, ...JSON.parse(opened) };
	};

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
	 * Queue outgoing webhook events (sent right after the request, signed): Notifications' own events, to the URLs that
	 * take the type (each URL names its events, or takes every one).
	 * @param {Site} s
	 * @param {string} type
	 * @param {Record<string, unknown>} data
	 */
	const emit = async (s, type, data) => {
		if (!s.on.includes('webhooks')) return;
		if (typeof (await product.connections.value(s.websiteId, 'webhook_secret')) !== 'string') return;
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
	 * new id and now. Each event goes to the URLs that take its type (PLAN 0.8.10 N5).
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
		reasonValues: message.reasonValues ?? {},
		attempts: message.attempts.length,
	});

	/**
	 * One attempt on the message's channel.
	 * @param {Site} s
	 * @param {MessageRecord} message
	 * @returns {Promise<SendOutcome & { provider: string }>}
	 */
	const deliver = async (s, message) => {
		const { channel } = message;
		if (!s.on.includes(CHANNEL_FEATURES[channel]))
			return { ...failed('feature_off', { values: { feature: CHANNEL_FEATURES[channel] } }), provider: 'none' };
		const value = await product.connections.value(s.websiteId, CHANNEL_CONNECTIONS[channel]);
		if (typeof value !== 'object' || value === null)
			return { ...failed('not_connected', { values: { connection: CHANNEL_CONNECTIONS[channel] } }), provider: 'none' };
		if (channel === 'email' || channel === 'sms' || channel === 'whatsapp') {
			/** @type {{ replyTo?: string, headers?: Record<string, string> }} */
			const extra = {};
			if (channel === 'email') {
				// replies go to the business's contact email, set once in the Portal (Website settings › Business)
				const replyTo = normalizeEmail((await product.website(s.websiteId)).business.email);
				if (replyTo) extra.replyTo = replyTo;
				if (!message.required) {
					const link = await unsubscribeLinkOf(s, message.address, message.topic);
					extra.headers = { 'List-Unsubscribe': `<${link}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
				}
			}
			const { templateLanguage } = channel === 'whatsapp' ? await product.settings.values(s.websiteId, 'whatsapp') : {};
			return product.providers.sendMessage(channel, value, {
				to: message.address,
				subject: message.subject,
				text: message.text,
				parameters: message.parameters,
				providerTemplate: message.providerTemplate,
				buttons: message.buttons,
				language: metaLanguageOf(message.language, templateLanguage),
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
		if (subscriptions.length === 0) return { ...failed('no_subscription'), provider: 'webpush' };
		/** @type {import('../adapters/webpush.js').PushOutcome[]} */
		const results = [];
		for (const subscription of /** @type {import('../adapters/store.js').SubscriptionRecord[]} */ (subscriptions)) {
			const result = await product.webpush.push(value, subscription, payload);
			if (!result.ok && result.gone) await s.store.subscriptions.remove(subscription.id);
			if (result.ok && subscription.kind === 'visitor') await s.store.subscriptions.seen(subscription.id);
			results.push(result);
		}
		const failure = results.find((result) => !result.ok);
		if (results.some((result) => result.ok) || !failure || failure.ok) return { ok: true, id: null, provider: 'webpush' };
		return {
			...failed(failure.reason, {
				...(failure.values ? { values: failure.values } : {}),
				...(failure.detail ? { detail: failure.detail } : {}),
				retryable: results.some((result) => !result.ok && result.retryable),
			}),
			provider: 'webpush',
		};
	};

	/**
	 * Whether the merchant switched a product's message off on a channel: its key, or the key it falls back to. Only a
	 * product's message can be switched off, never Accounts'.
	 * @param {Site} s @param {string} key @param {string | null} fallbackKey @param {Channel} channel
	 */
	const switchedOff = async (s, key, fallbackKey, channel) => {
		for (const each of fallbackKey ? [key, fallbackKey] : [key])
			if (!isAccountKey(each) && (await product.defaults.ownerOf(each)) !== null && (await s.store.off.has(each, channel)))
				return true;
		return false;
	};

	/**
	 * The hard cost ceiling (`core/limits.js`, SR-7-2) a message to an address on a channel would cross now, if any: the
	 * address's messages of the last hour, then of the last day (Accounts' sign-in codes have their own higher ceiling),
	 * then the website's texts or WhatsApp messages of the last minute. Required messages are counted and held too.
	 * Skipped messages are not counted. A refusal is logged, never with the address.
	 * @param {Site} s
	 * @param {{ channel: Channel, address: string, template: string | null }} message
	 * @returns {Promise<{ code: 'recipient_limit' | 'channel_limit', detail: string } | null>}
	 */
	const ceilingHit = async (s, { channel, address, template }) => {
		const t = now();
		const account = template !== null && isAccountKey(template);
		const own = (account ? ACCOUNT_CEILINGS : RECIPIENT_CEILINGS)[channel];
		for (const [window, span, limit, words] of /** @type {const} */ ([
			['hour', 3_600_000, own.perHour, 'an hour'],
			['day', 86_400_000, own.perDay, 'a day'],
		]))
			if ((await s.store.messages.madeSince(address, t - span, limit)) >= limit) {
				product.logger.warn('message refused: the recipient ceiling is reached', {
					websiteId: s.websiteId,
					channel,
					window,
					limit,
					account,
				});
				return {
					code: 'recipient_limit',
					detail: `Too many ${channel} messages to this recipient: at most ${limit} ${words}.`,
				};
			}
		const perMinute = channel === 'sms' || channel === 'whatsapp' ? CHANNEL_MINUTE_CEILINGS[channel] : undefined;
		if (perMinute !== undefined && (await s.store.messages.madeOnChannelSince(channel, t - 60_000, perMinute)) >= perMinute) {
			product.logger.warn('message refused: the channel ceiling is reached', {
				websiteId: s.websiteId,
				channel,
				limit: perMinute,
			});
			return { code: 'channel_limit', detail: `Too many ${channel} messages in a minute: at most ${perMinute} a minute.` };
		}
		return null;
	};

	/**
	 * Where a failed message goes next (fixed-choices N7): the first of its fallback channels (kept from when it was
	 * accepted: its template's own, else the website's for its channel) that is on, where the recipient has an address and
	 * has not unsubscribed (a required message goes anyway), where the message is not switched off and a template exists
	 * for it. The answer is what the message keeps there (its values still hidden) and the channels still left after it.
	 * @param {Site} s
	 * @param {MessageRecord} message with its real values and words
	 * @returns {Promise<(ReturnType<typeof keep> & { channel: Channel, address: string, fallbackChain: Channel[] }) | null>}
	 */
	const fallbackOf = async (s, message) => {
		if (!s.on.includes('fallback')) return null;
		const chain = message.fallbackChain;
		for (const [at, target] of chain.entries()) {
			const left = chain.slice(at + 1);
			if (!s.on.includes(CHANNEL_FEATURES[target])) continue;
			const address = addressFor(target, message.to);
			if (!address) continue;
			if (!message.required && (await optedOut(s, address, message.topic))) continue;
			// the fallback is a send too: a channel at its ceiling is left out (logged), the next one is tried
			if (await ceilingHit(s, { channel: target, address, template: message.template })) continue;
			if (message.template !== null && (await switchedOff(s, message.template, message.fallbackTemplate, target))) continue;
			if (message.template === null) {
				if (isTitled(target) && message.subject === '') continue;
				/** @type {Words} */
				const words = {
					subject: isTitled(target) ? message.subject : '',
					text: message.text,
					parameters: [],
					providerTemplate: '',
					buttons: [],
					language: DEFAULT_LANGUAGE,
				};
				return {
					channel: target,
					address,
					fallbackChain: left,
					...keep(s, { channel: target, address, values: message.values, words, shown: words, hidden: [] }),
				};
			}
			const made = await fromTemplate(s, {
				key: message.template,
				fallbackKey: message.fallbackTemplate,
				channel: target,
				address,
				values: message.values,
				language: message.to.language,
				secretValues: message.hidden,
				defaults: message.defaults ?? {},
				longValues: message.longValues ?? [],
				topic: message.topic,
			});
			if (made)
				return {
					channel: target,
					address,
					fallbackChain: left,
					...keep(s, { channel: target, address, values: message.values, ...made }),
				};
		}
		return null;
	};

	/**
	 * Attempt a message now and save the outcome: sent; retrying later; on to the fallback channel; or failed. Every
	 * attempt is added to the delivery log; a sent or failed message keeps no sealed words nor defaults. An attempt that
	 * throws (a read of the connection, the settings or the subscriptions failing) is a failed attempt that may be
	 * retried. `failure` records a failed attempt without trying (WhatsApp not set up), so the fallback still applies.
	 * Failures are kept as codes with their values (`core/gateway.js`), the provider's own answer apart as `detail`.
	 * @param {Site} s
	 * @param {MessageRecord} message
	 * @param {import('../core/gateway.js').Failure | null} [failure]
	 * @returns {Promise<MessageRecord>}
	 */
	const attempt = async (s, message, failure = null) => {
		const real = reveal(s, message);
		/** @type {SendOutcome & { provider: string }} */
		const result = failure
			? { ...failed(failure.reason, failure.values ? { values: failure.values } : {}), provider: 'none' }
			: real
				? await deliver(s, real).catch(() => ({ ...failed('interrupted', { retryable: true }), provider: 'none' }))
				: { ...failed('sealed_unreadable'), provider: 'none' };
		/** @type {import('../adapters/store.js').Attempt} */
		const tried = {
			channel: message.channel,
			provider: result.provider,
			at: new Date(now()),
			outcome: result.ok ? 'sent' : 'failed',
			...(result.ok
				? {}
				: {
						reason: result.reason,
						...(result.values ? { reasonValues: result.values } : {}),
						...(result.detail ? { detail: result.detail } : {}),
					}),
		};
		const attempts = [...message.attempts, tried];
		if (result.ok) {
			const sent = await s.store.messages.update(message.id, {
				status: 'sent',
				reason: null,
				reasonValues: null,
				attempts,
				sentAt: new Date(now()),
				leaseUntil: null,
				sealed: null,
				defaults: null,
				expireAt: await expiryOf(s),
			});
			await emit(s, 'message.sent', eventData(sent));
			return sent;
		}
		const tries = message.channelAttempts + 1;
		const next = result.retryable ? nextAttemptAt(tries, now(), message.retryDelays) : null;
		const why = { reason: result.reason, reasonValues: result.values ?? null };
		if (next !== null)
			return s.store.messages.update(message.id, {
				status: 'retrying',
				...why,
				attempts,
				channelAttempts: tries,
				dueAt: new Date(next),
				leaseUntil: null,
			});
		const fallback = real ? await fallbackOf(s, real) : null;
		if (fallback) {
			const moved = await s.store.messages.update(message.id, {
				...fallback,
				attempts,
				channelAttempts: 0,
				retryDelays: [...RETRY_WAITS],
				fellBack: true,
				defaults: null,
				status: 'queued',
				reason: null,
				reasonValues: null,
				dueAt: new Date(now()),
				leaseUntil: new Date(now() + LEASE_MS),
			});
			return attempt(s, moved);
		}
		const final = await s.store.messages.update(message.id, {
			status: 'failed',
			...why,
			attempts,
			channelAttempts: tries,
			leaseUntil: null,
			sealed: null,
			defaults: null,
			expireAt: await expiryOf(s),
		});
		await emit(s, 'message.failed', eventData(final));
		return final;
	};

	/**
	 * Accept a message: opt-out, send limits, quiet hours and delayed send decide when (or whether) it goes; a message
	 * due now is attempted at once. Opt-out stops only optional messages: a required one (by its template, Accounts'
	 * templates or the sender) is always sent (PLAN 0.8.5). Quiet hours hold only messages that are not urgent, and
	 * neither they nor a delayed send ever hold Accounts' messages. A product's message switched off on the channel is
	 * skipped; one on WhatsApp without the merchant's template fails at once as not set up, then goes to the fallback
	 * channel when one is set (parity P1).
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
		/** Set when a product's message has no WhatsApp template of the merchant's: it fails at once (parity P1). */
		let notSetUp = false;
		const declared = Object.values(input.defaults);
		const chosen = await settingsOf(s, input.template);
		// a template's topic comes from its settings; a one-off marketing message names its own
		const topic = input.template === null ? (input.topic ?? null) : chosen.topic;
		if (input.template !== null) {
			if (await switchedOff(s, input.template, input.fallbackTemplate, input.channel))
				return {
					ok: true,
					message: await s.store.messages.add({
						template: input.template,
						fallbackTemplate: input.fallbackTemplate,
						source: input.source,
						channel: input.channel,
						to: input.to,
						address,
						...NO_WORDS,
						values: {},
						hidden: [],
						sealed: null,
						defaults: null,
						required: input.required || declared.some((words) => words.required),
						urgent: false,
						status: 'skipped',
						reason: SWITCHED_OFF,
						reasonValues: null,
						attempts: [],
						channelAttempts: 0,
						retryDelays: [],
						fellBack: false,
						fallbackChain: [],
						topic: null,
						capped: false,
						dueAt: new Date(now()),
						leaseUntil: null,
						sentAt: null,
						expireAt: await expiryOf(s),
					}),
				};
			const found = await fromTemplate(s, {
				key: input.template,
				fallbackKey: input.fallbackTemplate,
				channel: input.channel,
				address,
				values: input.values,
				language: input.language,
				secretValues: input.secretValues,
				defaults: input.defaults,
				longValues: input.longValues,
				topic,
			});
			if (found) made = found;
			else if (input.channel === 'whatsapp' && (await product.defaults.ownerOf(input.template)) !== null) {
				// WhatsApp never has a default: recorded as not set up (and its fallback tried), never dropped silently
				notSetUp = true;
				const sensitive = isAccountKey(input.template) || declared.some((words) => words.sensitive);
				made = {
					required: isAccountKey(input.template) || declared.some((words) => words.required),
					urgent: true,
					words: { ...NO_WORDS },
					shown: { ...NO_WORDS },
					hidden: hiddenNamesOf(input.values, { sensitive, secretValues: input.secretValues }),
				};
			} else
				return {
					ok: false,
					problem: problem(
						'template_not_found',
						`There is no ${input.channel} template ${input.template}. Add it in the templates.`,
					),
				};
		} else {
			const content = /** @type {{ subject: string, text: string }} */ (input.content);
			// a one-off message from the merchant's staff is written for this person now: transactional (required and
			// urgent) or marketing (neither: unsubscribes, quiet hours and send limits apply)
			/** @type {Words} */
			const words = {
				subject: content.subject,
				text: content.text,
				parameters: [],
				providerTemplate: '',
				buttons: [],
				language: DEFAULT_LANGUAGE,
			};
			made = { required: input.required, urgent: input.required, words, shown: words, hidden: [] };
		}
		const t = now();
		const required = made.required || input.required;
		const limits = s.on.includes('send_limits') ? await product.settings.values(s.websiteId, 'send_limits') : null;
		/** @type {Omit<MessageRecord, 'id' | 'createdAt'>} */
		const base = {
			template: input.template,
			fallbackTemplate: input.fallbackTemplate,
			source: input.source,
			channel: input.channel,
			to: input.to,
			address,
			...keep(s, { channel: input.channel, address, values: input.values, ...made }),
			defaults: declared.length > 0 ? input.defaults : null,
			...(input.longValues.length > 0 ? { longValues: input.longValues } : {}),
			required,
			urgent: made.urgent,
			status: 'queued',
			reason: null,
			reasonValues: null,
			attempts: [],
			channelAttempts: 0,
			retryDelays: [...RETRY_WAITS],
			fellBack: false,
			// its fallback channels, kept: its template's own, else the website's for its channel (fixed-choices N7)
			fallbackChain: fallbackChainOf(
				{ channel: input.channel, template: input.template },
				{ templates: chosen.templates, chains: await product.lists.fallbackChains(s.websiteId) },
			),
			topic,
			// send limits count it: as its template says, else every message ("all") or only optional ones (N5)
			capped: chosen.capped ?? (limits?.counts === 'all' || !required),
			dueAt: new Date(t),
			leaseUntil: null,
			sentAt: null,
		};
		if (!base.required && (await optedOut(s, address, topic)))
			return {
				ok: true,
				message: await s.store.messages.add({
					...base,
					status: 'skipped',
					reason: 'unsubscribed',
					reasonValues: null,
					sealed: null,
					defaults: null,
					expireAt: await expiryOf(s),
				}),
			};
		if (limits && base.capped) {
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
						reasonValues: null,
						sealed: null,
						defaults: null,
						expireAt: await expiryOf(s),
					}),
				};
		}
		// the hard ceilings: whatever the merchant's limits say, required messages too (SR-7-2)
		const hit = await ceilingHit(s, { channel: input.channel, address, template: input.template });
		if (hit)
			return {
				ok: false,
				problem: problem('rate_limited', hit.detail, { errors: [{ path: '/to', message: hit.detail, code: hit.code }] }),
			};
		if (notSetUp) {
			const message = await s.store.messages.add({ ...base, leaseUntil: new Date(t + LEASE_MS) });
			return {
				ok: true,
				message: await attempt(s, message, notSetUpFailure(/** @type {string} */ (input.template), input.fallbackTemplate)),
			};
		}
		// Accounts' messages (sign-in codes and links) go at once: a delayed send never holds them either
		let dueAt = input.template !== null && isAccountKey(input.template) ? t : (input.sendAt ?? t);
		if (!made.urgent && s.on.includes('quiet_hours')) {
			const windows = await product.lists.quietHours(s.websiteId);
			const timeZone = input.to.timeZone ?? (await product.business(s.websiteId)).timeZone ?? 'UTC';
			dueAt = quietUntil(dueAt, windows, timeZone, input.channel);
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
		/** @type {import('../core/gateway.js').Failure | null} */
		let error = null;
		if (typeof secret !== 'string') error = { reason: 'not_connected', values: { connection: 'webhook_secret' } };
		else {
			try {
				const response = await product.send(event.url, {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						[SIGNATURE_HEADER]: signWebhook({ body: event.body, secret, now }),
					},
					body: event.body,
					timeoutMs: 10_000,
					redirect: 'error',
				});
				if (response.status < 200 || response.status > 299)
					error = { reason: 'provider_status', values: { status: String(response.status) } };
			} catch (caught) {
				error = { reason: 'provider_unreachable', values: { cause: isNetError(caught) ? caught.code : 'network' } };
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
		// an event is tried again on the webhooks' own, longer waits
		const next = nextAttemptAt(attempts, now(), WEBHOOK_RETRY_WAITS);
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
			if (!message.required && (await optedOut(s, message.address, message.topic)))
				await s.store.messages.update(message.id, {
					status: 'skipped',
					reason: 'unsubscribed',
					reasonValues: null,
					leaseUntil: null,
					sealed: null,
					defaults: null,
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
	 * Unsubscribe an address from every optional message, or from one topic (link or keyword); tells the webhooks once
	 * (`topic` names the topic, null: every optional message).
	 * @param {Site} s
	 * @param {string} address
	 * @param {'link' | 'keyword'} via
	 * @param {string | null} [topic]
	 */
	const unsubscribe = async (s, address, via, topic = null) => {
		const added =
			topic === null
				? await s.store.optouts.add(address, via)
				: (await s.store.topicOptouts.set(address, [topic], via, { only: false })).length > 0;
		if (added) await emit(s, 'recipient.unsubscribed', { address, via, topic });
	};

	/**
	 * A recipient's choices on the hosted page (fixed-choices N2): the topics they keep; every other topic of the website
	 * is unsubscribed, and "every optional message" is lifted. Tells the webhooks of each topic newly unsubscribed.
	 * @param {Site} s
	 * @param {string} address
	 * @param {string[]} keep the topic ids the recipient keeps
	 */
	const choose = async (s, address, keep) => {
		const topics = await product.lists.topics(s.websiteId);
		const dropped = topics.map((topic) => topic.id).filter((id) => !keep.includes(id));
		await s.store.optouts.remove(address);
		for (const topic of await s.store.topicOptouts.set(address, dropped, 'link', { only: true }))
			await emit(s, 'recipient.unsubscribed', { address, via: 'link', topic });
	};

	/**
	 * A recipient's choices as the hosted page shows them: unsubscribed from every optional message, and the topics they
	 * still get.
	 * @param {Site} s
	 * @param {string} address
	 */
	const choicesOf = async (s, address) => {
		const [all, topics, out] = await Promise.all([
			s.store.optouts.has(address),
			product.lists.topics(s.websiteId),
			s.store.topicOptouts.of(address),
		]);
		return { all, topics: topics.map((topic) => ({ ...topic, subscribed: !all && !out.includes(topic.id) })) };
	};

	return Object.freeze({ site, accept, drain, unsubscribe, choose, choicesOf, relay });
};

/** @typedef {ReturnType<typeof createSending>} Sending */
