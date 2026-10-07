/**
 * The Mode C client the headless cores use, built on any `@ss/web/element` API client (`createElementApi({ baseUrl,
 * key: 'pk_…', identity: { token: () => session.token() } })`): one method per operation, each returning a Result
 * (`{ ok: true, value } | { ok: false, error: Problem }` with a stable `error.code`). Framework-free and DOM-free.
 * @module
 */

/**
 * @typedef {{ code: string, status?: number, detail?: string, errors?: ReadonlyArray<{ path: string, code: string, message: string }> }} Problem
 * @typedef {{ ok: true, value: any } | { ok: false, error: Problem }} Result
 * @typedef {{ get: (path: string, options?: any) => Promise<Result>, post: (path: string, body?: unknown, options?: any) => Promise<Result>,
 *   patch: (path: string, body?: unknown, options?: any) => Promise<Result>, delete: (path: string, options?: any) => Promise<Result> }} ElementApi
 */

/**
 * @param {{ api: ElementApi }} input
 */
export const createSignupsClient = ({ api }) =>
	Object.freeze({
		/** @param {{ channel: string, to: string, purpose?: string, locale?: string, deviceId?: string }} body */
		requestCode: (body) => api.post('/v1/otp', body),
		/** @param {string} challengeId @param {{ code: string, deviceId?: string, consents?: Array<{ key: string, version: string }> }} body */
		verifyCode: (challengeId, body) => api.post(`/v1/otp/${encodeURIComponent(challengeId)}/verify`, body),
		/** @param {{ email: string, redirect?: string, locale?: string, deviceId?: string }} body */
		requestLink: (body) => api.post('/v1/magic-links', body),
		/** @param {{ token: string, deviceId?: string, consents?: Array<{ key: string, version: string }> }} body */
		consumeLink: (body) => api.post('/v1/magic-links:consume', body),
		/** @param {string} refreshToken */
		refresh: (refreshToken) => api.post('/v1/sessions:refresh', { refreshToken }),
		/** @param {string} refreshToken */
		logout: (refreshToken) => api.post('/v1/sessions:logout', { refreshToken }),
		account: () => api.get('/v1/account'),
		/** @param {Record<string, unknown>} patch */
		updateProfile: (patch) => api.patch('/v1/profile', patch),
		/** @param {string} id */
		revokeSession: (id) => api.delete(`/v1/sessions/${encodeURIComponent(id)}`),
		revokeAll: () => api.post('/v1/sessions:revoke-all', {}),
		/** @param {'export' | 'delete'} type */
		requestData: (type) => api.post('/v1/data-requests', { type }),
		/** @param {string} id */
		downloadExport: (id) => api.get(`/v1/data-requests/${encodeURIComponent(id)}/export`),
		/** @param {string} id */
		cancelDataRequest: (id) => api.delete(`/v1/data-requests/${encodeURIComponent(id)}`),
		/** @param {Array<{ key: string, version: string }>} consents */
		acceptConsents: (consents) => api.post('/v1/consents', { consents }),
	});

/** @typedef {ReturnType<typeof createSignupsClient>} SignupsClient */
