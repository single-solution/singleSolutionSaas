/**
 * Mode C client of the chat window (DOM-free): the conversations REST API on top of an `@ss/web/element`
 * `createElementApi` instance (`request(method, path, { query, body, headers })` → Result). Who the customer is
 * travels in `SS-Identity`: the website's own login token when the site has one (verified by the product), else the
 * guest's marker token issued with the first conversation and kept in the injected `storage`.
 * @module
 */

/** @typedef {{ type?: string, title?: string, status?: number, detail?: string, code?: string, errors?: ReadonlyArray<{ path: string, code: string }> }} Problem */
/**
 * @template T
 * @typedef {{ ok: true, value: T } | { ok: false, error: Problem }} Result
 */
/**
 * @typedef {object} ElementApi
 * @property {(method: string, path: string, options?: { query?: Record<string, unknown>, body?: unknown, headers?: Record<string, string>, idempotencyKey?: string }) => Promise<Result<any>>} request
 */
/**
 * @typedef {object} TokenStorage persists the guest marker (e.g. localStorage behind consent, or memory)
 * @property {() => string | null} get
 * @property {(token: string | null) => void} set
 */

/**
 * In-memory token storage (default; the marker is then lost on reload).
 * @returns {TokenStorage}
 */
export const memoryStorage = () => {
	/** @type {string | null} */
	let token = null;
	return {
		get: () => token,
		set: (value) => {
			token = value;
		},
	};
};

/**
 * @param {{ api: ElementApi, storage?: TokenStorage, identity?: { token: () => string | null | undefined } | null }} options
 */
export const createChatClient = ({ api, storage = memoryStorage(), identity = null }) => {
	/**
	 * Headers: the federated login token wins; else the guest marker.
	 * @returns {Record<string, string>}
	 */
	const headers = () => {
		const federated = identity?.token();
		if (federated) return { 'ss-identity': federated };
		const marker = storage.get();
		return marker ? { 'ss-identity': marker } : {};
	};
	/** @param {Result<any>} result */
	const remember = (result) => {
		const token = result.ok ? result.value?.marker?.token : null;
		if (typeof token === 'string' && token) storage.set(token);
		return result;
	};
	/** @param {string} id */
	const base = (id) => `/v1/conversations/${encodeURIComponent(id)}`;
	return Object.freeze({
		/** @param {{ text?: string, context?: unknown, language?: string, flowId?: string }} [input] */
		start: async (input = {}) => remember(await api.request('POST', '/v1/conversations', { body: input, headers: headers() })),
		/** @param {{ cursor?: string | null, status?: string }} [query] */
		list: (query = {}) =>
			api.request('GET', '/v1/conversations', {
				query: { ...(query.cursor ? { cursor: query.cursor } : {}), ...(query.status ? { status: query.status } : {}) },
				headers: headers(),
			}),
		/** @param {string} id */
		get: (id) => api.request('GET', base(id), { headers: headers() }),
		/**
		 * @param {string} id
		 * @param {{ since?: string | null, before?: string | null, limit?: number, etag?: string | null }} [query]
		 */
		messages: (id, query = {}) =>
			api.request('GET', `${base(id)}/messages`, {
				query: {
					...(query.since ? { since: query.since } : {}),
					...(query.before ? { before: query.before } : {}),
					...(query.limit ? { limit: query.limit } : {}),
				},
				headers: /** @type {Record<string, string>} */ ({
					...headers(),
					...(query.etag ? { 'if-none-match': query.etag } : {}),
				}),
			}),
		/** @param {string} id @param {{ text?: string, action?: Record<string, any> }} body */
		send: (id, body) => api.request('POST', `${base(id)}/messages`, { body, headers: headers() }),
		/** @param {string} id */
		read: (id) => api.request('POST', `${base(id)}/read`, { body: {}, headers: headers() }),
		/** @param {string} id */
		close: (id) => api.request('POST', `${base(id)}/close`, { body: {}, headers: headers() }),
		/** @param {{ conversationId: string, reason?: string }} body */
		handoff: (body) => api.request('POST', '/v1/handoffs', { body, headers: headers() }),
		/** @param {{ conversationId?: string, fields: Record<string, unknown>, consent?: boolean }} body */
		lead: (body) => api.request('POST', '/v1/leads', { body, headers: headers() }),
		/** @param {{ conversationId: string, score: number, comment?: string }} body */
		rate: (body) => api.request('POST', '/v1/ratings', { body, headers: headers() }),
		/** Link the guest's conversations to the signed-in customer (`SS-Identity` = login token). */
		claim: async () => {
			const marker = storage.get();
			const federated = identity?.token();
			if (!marker || !federated) return /** @type {Result<any>} */ ({ ok: true, value: { claimed: 0 } });
			const result = await api.request('POST', '/v1/conversations:claim', {
				body: { marker },
				headers: { 'ss-identity': federated },
			});
			if (result.ok) storage.set(null);
			return result;
		},
		/** @param {{ context: unknown, visitorId?: string | null, sessionId?: string | null }} body */
		proactive: (body) => api.request('POST', '/v1/proactive:evaluate', { body, headers: headers() }),
		/** @param {{ ruleId: string, visitorId?: string | null }} body */
		dismissProactive: (body) => api.request('POST', '/v1/proactive:dismiss', { body, headers: headers() }),
		hasIdentity: () => Boolean(identity?.token() || storage.get()),
	});
};

/** @typedef {ReturnType<typeof createChatClient>} ChatClient */
