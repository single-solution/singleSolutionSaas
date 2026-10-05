/**
 * Mode B headless core of the `claims` element: state, actions, subscribe, validate, strings, destroy (Part E §4).
 * Framework-agnostic and DOM-free. `client` is the element's Mode C client (`@ss/web/element` `createElementApi` with the
 * website's `pk_` key and, when the shopper is signed in, the website's own login token as `SS-Identity`). The default
 * renderer (ui/claims.js) and any merchant-built UI use exactly this core:
 *
 * - signed-in customers see their purchases with what is still claimable, their claims and each claim's conversation;
 * - guests prove a purchase with its order number and the e-mail or phone used, and get a claim token kept in state
 *   (pass `config.token` to resume from a link);
 * - the claim form: type, reason, lines and quantities, serials, description and evidence photos uploaded straight to
 *   the merchant's bucket through the presigned slot (the injected `upload`, default `fetch`).
 */
import { createTranslator } from './strings.js';

/** @typedef {{ code?: string, status?: number, detail?: string, errors?: Array<{ path: string, code: string }> }} Problem */
/**
 * @template T
 * @typedef {{ ok: true, value: T } | { ok: false, error: Problem }} Result
 */
/**
 * @typedef {object} ClaimsClient the Mode C client (`@ss/web/element` ElementApi subset)
 * @property {(path: string, options?: { query?: Record<string, string | number | boolean | undefined> }) => Promise<Result<any>>} get
 * @property {(path: string, body?: unknown) => Promise<Result<any>>} post
 */
/**
 * @typedef {{ type: string, size: number, body: unknown }} PhotoFile a file to upload (`body`: a Blob, a stream, bytes)
 * @typedef {(target: { method: string, url: string, headers: Record<string, string> }, file: PhotoFile) => Promise<boolean>} Uploader
 */
/**
 * @typedef {object} Draft
 * @property {string | null} purchaseId
 * @property {string | null} type
 * @property {string | null} reason
 * @property {string} details
 * @property {Readonly<Record<string, number>>} quantities per line id (0 = not claimed)
 * @property {Readonly<Record<string, string>>} serials per line id
 * @property {ReadonlyArray<string>} photoIds
 */
/**
 * @typedef {object} ClaimsState
 * @property {'idle' | 'loading' | 'ready' | 'error'} status
 * @property {'identity' | 'guest' | 'signin'} mode who the shopper is: signed in, guest with a token, or must sign in /
 *   prove a purchase first
 * @property {Record<string, any> | null} form `GET /v1/claim-form`
 * @property {ReadonlyArray<Record<string, any>>} purchases
 * @property {ReadonlyArray<Record<string, any>>} claims
 * @property {string | null} token guest claim token
 * @property {Draft} draft
 * @property {'idle' | 'submitting' | 'submitted' | 'error'} submit
 * @property {'idle' | 'uploading' | 'error'} upload
 * @property {ReadonlyArray<{ path: string, code: string, message: string }>} errors
 * @property {{ claim: Record<string, any>, messages: ReadonlyArray<Record<string, any>> } | null} active
 * @property {string | null} message resolved, user-facing notice
 * @property {string | null} error resolved, user-facing error
 */

const ERROR_KEYS = Object.freeze([
	'identity_required',
	'identity_invalid',
	'invalid_token',
	'not_found',
	'not_eligible',
	'quantity_unavailable',
	'serial_mismatch',
	'claim_limit',
	'access_disabled',
	'photo_invalid',
	'messages_closed',
	'rate_limited',
	'validation_failed',
]);

/** @type {Draft} */
const EMPTY_DRAFT = Object.freeze({
	purchaseId: null,
	type: null,
	reason: null,
	details: '',
	quantities: Object.freeze({}),
	serials: Object.freeze({}),
	photoIds: Object.freeze([]),
});

/** @type {Uploader} */
const fetchUpload = async (target, file) => {
	const send = globalThis.fetch;
	if (typeof send !== 'function') return false;
	const headers = Object.fromEntries(Object.entries(target.headers).filter(([name]) => name.toLowerCase() !== 'content-length'));
	try {
		const response = await send(target.url, { method: target.method, headers, body: /** @type {any} */ (file.body) });
		return response.ok;
	} catch {
		return false;
	}
};

/**
 * @param {{ config?: Record<string, any>, strings?: Record<string, string>, client: ClaimsClient, identity?: unknown,
 *   emit?: (name: string, data: Record<string, unknown>) => void, upload?: Uploader }} options
 */
export const createClaims = ({ config = {}, strings = {}, client, identity = null, emit = () => {}, upload = fetchUpload }) => {
	const t = createTranslator(strings);
	/** @type {Set<(state: ClaimsState) => void>} */
	const listeners = new Set();
	let destroyed = false;
	/** @type {ClaimsState} */
	let state = Object.freeze({
		status: 'idle',
		mode: identity ? 'identity' : 'signin',
		form: null,
		purchases: [],
		claims: [],
		token: typeof config.token === 'string' ? config.token : null,
		draft: EMPTY_DRAFT,
		submit: 'idle',
		upload: 'idle',
		errors: [],
		active: null,
		message: null,
		error: null,
	});
	/** @param {Partial<ClaimsState>} patch */
	const set = (patch) => {
		if (destroyed) return;
		state = Object.freeze({ ...state, ...patch });
		for (const listener of listeners) listener(state);
	};
	/** @param {Problem} problem */
	const messageOf = (problem) =>
		t(problem.code && ERROR_KEYS.includes(problem.code) ? `claims.error.${problem.code}` : 'claims.error.request_failed');

	/** @param {string} code */
	const fieldMessage = (code) =>
		t(`claims.field.${code}`) === `claims.field.${code}` ? t('claims.field.invalid') : t(`claims.field.${code}`);

	/** Guest data from a claim token. @param {string | null} [claimId] @returns {Promise<Result<any>>} */
	const viewToken = async (claimId = null) =>
		client.post('/v1/claims:view', { token: state.token, ...(claimId ? { claimId } : {}) });

	/** Reload purchases and claims for the current mode. @returns {Promise<Result<any>>} */
	const refresh = async () => {
		if (state.token) {
			const result = await viewToken();
			if (!result.ok) {
				set({ status: 'ready', mode: 'signin', token: null, error: messageOf(result.error) });
				return result;
			}
			set({ status: 'ready', mode: 'guest', purchases: [result.value.purchase], claims: result.value.claims, error: null });
			return result;
		}
		const purchases = await client.get('/v1/purchases');
		if (!purchases.ok) {
			const signin = purchases.error.code === 'identity_required' || purchases.error.status === 401;
			set({
				status: signin ? 'ready' : 'error',
				mode: 'signin',
				error: signin ? null : messageOf(purchases.error),
			});
			return purchases;
		}
		const claims = await client.get('/v1/claims');
		set({
			status: 'ready',
			mode: 'identity',
			purchases: purchases.value.items ?? [],
			claims: claims.ok ? (claims.value.items ?? []) : [],
			error: claims.ok ? null : messageOf(claims.error),
		});
		return claims.ok ? purchases : claims;
	};

	/** The selected purchase. */
	const purchaseOf = () => state.purchases.find((purchase) => purchase.id === state.draft.purchaseId) ?? null;

	/**
	 * Validate a draft like the API does (rules from `GET /v1/claim-form` and the purchase's eligibility).
	 * @param {Draft} [draft]
	 * @returns {Array<{ path: string, code: string, message: string }>}
	 */
	const validate = (draft = state.draft) => {
		const form = state.form;
		if (!form) return [];
		/** @type {Array<{ path: string, code: string }>} */
		const problems = [];
		const purchase = state.purchases.find((entry) => entry.id === draft.purchaseId);
		if (!purchase) problems.push({ path: '/purchaseId', code: 'required' });
		const type = /** @type {Array<Record<string, any>>} */ (form.types).find((entry) => entry.key === draft.type);
		if (!type) problems.push({ path: '/type', code: 'required' });
		const reason = /** @type {Array<Record<string, any>>} */ (form.reasons).find((entry) => entry.key === draft.reason);
		if (!reason || (type && reason.types.length > 0 && !reason.types.includes(type.key)))
			problems.push({ path: '/reason', code: 'required' });
		const minDetails = Math.max(type?.detailsMinLength ?? 0, reason?.detailsRequired ? 1 : 0);
		if (draft.details.trim().length < minDetails) problems.push({ path: '/details', code: 'too_short' });
		if (draft.details.length > form.details.maxLength) problems.push({ path: '/details', code: 'too_long' });
		const chosen = Object.entries(draft.quantities).filter(([, quantity]) => quantity > 0);
		if (chosen.length === 0) problems.push({ path: '/lines', code: 'required' });
		for (const [lineId, quantity] of chosen) {
			const line = /** @type {Array<Record<string, any>>} */ (purchase?.lines ?? []).find((entry) => entry.lineId === lineId);
			if (!line || quantity > line.claimable || (type && line.windows[type.key]?.eligible !== true))
				problems.push({ path: `/lines/${lineId}`, code: 'not_eligible' });
			if (type?.requireSerial && !draft.serials[lineId]?.trim())
				problems.push({ path: `/serials/${lineId}`, code: 'required' });
		}
		if (type && draft.photoIds.length < type.minPhotos) problems.push({ path: '/photoIds', code: 'photos_required' });
		return problems.map((problem) => ({ ...problem, message: fieldMessage(problem.code) }));
	};

	/** @param {Array<{ path: string, code: string }>} [errors] */
	const asFieldErrors = (errors = []) => errors.map((error) => ({ ...error, message: fieldMessage(error.code) }));

	const actions = Object.freeze({
		/** Load the form definition and the shopper's purchases and claims. @returns {Promise<Result<any>>} */
		load: async () => {
			set({ status: 'loading', error: null });
			const form = await client.get('/v1/claim-form');
			if (!form.ok) {
				set({ status: 'error', error: messageOf(form.error) });
				return form;
			}
			set({ form: form.value });
			return refresh();
		},
		refresh,
		/**
		 * Guests: prove a purchase with its order number and the e-mail or phone used.
		 * @param {{ number: string, email?: string, phone?: string }} input
		 * @returns {Promise<Result<any>>}
		 */
		access: async (input) => {
			const body = Object.fromEntries(
				Object.entries(input).filter(([, value]) => typeof value === 'string' && value.trim() !== ''),
			);
			const result = await client.post('/v1/claim-access', body);
			if (!result.ok) {
				set({ error: messageOf(result.error) });
				return result;
			}
			set({ token: result.value.token, draft: { ...EMPTY_DRAFT, purchaseId: result.value.purchaseId } });
			emit('claims.access', {});
			return refresh();
		},
		/** @param {string} purchaseId */
		selectPurchase: (purchaseId) => set({ draft: { ...EMPTY_DRAFT, purchaseId }, errors: [], submit: 'idle', message: null }),
		/**
		 * Change the draft (type, reason, details, a line's quantity or serial).
		 * @param {{ type?: string, reason?: string, details?: string, lineId?: string, quantity?: number, serial?: string }} patch
		 */
		setDraft: (patch) => {
			const { lineId, quantity, serial, ...fields } = patch;
			set({
				draft: {
					...state.draft,
					...fields,
					...(lineId && quantity !== undefined
						? { quantities: { ...state.draft.quantities, [lineId]: Math.max(0, Math.floor(quantity)) } }
						: {}),
					...(lineId && serial !== undefined ? { serials: { ...state.draft.serials, [lineId]: serial } } : {}),
				},
			});
		},
		/**
		 * Upload one evidence photo to the merchant's bucket and add it to the draft.
		 * @param {PhotoFile} file
		 * @returns {Promise<Result<any>>}
		 */
		addPhoto: async (file) => {
			set({ upload: 'uploading', error: null });
			const slot = await client.post('/v1/claim-photos', {
				contentType: file.type,
				size: file.size,
				...(state.token ? { token: state.token } : {}),
			});
			if (!slot.ok) {
				set({ upload: 'error', error: messageOf(slot.error) });
				return slot;
			}
			if (!(await upload(slot.value.upload, file))) {
				set({ upload: 'error', error: t('claims.error.upload_failed') });
				return { ok: false, error: { code: 'upload_failed' } };
			}
			set({ upload: 'idle', draft: { ...state.draft, photoIds: [...state.draft.photoIds, slot.value.id] } });
			return slot;
		},
		/** @param {string} photoId */
		removePhoto: (photoId) => set({ draft: { ...state.draft, photoIds: state.draft.photoIds.filter((id) => id !== photoId) } }),
		/** Submit the draft. @returns {Promise<Result<any>>} */
		submit: async () => {
			const errors = validate();
			if (errors.length > 0) {
				set({ errors, submit: 'error' });
				return { ok: false, error: { code: 'validation_failed', errors } };
			}
			const { draft } = state;
			set({ submit: 'submitting', errors: [], error: null });
			const result = await client.post('/v1/claims', {
				purchaseId: draft.purchaseId,
				type: draft.type,
				reason: draft.reason,
				...(draft.details.trim() ? { details: draft.details.trim() } : {}),
				lines: Object.entries(draft.quantities)
					.filter(([, quantity]) => quantity > 0)
					.map(([lineId, quantity]) => ({
						lineId,
						quantity,
						...(draft.serials[lineId]?.trim() ? { serial: draft.serials[lineId]?.trim() } : {}),
					})),
				...(draft.photoIds.length > 0 ? { photoIds: [...draft.photoIds] } : {}),
				...(state.token ? { token: state.token } : {}),
			});
			if (!result.ok) {
				set({ submit: 'error', errors: asFieldErrors(result.error.errors), error: messageOf(result.error) });
				return result;
			}
			set({
				submit: 'submitted',
				draft: EMPTY_DRAFT,
				message: t('claims.submitted', { reference: result.value.reference }),
			});
			emit('claims.submitted', { type: result.value.type });
			await refresh();
			return result;
		},
		/**
		 * Open a claim with its conversation (when messages are on).
		 * @param {string} claimId
		 * @returns {Promise<Result<any>>}
		 */
		openClaim: async (claimId) => {
			if (state.token) {
				const result = await viewToken(claimId);
				if (!result.ok) {
					set({ error: messageOf(result.error) });
					return result;
				}
				const claim = result.value.claims.find((/** @type {any} */ entry) => entry.id === claimId);
				set({ active: { claim, messages: result.value.messages ?? [] }, error: null });
				return result;
			}
			const claim = await client.get(`/v1/claims/${encodeURIComponent(claimId)}`);
			if (!claim.ok) {
				set({ error: messageOf(claim.error) });
				return claim;
			}
			const messages = state.form?.messages?.enabled
				? await client.get('/v1/messages', { query: { 'filter[claimId]': claimId } })
				: null;
			set({ active: { claim: claim.value, messages: messages?.ok ? (messages.value.items ?? []) : [] }, error: null });
			return claim;
		},
		closeClaim: () => set({ active: null }),
		/**
		 * Write to the staff on the open claim.
		 * @param {string} body
		 * @returns {Promise<Result<any>>}
		 */
		sendMessage: async (body) => {
			const claim = state.active?.claim;
			if (!claim || body.trim() === '') return { ok: false, error: { code: 'validation_failed' } };
			const result = await client.post('/v1/messages', {
				claimId: claim.id,
				body: body.trim(),
				...(state.token ? { token: state.token } : {}),
			});
			if (!result.ok) {
				set({ error: messageOf(result.error) });
				return result;
			}
			set({ active: { claim, messages: [...(state.active?.messages ?? []), result.value] }, error: null });
			emit('claims.message', {});
			return result;
		},
	});

	return Object.freeze({
		/** @returns {ClaimsState} immutable snapshot */
		state: () => state,
		actions,
		/**
		 * @param {(state: ClaimsState) => void} listener
		 * @returns {() => void}
		 */
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		validate,
		selectedPurchase: purchaseOf,
		strings,
		t,
		destroy: () => {
			destroyed = true;
			listeners.clear();
		},
	});
};
