/**
 * The product's `/setup` page: plain HTML (no script, no external resources) that posts a connection code and the
 * address this product is reachable at. It exists only while the product is unconnected.
 * @module
 */

/** @param {string} value */
const escape = (value) =>
	value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

const STYLE = `body{font:16px/1.5 system-ui,sans-serif;margin:0;background:#f6f6f4;color:#1c1c1a}
main{max-width:34rem;margin:3rem auto;padding:0 1rem}h1{font-size:1.4rem}label{display:block;margin:1rem 0 .25rem;font-weight:600}
input{width:100%;box-sizing:border-box;padding:.6rem;border:1px solid #bbb;border-radius:6px;font:inherit}
button{margin-top:1.25rem;padding:.6rem 1.2rem;border:0;border-radius:6px;background:#1c1c1a;color:#fff;font:inherit;cursor:pointer}
.warn{background:#fff4d6;border:1px solid #e5c56b;padding:.75rem;border-radius:6px}.err{background:#fde8e8;border:1px solid #e09b9b;padding:.75rem;border-radius:6px}
.ok{background:#e7f6ea;border:1px solid #8cc79a;padding:.75rem;border-radius:6px}small{color:#555}
@media (prefers-color-scheme:dark){body{background:#161615;color:#eee}input{background:#222;color:#eee;border-color:#555}
button{background:#eee;color:#161615}.warn{background:#3a3218;border-color:#6b5a20}.err{background:#3a1d1d;border-color:#7a3a3a}
.ok{background:#1b3321;border-color:#3f7a4c}small{color:#aaa}}`;

/**
 * @param {string} title
 * @param {string} body
 * @param {number} [status]
 * @returns {Response}
 */
const page = (title, body, status = 200) =>
	new Response(
		`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
			`<meta name="robots" content="noindex"><title>${escape(title)}</title><style>${STYLE}</style></head>` +
			`<body><main>${body}</main></body></html>`,
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
 * The setup form.
 * @param {{ productName: string, baseUrl: string, error?: string | null }} input
 * @param {number} [status]
 */
export const setupForm = ({ productName, baseUrl, error = null }, status = 200) =>
	page(
		`Set up ${productName}`,
		`<h1>Set up ${escape(productName)}</h1>
<p class="warn"><strong>Do this right after deploying.</strong> Until this product is connected, anyone who opens this page
with a valid connection code can connect it. The code comes from your Portal: Admin → Apps → Add product.</p>
${error ? `<p class="err" role="alert">${escape(error)}</p>` : ''}
<form method="post" action="setup">
<label for="code">Connection code</label>
<input id="code" name="code" required autocomplete="off" spellcheck="false" placeholder="ssc_…">
<label for="baseUrl">This product's address</label>
<input id="baseUrl" name="baseUrl" required value="${escape(baseUrl)}" inputmode="url">
<small>The public https origin this product is served from. The Portal will only ever call this address.</small>
<br><button type="submit">Connect</button>
</form>`,
		status,
	);

/**
 * The success page.
 * @param {{ productName: string, appId: string, portalUrl: string }} input
 */
export const setupDone = ({ productName, appId, portalUrl }) =>
	page(
		`${productName} connected`,
		`<h1>${escape(productName)} is connected</h1>
<p class="ok">Connected to <strong>${escape(portalUrl)}</strong> as <code>${escape(appId)}</code>. This page is now closed.</p>
<p>Review and activate the product in the Portal (Admin → Apps).</p>`,
	);

/** The page once connected: setup is closed. */
export const setupClosed = () => page('Not found', '<h1>Not found</h1><p>This product is already connected.</p>', 404);
