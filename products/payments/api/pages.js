/**
 * The hosted pages (PLAN 0.8.7), served by Payments with the website's widget texts (every word editable in Settings →
 * Texts), theme and custom CSS: the payment-link page (`/l/<websiteId>/<linkId>`), the pay page of one payment
 * (`/pay/<websiteId>/<paymentId>`: pick a gateway, go on to it, or the bank details with the proof upload) and the
 * result page. Card details are never asked here: every gateway takes them on its own page. Plain HTML; every value is
 * escaped; the only script is `/pay.js` from the same address (it posts a gateway's form on its own and uploads a
 * transfer proof straight to the merchant's storage).
 * @module
 */
import { formatText } from '@ss/app-kit';
import { themeCss } from '@ss/app-kit/widget';
import { formatMoney } from '../core/money.js';

/** Security headers of the hosted pages (forms may post to the gateways' own https pages). */
export const PAGE_HEADERS = Object.freeze({
	'content-type': 'text/html; charset=utf-8',
	'cache-control': 'no-store',
	'content-security-policy':
		"default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self' https:; img-src 'self' https: data:; form-action 'self' https:; frame-ancestors 'none'; base-uri 'none'",
	'x-frame-options': 'DENY',
	'referrer-policy': 'no-referrer',
});

/** `/pay.js`: posts a gateway form marked `data-autosubmit`, and uploads a bank-transfer proof (presigned PUT). */
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
      const done = await json(form.action + '/done', { key });
      if (!done.ok) throw new Error('done');
      status.textContent = form.dataset.done;
      form.querySelector('button').disabled = true;
    } catch {
      status.textContent = form.dataset.failed;
    }
  });
})();
`;

/** @param {unknown} value */
export const escape = (value) => String(value).replace(/[&<>"']/g, (ch) => `&#${/** @type {string} */ (ch).charCodeAt(0)};`);

const PAGE_CSS = `
:root { color-scheme: light dark; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; box-sizing: border-box;
  font-family: var(--ss-font-family, system-ui, sans-serif); background: Canvas; color: CanvasText; }
.box { max-width: 440px; width: 100%; padding: 24px; box-sizing: border-box; border-radius: var(--ss-radius, 8px);
  background: var(--ss-color-background, Canvas); color: var(--ss-color-text, CanvasText);
  border: 1px solid var(--ss-color-border, GrayText); }
h1 { font-size: 1.3em; margin: 0 0 8px; } .amount { font-size: 1.6em; font-weight: 600; margin: 8px 0 16px; }
label { display: block; font-size: 0.9em; margin: 12px 0 4px; }
input, select { width: 100%; box-sizing: border-box; font: inherit; padding: 8px; color: inherit; background: transparent;
  border: 1px solid var(--ss-color-border, GrayText); border-radius: var(--ss-radius, 8px); }
button { width: 100%; margin-top: 12px; font: inherit; padding: 10px 18px; border: 0; border-radius: var(--ss-radius, 8px);
  cursor: pointer; background: var(--ss-color-accent, #4f46e5); color: var(--ss-color-onAccent, #ffffff); }
button[disabled] { opacity: 0.6; } .error { color: #b91c1c; } .muted { opacity: 0.75; font-size: 0.9em; }
dl { display: grid; grid-template-columns: auto 1fr; gap: 6px 12px; margin: 12px 0; } dt { opacity: 0.75; } dd { margin: 0; overflow-wrap: anywhere; }
a { color: inherit; }
`;

/**
 * @typedef {object} PageLook
 * @property {Record<string, string>} texts the website's widget texts
 * @property {(import('@ss/app-kit/widget').WidgetTheme & { customCss?: string }) | undefined} [theme]
 */

/**
 * A whole page around `body`.
 * @param {PageLook & { title: string, body: string, script?: boolean }} input
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
<title>${escape(title)}</title>
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
	translator(texts)(`gateway.${gateway}`, gateway === 'generic' ? { name: genericName } : {});

/**
 * The payment-link page: amount (when the link has none), the payer's name and e-mail, the payment method.
 * @param {PageLook & { business: string, link: { title: string, description: string, amount: number | null, minAmount: number | null,
 *   currency: string }, gateways: Array<{ id: string, name: string }>, action: string, error?: string,
 *   values?: Record<string, string> }} input
 */
export const renderLinkPage = ({ texts, theme, business, link, gateways, action, error = '', values = {} }) => {
	const t = translator(texts);
	const amount =
		link.amount === null
			? `<label for="amount">${escape(t('link.amount', { currency: link.currency }))}</label>
<input id="amount" name="amount" inputmode="decimal" required value="${escape(values.amount ?? '')}">
<p class="muted">${escape(t('link.amountHelp', { min: formatMoney(link.minAmount ?? 1, link.currency) }))}</p>`
			: `<p class="amount">${escape(formatMoney(link.amount, link.currency))}</p>`;
	const methods =
		gateways.length === 0
			? `<p>${escape(t('page.noGateway'))}</p>`
			: `<label for="gateway">${escape(t('link.method'))}</label>
<select id="gateway" name="gateway">${gateways.map((g) => `<option value="${escape(g.id)}"${values.gateway === g.id ? ' selected' : ''}>${escape(g.name)}</option>`).join('')}</select>
<button type="submit">${escape(t('link.pay'))}</button>`;
	return page({
		texts,
		theme,
		title: link.title,
		body: `<p class="muted">${escape(business)}</p>
<h1>${escape(link.title)}</h1>
${link.description ? `<p>${escape(link.description)}</p>` : ''}
<form method="post" action="${escape(action)}">
${amount}
<label for="name">${escape(t('link.name'))}</label>
<input id="name" name="name" autocomplete="name" maxlength="120" value="${escape(values.name ?? '')}">
<label for="email">${escape(t('link.email'))}</label>
<input id="email" name="email" type="email" autocomplete="email" maxlength="254" value="${escape(values.email ?? '')}">
${error ? `<p class="error" role="alert">${escape(error)}</p>` : ''}
${methods}
</form>`,
	});
};

/**
 * The pay page before a gateway is picked: one button per gateway.
 * @param {PageLook & { business: string, amount: number, currency: string, description: string,
 *   gateways: Array<{ id: string, name: string }>, action: string }} input
 */
export const renderChoicePage = ({ texts, theme, business, amount, currency, description, gateways, action }) => {
	const t = translator(texts);
	return page({
		texts,
		theme,
		title: t('page.title'),
		body: `<p class="muted">${escape(business)}</p>
<h1>${escape(description || t('page.title'))}</h1>
<p class="amount">${escape(formatMoney(amount, currency))}</p>
${
	gateways.length === 0
		? `<p>${escape(t('page.noGateway'))}</p>`
		: `<p>${escape(t('page.choose'))}</p>
<form method="post" action="${escape(action)}">${gateways.map((g) => `<button type="submit" name="gateway" value="${escape(g.id)}">${escape(g.name)}</button>`).join('\n')}</form>`
}`,
	});
};

/**
 * The step that posts the gateway's form (sent on at once by `/pay.js`; the button works without it).
 * @param {PageLook & { business: string, amount: number, currency: string, gateway: string, action: string,
 *   fields: Array<[string, string]> }} input
 */
export const renderGatewayForm = ({ texts, theme, business, amount, currency, gateway, action, fields }) => {
	const t = translator(texts);
	return page({
		texts,
		theme,
		title: t('page.title'),
		script: true,
		body: `<p class="muted">${escape(business)}</p>
<p class="amount">${escape(formatMoney(amount, currency))}</p>
<p>${escape(t('page.continueHelp', { gateway }))}</p>
<form method="post" action="${escape(action)}" data-autosubmit>
${fields.map(([name, value]) => `<input type="hidden" name="${escape(name)}" value="${escape(value)}">`).join('\n')}
<button type="submit">${escape(t('page.continue', { gateway }))}</button>
</form>`,
	});
};

/**
 * Bank-transfer details, with the proof upload when the merchant allows it and storage is connected.
 * @param {PageLook & { business: string, amount: number, currency: string, reference: string,
 *   bank: { accountTitle: string, bankName: string, accountNumber: string, iban: string, instructions: string },
 *   proof: { action: string, maxBytes: number } | null, uploaded: boolean }} input
 */
export const renderBankPage = ({ texts, theme, business, amount, currency, reference, bank, proof, uploaded }) => {
	const t = translator(texts);
	/** @type {Array<[string, string]>} */
	const rows = [
		['bank.accountTitle', bank.accountTitle],
		['bank.bankName', bank.bankName],
		['bank.accountNumber', bank.accountNumber],
		['bank.iban', bank.iban],
		['bank.reference', reference],
	];
	const upload =
		proof && !uploaded
			? `<form method="post" action="${escape(proof.action)}" data-proof data-uploading="${escape(t('bank.uploading'))}" data-done="${escape(t('bank.uploaded'))}" data-failed="${escape(t('bank.uploadFailed'))}">
<label for="proof">${escape(t('bank.proof'))}</label>
<input id="proof" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" required>
<button type="submit">${escape(t('bank.upload'))}</button>
<p class="muted" role="status"></p>
</form>`
			: uploaded
				? `<p>${escape(t('bank.uploaded'))}</p>`
				: '';
	return page({
		texts,
		theme,
		title: t('bank.title'),
		script: proof !== null && !uploaded,
		body: `<p class="muted">${escape(business)}</p>
<h1>${escape(t('bank.title'))}</h1>
<p>${escape(t('bank.intro', { amount: formatMoney(amount, currency) }))}</p>
<dl>${rows
			.filter(([, value]) => value !== '')
			.map(([key, value]) => `<dt>${escape(t(key))}</dt><dd>${escape(value)}</dd>`)
			.join('')}</dl>
${bank.instructions ? `<p>${escape(bank.instructions)}</p>` : ''}
<p class="muted">${escape(t('bank.waiting'))}</p>
${upload}`,
	});
};

/**
 * The result page (or a page that says the payment cannot be shown).
 * @param {PageLook & { state: 'paid' | 'pending' | 'failed' | 'cancelled' | 'refunded' | 'unavailable' | 'notFound' | 'error' | 'noGateway',
 *   business?: string, amount?: number, currency?: string, backUrl?: string | null, retry?: string | null }} input
 */
export const renderResultPage = ({ texts, theme, state, business = '', amount, currency, backUrl = null, retry = null }) => {
	const t = translator(texts);
	return page({
		texts,
		theme,
		title: t('page.title'),
		body: `${business ? `<p class="muted">${escape(business)}</p>` : ''}
${amount !== undefined && currency ? `<p class="amount">${escape(formatMoney(amount, currency))}</p>` : ''}
<h1>${escape(t(`page.${state}`))}</h1>
${retry ? `<form method="post" action="${escape(retry)}"><button type="submit" name="retry" value="1">${escape(t('page.tryAgain'))}</button></form>` : ''}
${backUrl ? `<p><a href="${escape(backUrl)}">${escape(t('page.back', { business }))}</a></p>` : ''}`,
	});
};
