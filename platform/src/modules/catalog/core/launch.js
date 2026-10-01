/**
 * Launch issuance rules (pure). `@ss/protocol` `issueLaunch` enforces the token's kind/scope shape; these rules add
 * what only the catalog knows: which apps may be launched, in which lifecycle states, and which manifest capabilities a
 * kind needs (PLAN §8, F.5).
 *
 * | kind          | app status                  | manifest needs                         | input needs                          |
 * | ------------- | --------------------------- | -------------------------------------- | ------------------------------------ |
 * | `merchant`    | active, deprecated          | —                                      | `scope.merchantId`                   |
 * | `admin`       | pending, active, deprecated | `capabilities.adminLaunch`             | staff `actor`, `scope.merchantId`    |
 * | `impersonate` | active, deprecated          | —                                      | staff `actor` ≠ subject, merchantId  |
 * | `demo`        | pending, active, deprecated | `capabilities.sandbox` or `endpoints.demo` | no `scope.merchantId`            |
 * | `partner`     | active, deprecated          | —                                      | `scope.partnerId`                    |
 * | `developer`   | pending, active, deprecated | —                                      | `scope.developerId`                  |
 *
 * Element packs have no backend and are never launched. Retired apps accept no launch.
 * @module
 */
import { LAUNCH_KINDS, MAX_IMPERSONATION_SECONDS } from '@ss/protocol';
import { launchKindsFor } from './lifecycle.js';

/** @typedef {import('@ss/contracts').Manifest} Manifest */
/** @typedef {import('@ss/protocol').LaunchKind} LaunchKind */
/** @typedef {{ id: string, email?: string, name?: string, roles?: string[] }} LaunchUser */
/**
 * @typedef {{ merchantId?: string, websiteId?: string, websiteIds?: string[], partnerId?: string, developerId?: string,
 *   permissions?: string[] }} LaunchScope
 */

/**
 * @typedef {object} LaunchInput
 * @property {LaunchKind} kind
 * @property {string} appId
 * @property {string} subject user id the product sees as `sub`
 * @property {LaunchUser} user
 * @property {LaunchScope} [scope]
 * @property {unknown[]} [subscriptions]
 * @property {string} [actor] staff id (admin, impersonate)
 * @property {number} [impersonationSeconds]
 * @property {'production' | 'staging'} [environment]
 */

/** @param {unknown} v */
const text = (v) => typeof v === 'string' && v.length > 0 && v.length <= 128;

/**
 * Why this launch must not be issued, or `null`.
 * @param {{ input: LaunchInput, app: { kind: string, status: string }, manifest: Manifest }} params
 * @returns {string | null}
 */
export const launchRefusal = ({ input, app, manifest }) => {
	const { kind, subject, user, scope = {}, actor, impersonationSeconds, subscriptions } = input;
	if (!(/** @type {readonly string[]} */ (LAUNCH_KINDS).includes(kind))) return `unknown launch kind ${String(kind)}`;
	if (app.kind !== 'service') return 'element packs have no dashboard to launch';
	if (!launchKindsFor(app.status).includes(kind)) return `an app that is ${app.status} does not accept ${kind} launches`;
	if (!text(subject)) return 'subject is required';
	if (typeof user !== 'object' || user === null || !text(user.id)) return 'user.id is required';
	if (subscriptions !== undefined && (!Array.isArray(subscriptions) || subscriptions.length > 100))
		return 'subscriptions must be an array of at most 100 entries';
	const merchantId = scope.merchantId;
	switch (kind) {
		case 'merchant':
			return text(merchantId) ? null : 'merchant launches need scope.merchantId';
		case 'admin':
			if (manifest.capabilities?.adminLaunch !== true) return 'the product does not support admin launches';
			if (!text(actor)) return 'admin launches need the staff actor';
			return text(merchantId) ? null : 'admin launches need scope.merchantId';
		case 'impersonate':
			if (!text(actor)) return 'impersonation needs the staff actor';
			if (actor === subject) return 'the staff actor cannot impersonate themselves';
			if (!text(merchantId)) return 'impersonation needs scope.merchantId';
			if (
				impersonationSeconds !== undefined &&
				(!Number.isInteger(impersonationSeconds) ||
					impersonationSeconds < 60 ||
					impersonationSeconds > MAX_IMPERSONATION_SECONDS)
			)
				return `impersonationSeconds must be 60..${MAX_IMPERSONATION_SECONDS}`;
			return null;
		case 'demo':
			if (manifest.capabilities?.sandbox !== true && !manifest.endpoints?.demo) return 'the product has no sandbox';
			return merchantId === undefined ? null : 'demo launches must not carry scope.merchantId';
		case 'partner':
			return text(scope.partnerId) ? null : 'partner launches need scope.partnerId';
		default:
			return text(scope.developerId) ? null : 'developer launches need scope.developerId';
	}
};

/**
 * Product URL that exchanges a launch (`GET <base>/sso?launch=<token>`, PLAN F.8/F.9).
 * @param {string} baseUrl
 * @param {string} token
 */
export const launchUrl = (baseUrl, token) => `${baseUrl.replace(/\/+$/, '')}/sso?launch=${encodeURIComponent(token)}`;
