/**
 * Mode B headless core of the `account_pages` element: the signed-in customer's profile, addresses, devices,
 * orders, agreements and data requests (Part E §4). Framework-agnostic and DOM-free; the default renderer
 * (ui/account.js) and any merchant-built UI use exactly this core. Every call carries the customer's access token
 * (`SS-Identity`, refreshed through the session store first).
 * @module
 */
import { createTranslator } from './strings.js';

/** @typedef {import('./client.js').SignupsClient} SignupsClient */
/** @typedef {import('./client.js').Problem} Problem */
/** @typedef {import('./session.js').SessionStore} SessionStore */
/**
 * @typedef {object} AccountState
 * @property {'idle' | 'loading' | 'ready' | 'signed_out' | 'error'} status
 * @property {string} page active section
 * @property {readonly string[]} pages
 * @property {'tabs' | 'stacked'} layout
 * @property {Record<string, any> | null} customer
 * @property {ReadonlyArray<Record<string, any>>} fields profile field schema
 * @property {ReadonlyArray<Record<string, any>>} sessions
 * @property {ReadonlyArray<Record<string, any>>} orders
 * @property {ReadonlyArray<Record<string, any>>} consents
 * @property {{ export: boolean, delete: boolean, pendingDeletion: Record<string, any> | null } | null} data
 * @property {boolean} busy
 * @property {string | null} notice
 * @property {string | null} error resolved, user-facing message
 */

/**
 * @param {{ config?: Record<string, any>, strings?: Record<string, string>, client: SignupsClient, session: SessionStore,
 *   emit?: (name: string, data: Record<string, unknown>) => void }} options
 */
export const createAccount = ({ config = {}, strings = {}, client, session, emit = () => {} }) => {
	const t = createTranslator(strings);
	/** @type {Set<(state: AccountState) => void>} */
	const listeners = new Set();
	let destroyed = false;
	const pages = /** @type {string[]} */ (Array.isArray(config.pages) && config.pages.length > 0 ? config.pages : ['profile']);
	/** @type {AccountState} */
	let state = Object.freeze({
		status: 'idle',
		page: /** @type {string} */ (pages[0]),
		pages,
		layout: config.layout === 'stacked' ? 'stacked' : 'tabs',
		customer: null,
		fields: [],
		sessions: [],
		orders: [],
		consents: [],
		data: null,
		busy: false,
		notice: null,
		error: null,
	});
	/** @param {Partial<AccountState>} patch */
	const set = (patch) => {
		if (destroyed) return;
		state = Object.freeze({ ...state, ...patch });
		for (const listener of listeners) listener(state);
	};
	/** @param {Problem} error */
	const failed = (error) => {
		const signedOut = error.code === 'identity_required' || error.code === 'identity_invalid';
		if (signedOut) session.clear();
		set({
			status: signedOut ? 'signed_out' : state.customer ? 'ready' : 'error',
			busy: false,
			notice: null,
			error: t(signedOut ? 'account.signin_required' : 'account.error.request_failed'),
		});
		return { ok: /** @type {const} */ (false), error };
	};
	/**
	 * Run an authenticated call (refreshing the access token first).
	 * @template T
	 * @param {() => Promise<{ ok: true, value: T } | { ok: false, error: Problem }>} call
	 */
	const authed = async (call) => {
		if (!(await session.ensureFresh(client))) return failed({ code: 'identity_required' });
		return call();
	};
	/** @param {Record<string, any>} view */
	const apply = (view) =>
		set({
			status: 'ready',
			pages: view.pages ?? pages,
			page: (view.pages ?? pages).includes(state.page) ? state.page : (view.pages?.[0] ?? state.page),
			layout: view.layout === 'stacked' ? 'stacked' : 'tabs',
			customer: view.customer,
			fields: view.fields ?? [],
			sessions: view.sessions ?? [],
			orders: view.orders ?? [],
			consents: view.consents ?? [],
			data: view.data ?? null,
			busy: false,
			error: null,
		});

	const load = async () => {
		set({ status: state.customer ? state.status : 'loading', error: null });
		const result = await authed(() => client.account());
		if (!result.ok) return failed(result.error);
		apply(result.value);
		emit('account_pages.viewed', { page: state.page });
		return result;
	};

	/**
	 * A change followed by a reload.
	 * @param {() => Promise<{ ok: boolean, value?: any, error?: Problem }>} call
	 * @param {string | null} notice
	 * @param {string} event
	 */
	const change = async (call, notice, event) => {
		set({ busy: true, notice: null, error: null });
		const result = await authed(/** @type {any} */ (call));
		if (!result.ok) return failed(/** @type {Problem} */ (result.error));
		await load();
		set({ notice });
		emit(event, {});
		return result;
	};

	const actions = Object.freeze({
		load,
		/** @param {string} page */
		setPage: async (page) => {
			if (state.pages.includes(page)) set({ page, notice: null });
			return { ok: true, value: state.page };
		},
		/** @param {{ profile?: Record<string, unknown>, addresses?: unknown[], custom?: Record<string, unknown> }} patch */
		saveProfile: (patch) =>
			change(() => client.updateProfile(patch), t('account.profile.saved'), 'account_pages.profile_saved'),
		/** @param {string} id */
		revokeSession: (id) => change(() => client.revokeSession(id), null, 'account_pages.session_revoked'),
		revokeAll: async () => {
			const result = await authed(() => client.revokeAll());
			if (!result.ok) return failed(result.error);
			session.clear();
			set({ status: 'signed_out', customer: null, sessions: [] });
			emit('account_pages.signed_out_everywhere', {});
			return result;
		},
		/** The customer's data as JSON (the caller offers it as a download). */
		exportData: async () => {
			set({ busy: true, error: null });
			const requested = await authed(() => client.requestData('export'));
			if (!requested.ok) return failed(requested.error);
			const result = await authed(() => client.downloadExport(requested.value.id));
			if (!result.ok) return failed(result.error);
			set({ busy: false });
			emit('account_pages.exported', {});
			return result;
		},
		requestDeletion: () => change(() => client.requestData('delete'), null, 'account_pages.deletion_requested'),
		cancelDeletion: async () => {
			const pending = state.data?.pendingDeletion;
			if (!pending) return failed({ code: 'not_found' });
			return change(() => client.cancelDataRequest(pending.id), null, 'account_pages.deletion_cancelled');
		},
		/** @param {Array<{ key: string, version: string }>} consents */
		acceptConsents: (consents) => change(() => client.acceptConsents(consents), null, 'account_pages.consents_accepted'),
	});

	return Object.freeze({
		/** @returns {AccountState} immutable snapshot */
		state: () => state,
		actions,
		/**
		 * @param {(state: AccountState) => void} listener
		 * @returns {() => void}
		 */
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		/**
		 * Profile values against the field schema (types only; the server enforces everything).
		 * @param {{ profile?: Record<string, unknown> }} input
		 * @returns {Array<{ path: string, code: string, message: string }>}
		 */
		validate: (input) =>
			Object.entries(input?.profile ?? {}).flatMap(([key, value]) => {
				const field = state.fields.find((f) => f.key === key);
				if (!field) return [{ path: `/profile/${key}`, code: 'unknown_field', message: key }];
				const okType =
					value === null ||
					(field.type === 'boolean'
						? typeof value === 'boolean'
						: field.type === 'number'
							? typeof value === 'number'
							: typeof value === 'string');
				return okType ? [] : [{ path: `/profile/${key}`, code: 'type', message: field.label ?? key }];
			}),
		strings,
		t,
		destroy: () => {
			destroyed = true;
			listeners.clear();
		},
	});
};
