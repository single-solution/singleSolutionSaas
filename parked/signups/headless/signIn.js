/**
 * Mode B headless core of the `widget` element (sign-in): state, actions, subscribe, validate, strings, destroy
 * (Part E §4). Framework-agnostic and DOM-free; the default renderer (ui/signIn.js) and any merchant-built UI use
 * exactly this core. Steps: identifier → code sent (or link sent) → verify → (terms, when the website requires them)
 * → signed in. Tokens go to the injected session store; `emit` reports `widget.*` events (never identifiers or codes).
 * @module
 */
import { createTranslator } from './strings.js';

/** @typedef {import('./client.js').SignupsClient} SignupsClient */
/** @typedef {import('./client.js').Problem} Problem */
/** @typedef {import('./session.js').SessionStore} SessionStore */
/** @typedef {{ key: string, version: string, title?: string, url?: string }} ConsentDoc */
/**
 * @typedef {object} SignInState
 * @property {'idle' | 'sending' | 'code_sent' | 'link_sent' | 'verifying' | 'consent' | 'signed_in'} status
 * @property {'otp' | 'magic_link'} method
 * @property {string} channel
 * @property {readonly string[]} channels
 * @property {readonly string[]} methods
 * @property {boolean} autofill offer one-time-code autofill
 * @property {string} identifier
 * @property {string} code
 * @property {string | null} destination masked address the message went to
 * @property {string | null} challengeId
 * @property {number} codeLength
 * @property {number} resendAt epoch ms after which a new code can be asked
 * @property {ReadonlyArray<ConsentDoc & { accepted: boolean }>} consents pending documents (status `consent`)
 * @property {Record<string, any> | null} customer
 * @property {string | null} error resolved, user-facing message
 * @property {string | null} errorCode
 */

const KNOWN_ERRORS = new Set([
	'identifier_invalid',
	'channel_disabled',
	'identifier_blocked',
	'too_soon',
	'send_limit',
	'delivery_failed',
	'code_invalid',
	'code_expired',
	'attempts_exhausted',
	'link_invalid',
]);

/**
 * @param {{ config?: Record<string, any>, strings?: Record<string, string>, client: SignupsClient, session: SessionStore,
 *   deviceId?: string | null, now?: () => number, emit?: (name: string, data: Record<string, unknown>) => void }} options
 *   `config`: the widget features plus `channels` / `code_length` (otp) and `documents` (consent) of the website
 */
export const createSignIn = ({
	config = {},
	strings = {},
	client,
	session,
	deviceId = null,
	now = Date.now,
	emit = () => {},
}) => {
	const t = createTranslator(strings);
	const channels = /** @type {string[]} */ (
		Array.isArray(config.channels) && config.channels.length > 0 ? config.channels : ['email']
	);
	const methods = /** @type {string[]} */ (
		Array.isArray(config.methods) && config.methods.length > 0 ? config.methods : ['otp']
	);
	const documents = /** @type {ConsentDoc[]} */ (Array.isArray(config.documents) ? config.documents : []);
	/** @type {Set<(state: SignInState) => void>} */
	const listeners = new Set();
	let destroyed = false;
	/** @type {SignInState} */
	let state = Object.freeze({
		status: session.current() ? 'signed_in' : 'idle',
		method: methods.includes('otp') ? 'otp' : 'magic_link',
		channel: channels.includes(config.default_channel) ? config.default_channel : /** @type {string} */ (channels[0]),
		channels,
		methods,
		autofill: config.autofill !== false,
		identifier: '',
		code: '',
		destination: null,
		challengeId: null,
		codeLength: Number.isInteger(config.code_length) ? config.code_length : 6,
		resendAt: 0,
		consents: [],
		customer: null,
		error: null,
		errorCode: null,
	});
	/** @param {Partial<SignInState>} patch */
	const set = (patch) => {
		if (destroyed) return;
		state = Object.freeze({ ...state, ...patch });
		for (const listener of listeners) listener(state);
	};
	/** @param {Problem} error */
	const failed = (error) => {
		const code = KNOWN_ERRORS.has(error.code) ? error.code : 'request_failed';
		set({ error: t(`signin.error.${code}`), errorCode: error.code });
		emit('widget.failed', { code: error.code });
		return { ok: /** @type {const} */ (false), error };
	};
	/** @type {{ kind: 'code', challengeId: string, code: string } | { kind: 'link', token: string } | null} pending proof awaiting consent */
	let proof = null;

	/**
	 * Sign-in finished or needs consent.
	 * @param {{ ok: boolean, value?: any, error?: Problem }} result
	 * @param {'otp' | 'magic_link'} method
	 */
	const finish = (result, method) => {
		if (result.ok) {
			session.save(result.value.tokens);
			proof = null;
			set({ status: 'signed_in', customer: result.value.customer, code: '', consents: [], error: null, errorCode: null });
			emit('widget.signed_in', { method, created: result.value.created === true });
			return result;
		}
		const error = /** @type {Problem} */ (result.error);
		if (error.code === 'consent_required') {
			const pending = (error.errors ?? []).map((entry) => {
				const key = entry.path.split('/').pop() ?? '';
				const doc = documents.find((d) => d.key === key);
				return { key, version: entry.message, title: doc?.title ?? key, url: doc?.url ?? '', accepted: false };
			});
			set({ status: 'consent', consents: pending, error: null, errorCode: null });
			return result;
		}
		set({ status: proof?.kind === 'link' ? 'idle' : 'code_sent' });
		return failed(error);
	};

	const actions = Object.freeze({
		/** @param {string} channel */
		setChannel: async (channel) => {
			if (channels.includes(channel)) set({ channel, error: null, errorCode: null });
			return { ok: true, value: state.channel };
		},
		/** @param {'otp' | 'magic_link'} method */
		setMethod: async (method) => {
			if (methods.includes(method)) set({ method, channel: method === 'magic_link' ? 'email' : state.channel });
			return { ok: true, value: state.method };
		},
		/** @param {string} value */
		setIdentifier: async (value) => {
			set({ identifier: String(value ?? '').slice(0, 320) });
			return { ok: true, value: state.identifier };
		},
		/** @param {string} value */
		setCode: async (value) => {
			set({ code: String(value ?? '').slice(0, 64) });
			return { ok: true, value: state.code };
		},
		/** Ask for a code (or a new one). */
		requestCode: async () => {
			const problems = validate({ identifier: state.identifier });
			if (problems.length > 0) return failed({ code: 'identifier_invalid' });
			if (state.resendAt > now()) return failed({ code: 'too_soon' });
			set({ status: 'sending', error: null, errorCode: null });
			const result = await client.requestCode({
				channel: state.channel,
				to: state.identifier.trim(),
				...(deviceId ? { deviceId } : {}),
				...(strings.locale ? { locale: strings.locale } : {}),
			});
			if (!result.ok) {
				set({ status: state.challengeId ? 'code_sent' : 'idle' });
				return failed(result.error);
			}
			const value = result.value;
			set({
				status: 'code_sent',
				method: 'otp',
				challengeId: value.challengeId,
				destination: value.destination,
				codeLength: value.codeLength ?? state.codeLength,
				resendAt: now() + (value.resendAfter ?? 0) * 1000,
				code: '',
			});
			emit('widget.code_requested', { channel: state.channel });
			return result;
		},
		/** Verify the typed code. */
		verify: async () => {
			if (!state.challengeId) return failed({ code: 'code_invalid' });
			if (validate({ code: state.code }).length > 0) return failed({ code: 'code_invalid' });
			proof = { kind: 'code', challengeId: state.challengeId, code: state.code };
			set({ status: 'verifying', error: null, errorCode: null });
			return finish(
				await client.verifyCode(state.challengeId, { code: state.code, ...(deviceId ? { deviceId } : {}) }),
				'otp',
			);
		},
		/** E-mail a sign-in link back to `redirect` (default: the page the website configured). @param {string} [redirect] */
		requestLink: async (redirect) => {
			if (validate({ identifier: state.identifier, channel: 'email' }).length > 0)
				return failed({ code: 'identifier_invalid' });
			set({ status: 'sending', error: null, errorCode: null });
			const result = await client.requestLink({
				email: state.identifier.trim(),
				...(redirect ? { redirect } : {}),
				...(deviceId ? { deviceId } : {}),
				...(strings.locale ? { locale: strings.locale } : {}),
			});
			if (!result.ok) {
				set({ status: 'idle' });
				return failed(result.error);
			}
			set({ status: 'link_sent', method: 'magic_link', destination: result.value.destination });
			emit('widget.link_requested', {});
			return result;
		},
		/** Finish a magic-link sign-in with the token from the URL fragment. @param {string} token */
		consumeLink: async (token) => {
			proof = { kind: 'link', token };
			set({ status: 'verifying', error: null, errorCode: null });
			return finish(await client.consumeLink({ token, ...(deviceId ? { deviceId } : {}) }), 'magic_link');
		},
		/** @param {string} key @param {boolean} accepted */
		toggleConsent: async (key, accepted) => {
			set({ consents: state.consents.map((doc) => (doc.key === key ? { ...doc, accepted: Boolean(accepted) } : doc)) });
			return { ok: true, value: state.consents };
		},
		/** Send the accepted documents with the pending code or link. */
		acceptConsents: async () => {
			if (!proof || state.consents.some((doc) => !doc.accepted)) return failed({ code: 'consent_required' });
			const consents = state.consents.map((doc) => ({ key: doc.key, version: doc.version }));
			const pending = proof;
			set({ status: 'verifying', error: null, errorCode: null });
			if (pending.kind === 'code')
				return finish(
					await client.verifyCode(pending.challengeId, { code: pending.code, consents, ...(deviceId ? { deviceId } : {}) }),
					'otp',
				);
			return finish(
				await client.consumeLink({ token: pending.token, consents, ...(deviceId ? { deviceId } : {}) }),
				'magic_link',
			);
		},
		/** Back to the first step. */
		reset: async () => {
			proof = null;
			set({
				status: session.current() ? 'signed_in' : 'idle',
				code: '',
				challengeId: null,
				destination: null,
				consents: [],
				error: null,
				errorCode: null,
			});
			return { ok: true, value: null };
		},
		/** Sign out of this device. */
		signOut: async () => {
			const current = session.current();
			session.clear();
			if (current) await client.logout(current.refreshToken);
			set({ status: 'idle', customer: null, code: '', challengeId: null, destination: null });
			emit('widget.signed_out', {});
			return { ok: true, value: null };
		},
	});

	/**
	 * Light, synchronous checks before calling the API (the server validates for real).
	 * @param {{ identifier?: string, code?: string, channel?: string }} input
	 * @returns {Array<{ path: string, code: string, message: string }>}
	 */
	const validate = (input) => {
		/** @type {Array<{ path: string, code: string, message: string }>} */
		const problems = [];
		if (input.identifier !== undefined) {
			const value = input.identifier.trim();
			const channel = input.channel ?? state.channel;
			const plausible = channel === 'email' ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) : /^\+?[\d\s().-]{6,40}$/.test(value);
			if (!plausible)
				problems.push({ path: '/identifier', code: 'identifier_invalid', message: t('signin.error.identifier_invalid') });
		}
		if (input.code !== undefined && input.code.replace(/[\s.-]/g, '').length !== state.codeLength)
			problems.push({ path: '/code', code: 'code_invalid', message: t('signin.error.code_invalid') });
		return problems;
	};

	return Object.freeze({
		/** @returns {SignInState} immutable snapshot */
		state: () => state,
		actions,
		/**
		 * @param {(state: SignInState) => void} listener
		 * @returns {() => void}
		 */
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		validate,
		strings,
		t,
		/** Seconds until a new code can be asked (0 = now). */
		resendIn: () => Math.max(0, Math.ceil((state.resendAt - now()) / 1000)),
		destroy: () => {
			destroyed = true;
			listeners.clear();
		},
	});
};
