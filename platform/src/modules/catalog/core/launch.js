/**
 * Launch issuance rules (pure). `@ss/protocol` `issueLaunch` enforces the token's kind/scope shape; these rules add
 * what only the catalog knows: which apps may be launched and which manifest capabilities a kind needs (PLAN §8, F.5).
 *
 * | kind       | app status       | manifest needs             | input needs                                                 |
 * | ---------- | ---------------- | -------------------------- | ----------------------------------------------------------- |
 * | `merchant` | active           | —                          | `scope.merchantId`                                          |
 * | `admin`    | active, inactive | `capabilities.adminLaunch` | staff `actor`, `scope.merchantId` or `scope.all: true` alone |
 *
 * Element packs have no backend and are never launched.
 * @module
 */

/** @typedef {import('@ss/contracts').Manifest} Manifest */
/** @typedef {{ id: string, email?: string, name?: string, roles?: string[] }} LaunchUser */
/** @typedef {{ all?: true, merchantId?: string, websiteId?: string, websiteIds?: string[], permissions?: string[] }} LaunchScope */

/**
 * @typedef {object} LaunchInput
 * @property {'merchant' | 'admin'} kind
 * @property {string} appId
 * @property {string} subject user id the product sees as `sub`
 * @property {LaunchUser} user
 * @property {LaunchScope} [scope]
 * @property {unknown[]} [subscriptions]
 * @property {string} [actor] staff id (admin launches)
 */

/** @param {unknown} v */
const text = (v) => typeof v === 'string' && v.length > 0 && v.length <= 128;

/**
 * Why this launch must not be issued, or `null`.
 * @param {{ input: LaunchInput, app: { kind: string, status: string }, manifest: Manifest }} params
 * @returns {string | null}
 */
export const launchRefusal = ({ input, app, manifest }) => {
	const { kind, subject, user, scope = {}, actor, subscriptions } = input;
	if (kind !== 'merchant' && kind !== 'admin') return `unknown launch kind ${String(kind)}`;
	if (app.kind !== 'service') return 'element packs have no dashboard to launch';
	if (kind === 'merchant' && app.status !== 'active') return 'an inactive app cannot be opened by merchants';
	if (!text(subject)) return 'subject is required';
	if (typeof user !== 'object' || user === null || !text(user.id)) return 'user.id is required';
	if (subscriptions !== undefined && (!Array.isArray(subscriptions) || subscriptions.length > 100))
		return 'subscriptions must be an array of at most 100 entries';
	if (kind === 'merchant') return text(scope.merchantId) ? null : 'merchant launches need scope.merchantId';
	if (manifest.capabilities?.adminLaunch !== true) return 'the product does not support admin launches';
	if (!text(actor)) return 'admin launches need the staff actor';
	if (scope.all !== undefined) {
		if (scope.all !== true) return 'scope.all must be true';
		const others = Object.keys(scope).filter((key) => key !== 'all' && key !== 'permissions');
		if (others.length > 0 || subscriptions !== undefined) return 'scope.all excludes merchant, website and subscriptions';
		return null;
	}
	return text(scope.merchantId) ? null : 'admin launches need scope.merchantId or scope.all';
};

/**
 * Product URL that exchanges a launch (`GET <base>/sso?launch=<token>`, PLAN F.8/F.9).
 * @param {string} baseUrl
 * @param {string} token
 */
export const launchUrl = (baseUrl, token) => `${baseUrl.replace(/\/+$/, '')}/sso?launch=${encodeURIComponent(token)}`;
