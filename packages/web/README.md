# @ss/web

Small browser helpers a product may bundle into its own `widget.js` (PLAN.md 0.4.10). Nothing here is loaded on a
website by itself: each product builds and serves its own widget script, and decides which of these helpers it uses.

| Import             | What it is                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------------- |
| `@ss/web/widget`   | A widget's DOM-free core: `defineWidget`, `mountHeadless`, a store, `Result`, problems, API client |
| `@ss/web/renderer` | Safe DOM helpers for a ready-made widget UI: `h()`, design tokens, slots, focus, accessibility     |
| `@ss/web`          | Both of the above                                                                                  |

JavaScript ESM, no classes, no runtime dependencies. Every URL is configuration, and every browser global is read through
`globalThis` or injected (`fetch`, `document`, `window`), so the helpers also run during server rendering and in tests.

## Widget core (`@ss/web/widget`)

A widget's core holds its state, actions, texts and validation, with no DOM access. A ready-made UI and a merchant's
own (headless) UI can both drive the same core.

```js
import { createApiClient, defineWidget, err, mountHeadless, problem } from '@ss/web/widget';

export const applyBox = defineWidget({
	key: 'apply_box',
	strings: { label: 'Coupon code', applied: 'You saved {{amount}}' }, // English defaults
	initialState: ({ config }) => ({ status: 'idle', code: '', maxLength: config.maxLength }),
	validate: (code, { strings }) => (String(code ?? '').trim() ? [] : [{ path: '', code: 'required', message: strings.label }]),
	create: ({ store, client, emit, validate }) => ({
		actions: {
			setCode: (code) => store.setState({ code }),
			apply: async () => {
				const problems = validate(store.getState().code);
				if (problems.length) return err(problem('validation_failed', { errors: problems }));
				const result = await client.post('/v1/coupons:apply', { code: store.getState().code });
				if (result.ok) emit('applied', { code: store.getState().code }); // host receives 'apply_box.applied'
				return result;
			},
		},
	}),
});

const box = mountHeadless(applyBox, {
	config: { maxLength: 20 },
	strings: websiteTexts, // the website's text overrides
	client: createApiClient({ baseUrl: productUrl, token: browserToken }),
});
box.subscribe((state) => render(state)); // frozen snapshots; the same object until something changes
const result = await box.actions.apply(); // { ok: true, value } | { ok: false, error: Problem }
box.destroy();
```

- Instance: `{ key, state(), actions, subscribe, validate, strings, destroy, isDestroyed }`. Actions are async, never
  throw (a throw becomes `internal_error`; after `destroy` → `destroyed`) and always return a `Result`. `validate` is
  synchronous and pure. Config is deep-frozen; `strings` are the defaults merged with the overrides
  (`resolveStrings`); `formatString(template, params)` fills `{{placeholders}}` as text.
- `createStore(initial)` → `{ getState, setState(patch | fn), subscribe }` with shallow compare and frozen snapshots.
- `createApiClient({ baseUrl, token, fetch?, identity?, timeoutMs?, headers? })` → `{ get, post, put, patch, delete,
request }`. Sends JSON with `Authorization: Bearer <token>` (the browser token for visitor widgets, a ticket for admin
  widgets), `SS-Identity` when `identity.token()` returns a signed-in visitor token, and an `Idempotency-Key` on every
  POST (generated unless given). Paths must stay on the base origin. Errors come back as `Problem`s parsed from RFC 9457
  bodies (`parseProblem`): `code` is the body's `code`, else the last segment of `type`, else derived from the status.
  Browser-side codes `network_error`, `timeout`, `aborted`, `invalid_response` and `invalid_request` have `status: 0`.
- `ok`, `err`, `isResult`, `problem(code, extra)` and `CLIENT_PROBLEMS` build and recognise results.

## Renderer helpers (`@ss/web/renderer`)

- `h(tag, props, ...children)` — allowlisted HTML tags (no `script`, `style`, `iframe`, `object`, `embed`, `form`,
  `template`, `link`, `meta`, `base`) plus icon SVG; strings and numbers become **text nodes**; only allowlisted
  attributes plus `aria-*`/`data-*`; `on*` only as functions (`onClick`); `href` limited to http(s)/mailto/tel/relative,
  `src` to http(s)/relative; `target=_blank` forces `rel="noopener noreferrer"`; `style` only as an object, and CSS values
  refuse `url()`, `expression()`, `;{}<>\`, `@import`. Never `innerHTML`. `createH(document)` binds another document.
- `tokens.toVars(theme)` / `tokens.apply(el, theme)` — nested design tokens → `--ss-<path>` custom properties.
- `slot(name, slots, fallback)` — merchant content: a Node (cloned), text, `{ template: '#id' }` (a `<template>` on the
  merchant's page) or a function; falls back to the widget's default.
- `reserveSpace(el, { minHeight, minWidth, aspectRatio })` → `release()`; `prefersReducedMotion()`.
- `focusables(root)`, `focusFirst(root)`, `saveFocus()`, `trapFocus(root, { onEscape })` → `release()` (restores focus).
- `button({ label, icon?, onClick })` always has an accessible name; `liveRegion(parent)` → `{ announce(text), destroy }`;
  `VISUALLY_HIDDEN`, `uniqueId()`, `safeUrl`, `safeCssValue`, `HTML_TAGS`, `SVG_TAGS`, `ATTRIBUTES`.

## Checks

`pnpm check` runs format, lint, typecheck and the tests (coverage 90 % lines, 90 % functions, 85 % branches).
