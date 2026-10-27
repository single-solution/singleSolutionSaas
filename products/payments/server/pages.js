/**
 * The hosted pages (PLAN 0.8.7), served by Payments with the website's widget texts (every word editable in Settings →
 * Texts), theme, custom CSS and Format (money as the website's Format in the Portal says, PLAN 0.8.10 K7): the payment-link page (`/l/<websiteId>/<linkId>`), the pay page of one payment
 * (`/pay/<websiteId>/<paymentId>`: pick a gateway or a manual payment method, go on to the gateway, or the manual
 * method's details, accounts and instructions with the proof upload) and the
 * result page. Card details are never asked here: every gateway takes them on its own page. Plain HTML; every value is
 * escaped; the only script is `/pay.js` from the same address (it posts a gateway's form on its own and uploads a
 * transfer proof straight to the merchant's storage).
 * @module
 */
import { formatText } from '@ss/app-kit';
import { themeCss } from '@ss/app-kit/widget';
import { escapeHtml } from '@ss/contracts/text';
import { isCustomGateway } from '../core/gateways.js';
import { PROOF_TYPES } from '../core/widgets.js';

/** Security headers of the hosted pages (forms may post to the gateways' own https pages). */
export const PAGE_HEADERS = Object.freeze({
	'content-type': 'text/html; charset=utf-8',
	'cache-control': 'no-store',
	'content-security-policy':
		"default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self' https:; img-src 'self' https: data:; form-action 'self' https:; frame-ancestors 'none'; base-uri 'none'",
	'x-frame-options': 'DENY',
	'referrer-policy': 'no-referrer',
});

/**
 * `/pay.js`: posts a gateway form marked `data-autosubmit`, and uploads a payment proof (presigned PUT) with the
 * payment's reference the payer typed (PLAN 0.8.10 P3).
 */
export const PAY_SCRIPT = `(() => {
  const auto = document.querySelector('form[data-autosubmit]');
  if (auto) auto.submit();
  const form = document.querySelector('form[data-proof]');
  if (!form) return;
  const status = form.querySelector('[role="status"]');
  const json = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const file = form.querySelector('input[type="file"]').files[0];
    if (!file) return;
    status.textContent = form.dataset.uploading;
    try {
      const signed = await json(form.action, { type: file.type, size: file.size });
      if (!signed.ok) throw new Error('presign');
      const { upload, key } = await signed.json();
      const put = await fetch(upload.url, { method: upload.method, headers: upload.headers, body: file });
      if (!put.ok) throw new Error('upload');
      const reference = form.querySelector('input[name="reference"]');
      const done = await json(form.action + '/done', { key, reference: reference ? reference.value.trim() : '' });
      if (!done.ok) throw new Error('done');
      status.textContent = form.dataset.done;
      form.querySelector('button').disabled = true;
    } catch {
      status.textContent = form.dataset.failed;
    }
  });
})();
`;

const PAGE_CSS = `
:root { color-scheme: light dark; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; box-sizing: border-box;
  font-family: var(--ss-font-family, system-ui, sans-serif); background: Canvas; color: CanvasText; }
.box { max-width: 440px; width: 100%; padding: 24px; box-sizing: border-box; border-radius: var(--ss-radius, 0.35rem);
  background: var(--ss-color-background, Canvas); color: var(--ss-color-text, CanvasText);
  border: 1px solid var(--ss-color-border, GrayText); }
h1 { font-size: 1.3em; margin: 0 0 8px; } .amount { font-size: 1.6em; font-weight: 600; margin: 8px 0 16px; }
label { display: block; font-size: 0.9em; margin: 12px 0 4px; }
input, select { width: 100%; box-sizing: border-box; font: inherit; padding: 8px; color: inherit; background: transparent;
  border: 1px solid var(--ss-color-border, GrayText); border-radius: var(--ss-radius, 0.35rem); }
button { width: 100%; margin-top: 12px; font: inherit; padding: 10px 18px; border: 0; border-radius: var(--ss-radius, 0.35rem);
  cursor: pointer; background: var(--ss-color-accent, #0f766e); color: var(--ss-color-onAccent, #ffffff); }
button[disabled] { opacity: 0.6; } .error { color: #b91c1c; } .muted { opacity: 0.75; font-size: 0.9em; }
dl { display: grid; grid-template-columns: auto 1fr; gap: 6px 12px; margin: 12px 0; } dt { opacity: 0.75; } dd { margin: 0; overflow-wrap: anywhere; }
a { color: inherit; }
`;

/**
 * @typedef {object} PageLook
 * @property {Record<string, string>} texts the website's widget texts
 * @property {(import('@ss/app-kit/widget').WidgetTheme & { customCss?: string }) | undefined} [theme] the website's
 *   theme (none on a page for a website that cannot be served)
 * @property {(amount: number, currency: string) => string} money the website's Format for money
 *   (`product.format(websiteId).money`)
 */

/**
 * A whole page around `body`.
 * @param {Omit<PageLook, 'money'> & { title: string, body: string, script?: boolean }} input
 */
const page = ({ theme, title, body, script = false }) => {
	const mode = theme?.mode === 'dark' || theme?.mode === 'light' ? `:root { color-scheme: ${theme.mode}; }` : '';
	const variables = theme ? themeCss(theme).replace(':host', ':root') : '';
	// custom CSS stays inside its style element
	const custom = (theme?.customCss ?? '').replace(/</g, '\\3c ');
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>${variables}${mode}${PAGE_CSS}</style>
<style>${custom}</style>
</head>
<body>
<main class="box">
${body}
</main>
${script ? '<script src="/pay.js"></script>' : ''}
</body>
</html>
`;
};

/**
 * @param {Record<string, string>} texts
 * @returns {(key: string, values?: Record<string, string | number>) => string}
 */
const translator = (texts) => (key, values) => formatText(texts[key] ?? key, values ?? {});

/**
 * The name payers see for a gateway.
 * @param {Record<string, string>} texts @param {string} gateway @param {string} [genericName]
 */
export const gatewayName = (texts, gateway, genericName = '') =>
	isCustomGateway(gateway)
		? translator(texts)('gateway.generic', { name: genericName })
		: translator(texts)(`gateway.${gateway}`, {});

/**
 * The payment-link page: amount (when the link has none), the payer's name and email, the phone and the questions the
 * link asks (P3), the payment method.
 * @param {PageLook & { business: string, link: { title: string, description: string, amount: number | null, minAmount: number | null,
 *   currency: string, phone: 'off' | 'optional' | 'required', fields: Array<{ label: string, required: boolean }> },
 *   gateways: Array<{ id: string, name: string }>, action: string, error?: string, values?: Record<string, string> }} input
 */
export const renderLinkPage = ({ texts, theme, money, business, link, gateways, action, error = '', values = {} }) => {
	const t = translator(texts);
	const amount =
		link.amount === null
			? `<label for="amount">${escapeHtml(t('link.amount', { currency: link.currency }))}</label>
<input id="amount" name="amount" inputmode="decimal" required value="${escapeHtml(values.amount ?? '')}">
<p class="muted">${escapeHtml(t('link.amountHelp', { min: money(link.minAmount ?? 1, link.currency) }))}</p>`
			: `<p class="amount">${escapeHtml(money(link.amount, link.currency))}</p>`;
	// what the link asks beyond the amount (P3): the phone, and the merchant's own questions
	const phone =
		link.phone === 'off'
			? ''
			: `<label for="phone">${escapeHtml(t(link.phone === 'required' ? 'link.phone' : 'link.phoneOptional'))}</label>
<input id="phone" name="phone" type="tel" autocomplete="tel" maxlength="20"${link.phone === 'required' ? ' required' : ''} value="${escapeHtml(values.phone ?? '')}">`;
	const asked = [
		phone,
		...link.fields.map(
			(field, index) => `<label for="field_${index}">${escapeHtml(field.label)}</label>
<input id="field_${index}" name="field_${index}" maxlength="200"${field.required ? ' required' : ''} value="${escapeHtml(values[`field_${index}`] ?? '')}">`,
		),
	]
		.filter(Boolean)
		.join('\n');
	const methods =
		gateways.length === 0
			? `<p>${escapeHtml(t('page.noGateway'))}</p>`
			: `<label for="gateway">${escapeHtml(t('link.method'))}</label>
<select id="gateway" name="gateway">${gateways.map((g) => `<option value="${escapeHtml(g.id)}"${values.gateway === g.id ? ' selected' : ''}>${escapeHtml(g.name)}</option>`).join('')}</select>
<button type="submit">${escapeHtml(t('link.pay'))}</button>`;
	return page({
		texts,
		theme,
		title: link.title,
		body: `<p class="muted">${escapeHtml(business)}</p>
<h1>${escapeHtml(link.title)}</h1>
${link.description ? `<p>${escapeHtml(link.description)}</p>` : ''}
<form method="post" action="${escapeHtml(action)}">
${amount}
<label for="name">${escapeHtml(t('link.name'))}</label>
<input id="name" name="name" autocomplete="name" maxlength="120" value="${escapeHtml(values.name ?? '')}">
<label for="email">${escapeHtml(t('link.email'))}</label>
<input id="email" name="email" type="email" autocomplete="email" maxlength="254" value="${escapeHtml(values.email ?? '')}">
${asked}
${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}
${methods}
</form>`,
	});
};

/**
 * The pay page before a way to pay is picked: one button per gateway and manual payment method (with the method's
 * details under it).
 * @param {PageLook & { business: string, amount: number, currency: string, description: string,
 *   gateways: Array<{ id: string, name: string, details?: string }>, action: string }} input
 */
export const renderChoicePage = ({ texts, theme, money, business, amount, currency, description, gateways, action }) => {
	const t = translator(texts);
	return page({
		texts,
		theme,
		title: t('page.title'),
		body: `<p class="muted">${escapeHtml(business)}</p>
<h1>${escapeHtml(description || t('page.title'))}</h1>
<p class="amount">${escapeHtml(money(amount, currency))}</p>
${
	gateways.length === 0
		? `<p>${escapeHtml(t('page.noGateway'))}</p>`
		: `<p>${escapeHtml(t('page.choose'))}</p>
<form method="post" action="${escapeHtml(action)}">${gateways.map((g) => `<button type="submit" name="gateway" value="${escapeHtml(g.id)}">${escapeHtml(g.name)}</button>${g.details ? `<p class="muted">${escapeHtml(g.details)}</p>` : ''}`).join('\n')}</form>`
}`,
	});
};

/**
 * The step that posts the gateway's form (sent on at once by `/pay.js`; the button works without it).
 * @param {PageLook & { business: string, amount: number, currency: string, gateway: string, action: string,
 *   fields: Array<[string, string]> }} input
 */
export const renderGatewayForm = ({ texts, theme, money, business, amount, currency, gateway, action, fields }) => {
	const t = translator(texts);
	return page({
		texts,
		theme,
		title: t('page.title'),
		script: true,
		body: `<p class="muted">${escapeHtml(business)}</p>
<p class="amount">${escapeHtml(money(amount, currency))}</p>
<p>${escapeHtml(t('page.continueHelp', { gateway }))}</p>
<form method="post" action="${escapeHtml(action)}" data-autosubmit>
${fields.map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`).join('\n')}
<button type="submit">${escapeHtml(t('page.continue', { gateway }))}</button>
</form>`,
	});
};

/** The introduction of each kind of manual method (`manual.intro.<kind>`). */
const INTRO = Object.freeze({
	pay_first: 'manual.intro.pay_first',
	on_delivery: 'manual.intro.on_delivery',
	at_pickup: 'manual.intro.at_pickup',
});

/**
 * A manual payment method's page (fixed-choices P1, P2): its name, what to do for its kind, the accounts of the
 * payment's currency (each label/value row the merchant filled in), the payment's reference and the instructions, with
 * the proof upload when the method takes proofs and storage is connected.
 * @param {PageLook & { business: string, amount: number, currency: string, reference: string,
 *   method: { name: string, kind: import('../core/methods.js').MethodKind, details: string, instructions: string,
 *   accounts: import('../core/methods.js').Account[] }, proof: { action: string } | null, uploaded: boolean }} input
 */
export const renderManualPage = ({ texts, theme, money, business, amount, currency, reference, method, proof, uploaded }) => {
	const t = translator(texts);
	const upload =
		proof && !uploaded
			? `<form method="post" action="${escapeHtml(proof.action)}" data-proof data-uploading="${escapeHtml(t('manual.uploading'))}" data-done="${escapeHtml(t('manual.uploaded'))}" data-failed="${escapeHtml(t('manual.uploadFailed'))}">
<label for="proof">${escapeHtml(t('manual.proof'))}</label>
<input id="proof" type="file" accept="${Object.keys(PROOF_TYPES).join(',')}" required>
<label for="proof-reference">${escapeHtml(t('manual.proofReference'))}</label>
<input id="proof-reference" name="reference" maxlength="120" autocomplete="off">
<button type="submit">${escapeHtml(t('manual.upload'))}</button>
<p class="muted" role="status"></p>
</form>`
			: uploaded
				? `<p>${escapeHtml(t('manual.uploaded'))}</p>`
				: '';
	const accounts = method.accounts
		.map(
			(account) =>
				`${account.label ? `<h2>${escapeHtml(account.label)}</h2>` : ''}<dl>${account.rows
					.map((row) => `<dt>${escapeHtml(row.label)}</dt><dd>${escapeHtml(row.value)}</dd>`)
					.join('')}</dl>`,
		)
		.join('\n');
	return page({
		texts,
		theme,
		title: method.name,
		script: proof !== null && !uploaded,
		body: `<p class="muted">${escapeHtml(business)}</p>
<h1>${escapeHtml(method.name)}</h1>
<p>${escapeHtml(t(INTRO[method.kind], { amount: money(amount, currency) }))}</p>
${method.details ? `<p>${escapeHtml(method.details)}</p>` : ''}
${accounts}
<dl><dt>${escapeHtml(t('manual.reference'))}</dt><dd>${escapeHtml(reference)}</dd></dl>
${method.instructions ? `<p>${escapeHtml(method.instructions)}</p>` : ''}
<p class="muted">${escapeHtml(t('manual.waiting'))}</p>
${upload}`,
	});
};

/**
 * The result page (or a page that says the payment cannot be shown).
 * @param {Omit<PageLook, 'money'> & Partial<Pick<PageLook, 'money'>> & { state: 'paid' | 'failed' | 'canceled' |
 *   'voided' | 'refundDue' | 'refunded' | 'unavailable' | 'notFound' | 'error', business?: string, amount?: number,
 *   currency?: string, backUrl?: string | null, retry?: string | null }} input `money` with `amount` (a page for a
 *   website that cannot be served has neither)
 */
export const renderResultPage = ({
	texts,
	theme,
	money,
	state,
	business = '',
	amount,
	currency,
	backUrl = null,
	retry = null,
}) => {
	const t = translator(texts);
	return page({
		texts,
		theme,
		title: t('page.title'),
		body: `${business ? `<p class="muted">${escapeHtml(business)}</p>` : ''}
${amount !== undefined && currency && money ? `<p class="amount">${escapeHtml(money(amount, currency))}</p>` : ''}
<h1>${escapeHtml(t(`page.${state}`))}</h1>
${retry ? `<form method="post" action="${escapeHtml(retry)}"><button type="submit" name="retry" value="1">${escapeHtml(t('page.tryAgain'))}</button></form>` : ''}
${backUrl ? `<p><a href="${escapeHtml(backUrl)}">${escapeHtml(t('page.back', { business }))}</a></p>` : ''}`,
	});
};
