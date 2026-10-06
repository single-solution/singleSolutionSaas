/**
 * First-run setup (`/setup`): exists only until the first staff user exists. It records the Portal URL — the origin the
 * owner is visiting from, shown and editable — and creates the first superadmin, then redirects to the single-use
 * password-setup link (two-factor enrolment follows at the first sign-in). Afterwards `/setup` answers 404; only an
 * admin can change the Portal URL (Admin → Settings, re-confirmed and audited). Whoever reaches `/setup` first wins,
 * so the page says to do it right after deploying.
 *
 * Plain HTML, no script and no external resources.
 * @module
 */
import { checkPortalUrl } from './infra/config.js';
import { email as parseEmail } from './modules/identity/core/inputs.js';

/** @param {string} value */
const escape = (value) =>
	value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

const STYLE = `body{font:16px/1.5 system-ui,sans-serif;margin:0;background:#f6f6f4;color:#1c1c1a}
main{max-width:34rem;margin:3rem auto;padding:0 1rem}h1{font-size:1.4rem}label{display:block;margin:1rem 0 .25rem;font-weight:600}
input[type=text],input[type=email],input[type=url]{width:100%;box-sizing:border-box;padding:.6rem;border:1px solid #bbb;border-radius:6px;font:inherit}
button{margin-top:1.25rem;padding:.6rem 1.2rem;border:0;border-radius:6px;background:#1c1c1a;color:#fff;font:inherit;cursor:pointer}
.warn{background:#fff4d6;border:1px solid #e5c56b;padding:.75rem;border-radius:6px}.err{background:#fde8e8;border:1px solid #e09b9b;padding:.75rem;border-radius:6px}
small{color:#555}.check{display:flex;gap:.5rem;align-items:flex-start;margin-top:1rem;font-weight:400}
@media (prefers-color-scheme:dark){body{background:#161615;color:#eee}input{background:#222;color:#eee;border-color:#555}
button{background:#eee;color:#161615}.warn{background:#3a3218;border-color:#6b5a20}.err{background:#3a1d1d;border-color:#7a3a3a}small{color:#aaa}}`;

/**
 * @param {string} body
 * @param {number} [status]
 * @returns {Response}
 */
const page = (body, status = 200) =>
	new Response(
		`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
			`<meta name="robots" content="noindex"><title>Set up the Portal</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`,
		{
			status,
			headers: {
				'content-type': 'text/html; charset=utf-8',
				'cache-control': 'no-store',
				'content-security-policy':
					"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
				'x-frame-options': 'DENY',
				'referrer-policy': 'no-referrer',
			},
		},
	);

/**
 * @param {{ portalUrl: string, email?: string, name?: string, error?: string | null }} input
 * @param {number} [status]
 */
const form = ({ portalUrl, email = '', name = '', error = null }, status = 200) =>
	page(
		`<h1>Set up the Portal</h1>
<p class="warn"><strong>Do this right after deploying.</strong> Until the first admin exists, anyone who opens this page can
set up the Portal and become its administrator.</p>
${error ? `<p class="err" role="alert">${escape(error)}</p>` : ''}
<form method="post" action="/setup">
<label for="portalUrl">Portal URL</label>
<input type="url" id="portalUrl" name="portalUrl" required value="${escape(portalUrl)}">
<small>The address you are visiting now, as products, e-mails and browsers will use it. It becomes the issuer of
every token and the only origin the consoles accept; an admin can change it later.</small>
<label for="email">Your e-mail (first administrator)</label>
<input type="email" id="email" name="email" required autocomplete="email" value="${escape(email)}">
<label for="name">Your name (optional)</label>
<input type="text" id="name" name="name" autocomplete="name" value="${escape(name)}">
<label class="check"><input type="checkbox" name="confirm" value="yes" required> This is the Portal's address.</label>
<button type="submit">Set up</button>
</form>
<p><small>Next you choose a password and enrol two-factor sign-in.</small></p>`,
		status,
	);

const closed = () => page('<h1>Not found</h1><p>The Portal is set up. Sign in at <a href="/admin">/admin</a>.</p>', 404);

/**
 * The `/setup` handler.
 * @param {{ getPortal: () => Promise<import('./portal.js').Portal>, resetPortal: () => void }} deps
 * @returns {(request: Request) => Promise<Response>}
 */
export const createSetupHandler =
	({ getPortal, resetPortal }) =>
	async (request) => {
		const portal = await getPortal();
		const identity = /** @type {any} */ (portal.modules.service('identity'));
		const system = portal.shared.system;
		if (!system || (portal.config.setUp && (await identity.hasStaff()))) return closed();
		const suggested = portal.config.setUp ? portal.config.portalUrl : new URL(request.url).origin;
		if (request.method === 'GET' || request.method === 'HEAD') return form({ portalUrl: suggested });
		if (request.method !== 'POST') return page('<h1>Method not allowed</h1>', 405);

		const text = await request.text();
		if (text.length > 8192) return form({ portalUrl: suggested, error: 'The form is too large.' }, 413);
		const fields = new URLSearchParams(text);
		const portalUrl = (fields.get('portalUrl') ?? '').trim();
		const name = (fields.get('name') ?? '').trim().slice(0, 120);
		const emailText = (fields.get('email') ?? '').trim();
		const values = { portalUrl: portalUrl || suggested, email: emailText, name };
		const url = checkPortalUrl(portalUrl, { production: portal.config.isProduction });
		if (!url.ok) return form({ ...values, error: url.message }, 400);
		const email = parseEmail(emailText);
		if (!email.ok) return form({ ...values, error: 'Enter a valid e-mail address.' }, 400);
		if (fields.get('confirm') !== 'yes') return form({ ...values, error: 'Confirm the Portal URL.' }, 400);
		if (await identity.hasStaff()) return closed();

		await system.update({ portalUrl: url.url, setup: true });
		resetPortal();
		const ready = await getPortal();
		try {
			const result = await /** @type {any} */ (ready.modules.service('identity')).bootstrapSuperadmin({
				email: email.value,
				...(name ? { name } : {}),
			});
			ready.shared.logger.info('setup completed', { portalUrl: url.url });
			return new Response(null, { status: 303, headers: { location: result.link, 'cache-control': 'no-store' } });
		} catch {
			return closed();
		}
	};
