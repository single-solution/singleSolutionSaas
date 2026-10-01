/**
 * The `identity` module: staff users (mandatory TOTP), merchants and their teams (roles, website-scoped grants,
 * invites, ownership), merchant self-signup with e-mail verification, password reset, partners, developers,
 * websites (domain claims, test twins, cooldown, transfers) and website keys (issue, rotate, revoke, revocation
 * list). Implements the `sessionActor` and `websiteKeyRevoked` ports.
 *
 * `createIdentityModule(options)` accepts the `mailer` port, dedicated website-key signing keys and a public-suffix
 * predicate; `identityModule` is the default instance registered in `modules/index.js`.
 * @module
 */
import { defineModule } from '../../infra/modules.js';
import { identityRoutes } from './routes.js';
import { collections } from './schema.js';
import { createIdentityService } from './service.js';
import { REVOKE_JOB } from './website-keys.js';

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
		problems: IDENTITY_PROBLEMS,
		service: (ctx) => createIdentityService(ctx, options),
		routes: (ctx) => identityRoutes(ctx, ctx.service('identity')),
		jobs: (ctx) => ({
			[REVOKE_JOB]: async (payload) => ctx.service('identity').keys.onScheduledRevocation(payload),
		}),
		ports: (ctx) => ({
			sessionActor: (session) => ctx.service('identity').sessionActor(session),
			websiteKeyRevoked: (claims) => ctx.service('identity').isKeyRevoked(claims),
		}),
	});

export const identityModule = createIdentityModule();
