/**
 * The product dashboard (PLAN 0.4.3): sessions from Portal launches, the website switcher, rights per role and the
 * dashboard API every product's `app/` pages call.
 *
 * - `GET /sso?launch=` verifies the launch (single use here and at the Portal), creates the `ss_session` cookie
 *   (HttpOnly, Secure, SameSite=Lax, host-only) ending at the launch's `sessionExpiresAt`, and redirects to the
 *   dashboard: `<dashboard>?websiteId=<id>`, or `<dashboard>?view=defaults` for an admin launch without a website.
 * - Merchants reach only the websites of their launch; admins any website that has this product (not removed).
 * - Rights: features on/off → Owner or Support; prices and global defaults → Owner; settings, texts, theme and
 *   connections → the merchant (settings of switched-on features only) and Owner or Support.
 * - Writes are refused unless their Origin is the product's own address; dashboard responses are never framed.
 * @module
 */
import { canonicalOrigin, isProtocolError, verifyLaunch } from '@ss/protocol';
import { currentFeatures } from './connection.js';
import { defineRoute } from './http/routes.js';
import { noContent, problem } from './http/results.js';
import { effectiveStatus } from './status.js';
import { isObject, randomToken, sha256Hex } from './util.js';

/** @typedef {import('./http/handler.js').RequestContext} RequestContext */
/** @typedef {import('./http/results.js').ProblemResult} ProblemResult */
/** @typedef {import('./recent.js').Who} Who */
/**
 * @typedef {object} Session
 * @property {'merchant' | 'admin'} kind
 * @property {string} subject the merchant id or admin id
 * @property {string} name
 * @property {'owner' | 'support'} [role] admins
 * @property {Array<{ websiteId: string, domain: string }>} [websites] merchants: the websites of the launch
 * @property {{ name: string, accent: string, logoUrl: string | null }} branding
 * @property {{ email: string, phone: string, whatsapp?: string }} support
 * @property {number} expiresAt epoch ms
 */

/** Name of the dashboard session cookie. */
export const SESSION_COOKIE = 'ss_session';
/** A widget counts as installed when it was seen within this time. */
export const WIDGET_SEEN_MS = 7 * 24 * 60 * 60_000;
const SWITCHER_PAGES = 50;

/**
 * @param {string | null} header
 * @returns {string | null}
 */
const sessionIdOf = (header) => {
	for (const part of (header ?? '').split(';')) {
		const [key, ...rest] = part.trim().split('=');
		if (key === SESSION_COOKIE) return rest.join('=');
	}
	return null;
};

/** @param {Session} session @returns {Who} */
export const whoOf = (session) => ({
	kind: session.kind,
	id: session.subject,
	name: session.name,
	...(session.role ? { role: session.role } : {}),
});

/**
 * @param {Omit<import('./product.js').Kit, 'dashboard'>} kit
 */
export const createDashboard = (kit) => {
	const { store, manifest, now, randomBytes } = kit;

	/**
	 * Auth of `dashboard` routes: session, role, own-origin writes and website access.
	 * @param {RequestContext} ctx
	 * @param {import('./http/routes.js').CompiledRoute} r
	 * @returns {Promise<{ ok: false, problem: ProblemResult } | { ok: true, session: Session, websiteId: string | null,
	 *   merchantId: string | null, status: import('@ss/contracts').StatusResponse | null }>}
	 */
	const authorize = async (ctx, r) => {
		/** @param {ProblemResult} p */
		const refuse = (p) => /** @type {const} */ ({ ok: false, problem: p });
		const id = sessionIdOf(ctx.headers.get('cookie'));
		const session = id ? /** @type {Session | null} */ (await store.get('sessions', sha256Hex(id))) : null;
		if (!session) return refuse(problem('unauthorized', 'Open this dashboard from the Portal.'));
		const role = session.kind === 'merchant' ? 'merchant' : /** @type {'owner' | 'support'} */ (session.role);
		if (r.roles && !r.roles.includes(role)) return refuse(problem('forbidden', 'Your role cannot do this.'));
		if (ctx.method !== 'GET' && ctx.origin !== canonicalOrigin(new URL(kit.connection.active().baseUrl).origin))
			return refuse(problem('forbidden', 'Changes are accepted only from this dashboard.'));
		const websiteId = ctx.params.websiteId;
		if (websiteId === undefined) return { ok: true, session, websiteId: null, merchantId: null, status: null };
		if (session.kind === 'merchant') {
			if (!(session.websites ?? []).some((site) => site.websiteId === websiteId))
				return refuse(problem('forbidden', 'This website is not yours.'));
			return { ok: true, session, websiteId, merchantId: session.subject, status: null };
		}
		const found = await kit.status.lookup(websiteId);
		if (!found.ok)
			return refuse(found.code === 'portal_unreachable' ? problem('portal_unreachable') : problem('website_not_found'));
		if (found.status.status === 'removed')
			return refuse(problem('website_not_found', 'This website does not have this product.'));
		return { ok: true, session, websiteId, merchantId: found.status.merchantId, status: found.status };
	};

	/**
	 * `GET /sso?launch=`.
	 * @param {RequestContext} ctx
	 */
	const sso = async (ctx) => {
		if (!kit.connection.connected()) return problem('unavailable', 'This product is not connected to a Portal yet.');
		const { portalUrl, portalKeys, client } = kit.connection.active();
		/** @type {import('@ss/protocol').LaunchClaims} */
		let claims;
		try {
			claims = await verifyLaunch({
				token: ctx.query.launch,
				keyResolver: portalKeys,
				audience: manifest.id,
				issuer: portalUrl,
				now,
				consume: async (jti, expiresAtMs) =>
					!(await store.seen(`launch|${jti}`, expiresAtMs)) && (await client.consumeLaunch(jti)).consumed,
			});
		} catch (error) {
			if (isProtocolError(error))
				return problem('invalid_token', 'This link to the dashboard is not valid any more. Open it again from the Portal.');
			return problem('portal_unreachable', 'The Portal cannot be reached. Try again.');
		}
		const expiresAt = Date.parse(claims.sessionExpiresAt);
		const merchant = claims.merchant;
		const admin = claims.admin;
		/** @type {Session & { websiteIds: string[], at: number }} */
		const session = {
			kind: claims.kind,
			subject: claims.sub,
			name: /** @type {{ name: string }} */ (merchant ?? admin).name,
			...(admin ? { role: admin.role } : {}),
			...(merchant ? { websites: merchant.websites.map(({ websiteId, domain }) => ({ websiteId, domain })) } : {}),
			websiteIds: merchant ? merchant.websites.map((site) => site.websiteId) : [],
			branding: claims.branding,
			support: claims.support,
			expiresAt,
			at: now(),
		};
		const id = randomToken(randomBytes, 32);
		await store.put('sessions', sha256Hex(id), session);
		const websiteId = merchant ? merchant.websiteId : (admin?.websiteId ?? null);
		if (websiteId) {
			ctx.after(async () => {
				const found = await kit.status.lookup(websiteId);
				if (found.ok) await kit.business.refresh(websiteId, found.status.domain);
			});
		}
		const dashboard = manifest.endpoints.dashboard;
		const location = `${dashboard}${dashboard.includes('?') ? '&' : '?'}${websiteId ? `websiteId=${encodeURIComponent(websiteId)}` : 'view=defaults'}`;
		const cookie = `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=${new Date(expiresAt).toUTCString()}`;
		return new Response(null, { status: 303, headers: { location, 'set-cookie': cookie, 'cache-control': 'no-store' } });
	};

	/** @param {RequestContext} ctx */
	const sessionOf = (ctx) => /** @type {Session} */ (ctx.session);
	/** @param {RequestContext} ctx */
	const isMerchant = (ctx) => sessionOf(ctx).kind === 'merchant';
	/** @param {RequestContext} ctx */
	const website = (ctx) => /** @type {string} */ (ctx.websiteId);
	/**
	 * The status of the request's website (admins: already looked up by `authorize`).
	 * @param {RequestContext} ctx
	 */
	const statusOf = async (ctx) => {
		if (ctx.status) return ctx.status;
		const found = await kit.status.lookup(website(ctx));
		if (!found.ok) throw found.code === 'portal_unreachable' ? problem('portal_unreachable') : problem('website_not_found');
		return found.status;
	};
	/**
	 * @param {{ ok: true } | { ok: false, problem: ProblemResult }} result
	 * @param {() => unknown} [answer]
	 */
	const outcome = (result, answer = () => noContent()) => (result.ok ? answer() : result.problem);
	/** @param {unknown} body @returns {Record<string, any>} */
	const objectBody = (body) => {
		if (!isObject(body)) throw problem('bad_request', 'Send a JSON object.');
		return body;
	};
	/** Merchants edit only settings of switched-on features. @param {RequestContext} ctx @param {string} feature */
	const editable = async (ctx, feature) => !isMerchant(ctx) || (await kit.reports.isOn(website(ctx), feature));
	/** @param {string} key */
	const splitKey = (key) => {
		const dot = key.indexOf('.');
		return dot > 0 ? { feature: key.slice(0, dot), key: key.slice(dot + 1) } : { feature: '', key };
	};

	/** The switcher: websites grouped by merchant (merchants: their launch websites; admins: every website listed). @param {Session} session */
	const switcher = async (session) => {
		if (session.kind === 'merchant')
			return [
				{
					merchantId: session.subject,
					merchantName: session.name,
					websites: (session.websites ?? []).map((site) => ({ ...site })),
				},
			];
		/** @type {Map<string, { merchantId: string, merchantName: string, websites: Array<{ websiteId: string, domain: string, status: string }> }>} */
		const groups = new Map();
		/** @type {string | null} */
		let cursor = null;
		for (let page = 0; page < SWITCHER_PAGES; page += 1) {
			/** @type {import('@ss/contracts').WebsitesPage} */
			const result = await kit.connection.active().client.websites(cursor);
			for (const row of result.items) {
				const group = groups.get(row.merchantId) ?? {
					merchantId: row.merchantId,
					merchantName: row.merchantName,
					websites: [],
				};
				group.websites.push({ websiteId: row.websiteId, domain: row.domain, status: row.status });
				groups.set(row.merchantId, group);
			}
			if (!result.cursor || result.cursor === cursor) break;
			cursor = result.cursor;
		}
		return [...groups.values()];
	};

	const W = '/v1/dashboard/websites/:websiteId';
	/** @type {import('./http/routes.js').DashboardRole[]} */
	const ADMINS = ['owner', 'support'];
	/** @type {import('./http/routes.js').DashboardRole[]} */
	const OWNER = ['owner'];

	const routes = [
		defineRoute({ method: 'GET', path: '/sso', auth: 'none', handler: sso }),
		defineRoute({
			method: 'GET',
			path: '/v1/dashboard/session',
			auth: 'dashboard',
			handler: async (ctx) => {
				const session = sessionOf(ctx);
				try {
					return {
						who: whoOf(session),
						portalUrl: kit.connection.active().portalUrl,
						branding: session.branding,
						support: session.support,
						expiresAt: new Date(session.expiresAt).toISOString(),
						switcher: await switcher(session),
					};
				} catch {
					return problem('portal_unreachable', 'The website list cannot be loaded right now.');
				}
			},
		}),
		defineRoute({
			method: 'GET',
			path: `${W}/overview`,
			auth: 'dashboard',
			handler: async (ctx) => {
				const id = website(ctx);
				const status = await statusOf(ctx);
				const { on } = await kit.reports.switches(id);
				const needed = (await kit.connections.list(id)).filter((c) => c.neededBy.some((key) => on.includes(key)));
				const visitorWidgets = manifest.widgets.some(
					(w) => w.kind === 'visitor' && [w.feature].flat().some((key) => on.includes(key)),
				);
				const seen = await store.get('widget', id);
				const business = await kit.business.get(id, status.domain);
				return {
					website: {
						websiteId: id,
						domain: status.domain,
						merchantId: status.merchantId,
						merchantName: status.merchantName,
					},
					status: { status: effectiveStatus(status, now()), graceEndsAt: status.graceEndsAt },
					featuresOn: on,
					todayMillicredits: status.todayMillicredits,
					checklist: {
						connections: needed,
						widget: visitorWidgets
							? {
									installed: seen !== null && now() - seen.lastSeenAt < WIDGET_SEEN_MS,
									lastSeenAt: seen ? new Date(seen.lastSeenAt).toISOString() : null,
								}
							: null,
						business: { found: business.found, fetchedAt: business.fetchedAt },
					},
					recentChanges: await kit.recent.list(id),
				};
			},
		}),
		defineRoute({
			method: 'GET',
			path: `${W}/features`,
			auth: 'dashboard',
			handler: async (ctx) => {
				const { on, featuresVersion } = await kit.reports.switches(website(ctx));
				const prices = await kit.connection.acceptedPrices();
				return {
					featuresVersion,
					features: currentFeatures(manifest, prices).map((f) => ({ ...f, on: on.includes(f.key) })),
				};
			},
		}),
		defineRoute({
			method: 'PUT',
			path: `${W}/features`,
			auth: 'dashboard',
			roles: ADMINS,
			handler: async (ctx) => {
				const body = objectBody(ctx.body);
				const result = await kit.reports.reportFeatures({
					websiteId: website(ctx),
					on: body.on,
					actor: whoOf(sessionOf(ctx)),
				});
				return result.ok ? { version: result.version, on: result.on } : result.problem;
			},
		}),
		defineRoute({
			method: 'GET',
			path: `${W}/settings`,
			auth: 'dashboard',
			handler: async (ctx) => {
				const { on } = await kit.reports.switches(website(ctx));
				const visible = manifest.features.filter((f) => !isMerchant(ctx) || on.includes(f.key));
				return {
					features: await Promise.all(
						visible.map(async (f) => ({
							key: f.key,
							name: f.name,
							on: on.includes(f.key),
							schema: f.settings,
							values: await kit.settings.settingsOf(website(ctx), f.key),
						})),
					),
				};
			},
		}),
		...['PUT', 'DELETE'].map((method) =>
			defineRoute({
				method: /** @type {'PUT' | 'DELETE'} */ (method),
				path: `${W}/settings/:key`,
				auth: 'dashboard',
				handler: async (ctx) => {
					const { feature, key } = splitKey(ctx.params.key ?? '');
					if (!(await editable(ctx, feature)))
						return problem('feature_off', 'Settings of features that are off cannot be changed.');
					const value = method === 'PUT' ? objectBody(ctx.body).value : undefined;
					if (method === 'PUT' && value === undefined) return problem('validation_failed', 'Send { value }.');
					return outcome(
						await kit.settings.setSetting({ websiteId: website(ctx), feature, key, value, who: whoOf(sessionOf(ctx)) }),
					);
				},
			}),
		),
		defineRoute({
			method: 'GET',
			path: `${W}/texts`,
			auth: 'dashboard',
			handler: async (ctx) => ({ texts: await kit.settings.textsOf(website(ctx)) }),
		}),
		...['PUT', 'DELETE'].map((method) =>
			defineRoute({
				method: /** @type {'PUT' | 'DELETE'} */ (method),
				path: `${W}/texts/:key`,
				auth: 'dashboard',
				handler: async (ctx) => {
					const value = method === 'PUT' ? objectBody(ctx.body).value : undefined;
					if (method === 'PUT' && value === undefined) return problem('validation_failed', 'Send { value }.');
					return outcome(
						await kit.settings.setText({ websiteId: website(ctx), key: ctx.params.key, value, who: whoOf(sessionOf(ctx)) }),
					);
				},
			}),
		),
		defineRoute({
			method: 'GET',
			path: `${W}/theme`,
			auth: 'dashboard',
			handler: async (ctx) => kit.settings.themeOf(website(ctx)),
		}),
		defineRoute({
			method: 'PUT',
			path: `${W}/theme`,
			auth: 'dashboard',
			handler: async (ctx) =>
				outcome(
					await kit.settings.setTheme({ websiteId: website(ctx), theme: objectBody(ctx.body), who: whoOf(sessionOf(ctx)) }),
					() => kit.settings.themeOf(website(ctx)),
				),
		}),
		defineRoute({
			method: 'GET',
			path: `${W}/connections`,
			auth: 'dashboard',
			handler: async (ctx) => ({ connections: await kit.connections.list(website(ctx)) }),
		}),
		defineRoute({
			method: 'PUT',
			path: `${W}/connections/:name`,
			auth: 'dashboard',
			handler: async (ctx) => {
				const result = await kit.connections.save({
					websiteId: website(ctx),
					name: ctx.params.name,
					value: objectBody(ctx.body).value,
					who: whoOf(sessionOf(ctx)),
				});
				return result.ok ? result.connection : result.problem;
			},
		}),
		defineRoute({
			method: 'DELETE',
			path: `${W}/connections/:name`,
			auth: 'dashboard',
			handler: async (ctx) =>
				outcome(await kit.connections.remove({ websiteId: website(ctx), name: ctx.params.name, who: whoOf(sessionOf(ctx)) })),
		}),
		defineRoute({
			method: 'POST',
			path: `${W}/connections/:name/test`,
			auth: 'dashboard',
			handler: async (ctx) => {
				const result = await kit.connections.test({ websiteId: website(ctx), name: ctx.params.name });
				return result.ok ? result.connection : result.problem;
			},
		}),
		defineRoute({
			method: 'POST',
			path: `${W}/business/refresh`,
			auth: 'dashboard',
			handler: async (ctx) => kit.business.refresh(website(ctx), (await statusOf(ctx)).domain),
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/dashboard/defaults',
			auth: 'dashboard',
			roles: OWNER,
			handler: async () => ({
				features: await Promise.all(
					manifest.features.map(async (f) => ({
						key: f.key,
						name: f.name,
						schema: f.settings,
						values: await kit.settings.settingsOf(null, f.key),
					})),
				),
				texts: await kit.settings.textsOf(null),
				theme: await kit.settings.themeOf(null),
				recentChanges: await kit.recent.list(null),
			}),
		}),
		defineRoute({
			method: 'PUT',
			path: '/v1/dashboard/defaults/:key',
			auth: 'dashboard',
			roles: OWNER,
			handler: async (ctx) => {
				const body = objectBody(ctx.body);
				if (!('value' in body)) return problem('validation_failed', 'Send { value } (null removes the default).');
				const value = body.value === null ? undefined : body.value;
				const who = whoOf(sessionOf(ctx));
				const key = ctx.params.key ?? '';
				if (key === 'theme') return outcome(await kit.settings.setTheme({ websiteId: null, theme: body.value, who }));
				if (key.startsWith('text.'))
					return outcome(await kit.settings.setText({ websiteId: null, key: key.slice(5), value, who }));
				return outcome(await kit.settings.setSetting({ websiteId: null, ...splitKey(key), value, who }));
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/dashboard/prices',
			auth: 'dashboard',
			roles: OWNER,
			handler: async () => {
				const prices = await kit.connection.acceptedPrices();
				return {
					version: prices?.version ?? 0,
					features: currentFeatures(manifest, prices),
					recentChanges: await kit.recent.list(null),
				};
			},
		}),
		defineRoute({
			method: 'PUT',
			path: '/v1/dashboard/prices',
			auth: 'dashboard',
			roles: OWNER,
			handler: async (ctx) => {
				const body = objectBody(ctx.body);
				if (!isObject(body.prices))
					return problem('validation_failed', 'Send { prices: { <feature>: <millicredits per hour> } }.');
				const result = await kit.reports.reportPrices({
					prices: /** @type {Record<string, number>} */ (body.prices),
					actor: whoOf(sessionOf(ctx)),
				});
				return result.ok ? { version: result.version } : result.problem;
			},
		}),
	];

	return Object.freeze({
		authorize,
		routes,
		/** @param {string} subject @returns {Promise<number>} sessions ended */
		endSessions: (subject) => store.deleteWhere('sessions', { subject }),
		/** @param {string} websiteId @returns {Promise<number>} merchant sessions naming the website, ended */
		endWebsiteSessions: (websiteId) => store.deleteWhere('sessions', { websiteIds: websiteId }),
	});
};
