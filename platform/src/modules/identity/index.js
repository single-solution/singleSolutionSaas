/**
 * The `identity` module: staff users (mandatory TOTP), merchants and their teams (roles, website-scoped grants,
 * invites, ownership), merchant self-signup with e-mail verification, password reset, websites (domain claims, test twins, cooldown, transfers) and website keys (issue, rotate, revoke, revocation
 * list). Implements the `sessionActor` and `websiteKeyRevoked` ports.
 *
 * `createIdentityModule(options)` accepts the `mailer` port, dedicated website-key signing keys and a public-suffix
 * predicate; `identityModule` is the default instance registered in `modules/index.js`.
 * @module
 */
import { defineModule } from '../../infra/modules.js';
import { identityRoutes } from './routes.js';
import { nameKey } from './core/search.js';
import { C, collections } from './schema.js';
import { createIdentityService } from './service.js';

export const IDENTITY_PROBLEMS = Object.freeze({
	domain_taken: Object.freeze({ status: 409, title: 'Domain already registered' }),
	merchant_suspended: Object.freeze({ status: 409, title: 'Merchant suspended' }),
	owner_protected: Object.freeze({ status: 409, title: 'The merchant owner cannot be changed this way' }),
	token_invalid: Object.freeze({ status: 400, title: 'Invalid or expired token' }),
});

/**
 * @param {import('./service.js').IdentityOptions} [options]
 */
export const createIdentityModule = (options = {}) =>
	defineModule({
		name: 'identity',
		collections,
		migrations: [
			{
				id: '202610020000-identity-merchant-name-key',
				description: 'Backfill `nameKey` (normalised name for merchant search) on merchants.',
				plan: async () => [`set ${C.merchants}.nameKey = normalised name where missing`],
				up: async ({ db }) => {
					const merchants = db.collection(C.merchants);
					for await (const m of merchants.find({ nameKey: { $exists: false } }, { projection: { name: 1 } }))
						await merchants.updateOne({ _id: m._id }, { $set: { nameKey: nameKey(m.name) } });
				},
			},
		],
		problems: IDENTITY_PROBLEMS,
		service: (ctx) => createIdentityService(ctx, options),
		routes: (ctx) => identityRoutes(ctx, ctx.service('identity')),
		ports: (ctx) => ({
			sessionActor: (session) => ctx.service('identity').sessionActor(session),
			websiteKeyRevoked: (claims, rawKey) => ctx.service('identity').isKeyRevoked(claims, rawKey),
		}),
	});

export const identityModule = createIdentityModule();
