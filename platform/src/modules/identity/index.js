/**
 * The `identity` module (PLAN 0.2, 0.4.4): admins (Owner, Support, Finance), merchants (one record = business details
 * + one login), the one sign-in page with optional two-step and recovery codes, setup links, password resets and
 * login changes, websites (exact, unique domains) and the browser and server tokens of each product on a website with
 * their revocation list. Implements the `sessionActor` port.
 *
 * `createIdentityModule(options)` accepts the `mailer` port and a public-suffix predicate; `identityModule` is the
 * default instance registered in `modules/index.js`.
 * @module
 */
import { defineModule } from '../../infra/modules.js';
import { identityRoutes } from './routes.js';
import { collections } from './schema.js';
import { createIdentityService } from './service.js';

export const IDENTITY_PROBLEMS = Object.freeze({
	domain_taken: Object.freeze({ status: 409, title: 'Domain already belongs to a website' }),
	email_taken: Object.freeze({ status: 409, title: 'E-mail already used by another login' }),
	last_owner: Object.freeze({ status: 409, title: 'There must always be at least one Owner' }),
	merchant_suspended: Object.freeze({ status: 403, title: 'Merchant suspended' }),
	products_on_website: Object.freeze({ status: 409, title: 'Remove its products first' }),
	token_invalid: Object.freeze({ status: 400, title: 'Invalid or expired link' }),
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
		ports: (ctx) => ({
			sessionActor: (session) => ctx.service('identity').sessionActor(session),
		}),
	});

export const identityModule = createIdentityModule();
