# @ss/web

The browser SDK used by client websites and element packs (PLAN §4 delivery plane, §5 data plane, Part D §0a,
Part E §1, §4, §8, §9). Four independent, tree-shakable modules plus an optional audience evaluator and a React adapter:

| Import             | What it is                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------------- |
| `@ss/web/client`   | Website events client: envelopes, batching, retries, offline queue, beacon, consent, BYO identity    |
| `@ss/web/element`  | Headless element runtime (Mode B): `defineElement`, `mountHeadless`, store, Result, problems, API    |
| `@ss/web/renderer` | Default-renderer helpers (Mode A): safe `h()`, tokens, slots, CLS reservation, focus, a11y           |
| `@ss/web/loader`   | Loader runtime a compiled per-website bundle calls: `boot()`, placement, triggers, caps, `window.SS` |
| `@ss/web/audience` | Audience evaluators on `@ss/rules` (the only module that imports it)                                 |
| `@ss/web/react`    | `createUseElement(React)` → `useElement(definition, options)`                                        |
| `@ss/web`          | Everything above except `audience`                                                                   |

JavaScript ESM, no classes, no runtime dependencies besides `@ss/rules` (audience only). Nothing is hardcoded: every
URL (events endpoint, element API base) is configuration. Every browser global is read through `globalThis` or
injected (`window`, `navigator`, `fetch`, `storage`, `now`, timers), so all of it runs under SSR and in tests.

## Quickstart 1 — send events

```js
import { createClient } from '@ss/web/client';

const ss = createClient({
	key: 'pk_live_…', // public website key
	endpoint: config.eventsUrl, // events ingest URL from the website's config — never hardcoded
	websiteId: 'web_…',
	defaultConsent: {}, // opt-in: nothing but `necessary` until the visitor decides
});

ss.consent.set({ analytics: true }); // from your consent banner
ss.track('page.viewed', { url: location.href, path: location.pathname }); // → type 'page.viewed@1'
ss.track('order.placed', order, { idempotencyKey: `order:${order.orderId}:placed` });
ss.identify({ token: siteLoginJwt }); // bring-your-own identity (§5.3); `null` signs out
```

- **Envelope** (`@ss/contracts` event envelope v1): `id` (`evt_` + 26 base32), `type@v` (`@1` appended when omitted),
  `websiteId`, `env` (from the key prefix), `occurredAt` (ISO UTC), `idempotencyKey` (defaults to `id`; stable across
  retries), `actor` (`customer` when a federated token is present, else `anonymous` + anonymous id), `data`, `context`
  (`source`, `locale`, `sessionId`, `anonymousId`, `pageUrl`, `referrer`, `userAgent`, optional `element`, `product`).
  `track` never throws; it returns `{ ok: true, id, idempotencyKey }` or `{ ok: false, reason }` with reason
  `invalid_type | invalid_data | invalid_option | consent | destroyed`.
- **Transport**: `POST endpoint` with `{ events: [...] }`, `Authorization: Bearer <pk>`, `SS-Identity: <token>` when
  identified, `credentials: 'omit'`, `keepalive`. Batches of `batchSize` (20) or after `flushIntervalMs` (1 s).
  408/425/429/5xx and network errors retry with exponential backoff and jitter (1 s → 60 s, `Retry-After` honoured, at most
  `maxAttempts` = 8); any other non-2xx drops the batch (no poison loops). The ingest must deduplicate on
  `(websiteId, idempotencyKey)`.
- **Offline queue**: persisted in `localStorage` (`ss:<websiteId>:q`) after every change, capped at `maxQueue` (500) items and
  `maxQueueBytes` (256 kB), oldest dropped first; reloaded and sent on the next page. While `navigator.onLine === false`
  nothing is sent and attempts are not counted; the `online` event resumes.
- **Page hide**: on `pagehide` and `visibilitychange → hidden` the queue goes to `navigator.sendBeacon` in chunks of
  ≤ `beaconMaxBytes` (60 kB) as `text/plain` (no CORS preflight). Beacons cannot carry headers, so the body is
  `{ key, identity?, events }` — **the ingest endpoint must accept both header and body authentication.**
- **Consent**: every event has a category — `customer.* cart.* order.* inventory.* price.* file.*` and `item.created|updated|deleted` are `necessary`
  (always granted), everything else `analytics`; override with `categories: { 'chat.*': 'functional' }` or per call
  `{ category }`. Events of non-granted categories are dropped, and revoking a category purges its queued events.
  Anonymous and session ids are persisted only while `analytics` is granted (otherwise they live for the page only).
  Decisions persist in `ss:<websiteId>:consent`; `consent.subscribe()` notifies the Loader.
- Sessions rotate after 30 min of inactivity (`sessionTimeoutMs`).

## Quickstart 2 — your own UI on a headless element (Mode B)

A product ships the headless core; the merchant's developer renders it however they like.

```js
// product: headless/apply-box.js — no DOM access here
import { defineElement, err, problem } from '@ss/web/element';

export const applyBox = defineElement({
	key: 'apply_box',
	strings: { label: 'Coupon code', applied: 'You saved {{amount}}' },
	initialState: ({ config }) => ({ status: 'idle', code: '', maxLength: config.maxLength }),
	validate: (code, { strings }) => (String(code ?? '').trim() ? [] : [{ path: '', code: 'required', message: strings.label }]),
	create: ({ store, client, emit, validate }) => ({
		actions: {
			setCode: (code) => store.setState({ code }),
			apply: async () => {
				const problems = validate(store.getState().code);
				if (problems.length) return err(problem('validation_failed', { errors: problems }));
				store.setState({ status: 'loading' });
				const result = await client.post('/v1/coupons:apply', { code: store.getState().code }); // Idempotency-Key added
				store.setState({ status: result.ok ? 'ready' : 'error' });
				if (result.ok) emit('applied', { code: store.getState().code }); // → 'apply_box.applied'
				return result;
			},
		},
	}),
});
```

```js
// merchant site: any framework, or none
import { createElementApi, mountHeadless } from '@ss/web/element';
import { applyBox } from '@coupons/elements/headless/apply-box.js';

const box = mountHeadless(applyBox, {
	config, // the element's feature values (from the entitlement document / bundle)
	strings: { label: 'Voucher' }, // overrides for the active language
	client: createElementApi({ baseUrl: config.apiBaseUrl, key: 'pk_live_…', identity: { token: () => ss.identity() } }),
	emit: (type, data) => ss.track(type, data, { element: 'apply_box' }),
});
box.subscribe((state) => render(state)); // immutable snapshots; same object until something changes
await box.actions.setCode('FALL10');
const result = await box.actions.apply(); // Result: { ok: true, value } | { ok: false, error: Problem }
if (!result.ok) showError(result.error.code); // stable codes: validation_failed, quota_exhausted, network_error, …
box.destroy();
```

- Instance shape (Part E §4): `{ key, state(), actions, subscribe, validate, strings, destroy, isDestroyed }`. Actions are
  async, **never throw** (a throw becomes `internal_error`; after `destroy` → `destroyed`) and always return a Result.
  `validate` is synchronous and pure. Config is deep-frozen; strings are the defaults merged with string overrides
  (`formatString(template, params)` fills `{{placeholders}}` as text).
- `createStore(initial)` → `{ getState, setState(patch | fn), subscribe }` with shallow compare and frozen snapshots.
- `createElementApi({ baseUrl, key, fetch?, identity?, timeoutMs? })` → `{ get, post, put, patch, delete, request }`: JSON,
  `Authorization: Bearer <pk>`, `SS-Identity`, `Idempotency-Key` on POST (generated unless given), paths must stay on the
  base origin. Errors come back as `Problem`s parsed from RFC 9457 bodies (`parseProblem`): `code` = body `code`, else the
  last segment of `type`, else from the status; client-side codes `network_error`, `timeout`, `aborted`,
  `invalid_response`, `invalid_request` have `status: 0`.

**React** (React is an optional peer and never imported by the SDK):

```js
import * as React from 'react';
import { createUseElement } from '@ss/web/react';
export const useElement = createUseElement(React);

function ApplyBox(props) {
	const { state, element } = useElement(applyBox, props.options); // useSyncExternalStore; StrictMode-safe
	return <input value={state.code} onChange={(e) => element.actions.setCode(e.target.value)} />;
}
```

**Vue / Svelte** (no adapter shipped; the pattern is three lines): mount once per component with `mountHeadless`,
mirror `state()` through `subscribe`, and `destroy()` on unmount — Vue:
`const s = shallowRef(el.state()); const off = el.subscribe((v) => (s.value = v)); onUnmounted(() => { off(); el.destroy(); })`;
Svelte: `const state = readable(el.state(), (set) => el.subscribe(set)); onDestroy(el.destroy)`.

## Quickstart 3 — drop-in via the Loader (Mode A)

The website-bundle compiler (Portal) emits one immutable script per website version; it imports the Loader, the enabled
elements' code (lazily) and the signed config, then calls `boot`:

```js
import { boot } from '@ss/web/loader';
import { createClient } from '@ss/web/client';
import { evaluateAudienceProgram } from '@ss/web/audience'; // only when some element has `placement.audience`

const client = createClient({ key: 'pk_live_…', endpoint: '…', websiteId: 'web_…', defaultConsent: {} });
boot({
	websiteId: 'web_…',
	env: 'live',
	client,
	audience: evaluateAudienceProgram,
	bundle: {
		version: '17',
		timeZone: 'Asia/Karachi',
		theme: { color: { primary: '#0a5' }, radius: { md: '8px' } }, // website design tokens
		csp: { nonce: '…' },
		rum: { sampleRate: 0.1 },
		doc: entitlementDocuments, // elements a document disables never mount
		elements: [
			{
				key: 'notice_bar',
				placement: {
					paths: { include: ['/**'], exclude: ['/checkout/**'] },
					devices: ['mobile', 'desktop'],
					schedule: { timezone: 'Asia/Karachi', windows: [{ days: ['fri'], start: '18:00', end: '02:00' }] },
					consent: ['marketing'],
					triggers: [{ type: 'scroll', percent: 40 }],
					frequency: { maxPerSession: 1, dismissMemory: 'P7D' },
					audience: compiledProgram, // rules@1 program, compiled at build time
				},
				config: { message: '…' },
				strings: { cta: 'Shop now' },
				headless: () => import('./notice-bar/headless.js'), // lazy: loaded only when placement + trigger fire
				renderer: () => import('./notice-bar/renderer.js'),
				reserve: { minHeight: 48 }, // no CLS while the code loads
			},
		],
	},
});
```

A default renderer is a pure function of `{ state, actions, strings, theme, slots, element, h, nonce, reducedMotion }`
returning a Node (optionally `update(node, props)` for in-place updates that keep focus):

```js
export const render = ({ state, actions, strings, h }) =>
	h(
		'div',
		{ role: 'region', 'aria-label': strings.label, className: 'ss-notice' },
		h('p', null, state.message), // text only — never HTML
		h('button', { type: 'button', onClick: () => actions.dismiss() }, strings.close),
	);
```

**Placement** (`@ss/contracts` placement v1), evaluated cheapest-first; anything that fails to evaluate does not match:

| Rule        | Semantics                                                                                                                                                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `paths`     | globs on `location.pathname`: `*` within one segment, `**` across; trailing slash and query ignored; exclude wins                                                                                                                                                                          |
| `pageTypes` | `boot({ pageType })`, else `<html data-ss-page-type>`, else `<meta name="ss:page-type">`                                                                                                                                                                                                   |
| `devices`   | viewport width: < 768 mobile, < 1024 tablet, else desktop (`breakpoints` configurable)                                                                                                                                                                                                     |
| `referrers` | referrer host: `example.com` exact, `*.example.com` subdomains only; an include list needs a referrer                                                                                                                                                                                      |
| `schedule`  | `[from, until)` plus weekly windows in `timezone`; `start > end` crosses midnight and belongs to its start day                                                                                                                                                                             |
| `consent`   | every listed category granted (re-evaluated live: grant mounts, revoke unmounts)                                                                                                                                                                                                           |
| `selectors` | mount at the first present selector (`before`/`after`/`prepend`/`append`/`replace`; `replace` is undone on unmount); none present → no match; no selectors → appended to `<body>`                                                                                                          |
| `audience`  | rules@1 via the injected evaluator; context = `boot({ context })` + `page`, `device`, `consent`, `visitor.identified`; zone = `bundle.timeZone` › schedule zone › UTC; no evaluator → no match                                                                                             |
| `triggers`  | any of `load` (`delayMs`), `idle` (`afterMs` without pointer/key/scroll/touch), `scroll` (`percent` depth), `exit` (pointer leaves through the top), `selector-click` (delegated), `event` (a tracked or element event; `cart.updated@1` exact, `chat.opened` any version); default `load` |
| `frequency` | `maxPerSession`, `maxPerDay` (rolling 24 h), `maxPerVisitor`, `cooldown`, `dismissMemory` (set when the element emits `<key>.dismissed`), persisted in `ss:<websiteId>:fq:<key>`; checked when armed and again when the trigger fires                                                      |

**Isolation**: every element is mounted inside its own error boundary. A failing import, `create`, render or re-render
marks only that element `failed`, removes its container, calls `onError({ key, phase, error })`, dispatches
`ss:error` on `window` and tracks `loader.element_failed@1` (`{ element, phase, code: <phase>_failed, message }`, never the error text); merchant hooks and listeners are isolated too.

**Events**: elements' `emit(verb, data)` becomes `<key>.<verb>@1` tracked with `context.element`, delivered to
`SS.on(type | '*', handler)` hooks and `event` triggers. The Loader emits `<key>.shown` on each mount.

**RUM**: when sampled (`bundle.rum.sampleRate`), LCP, CLS (session windows) and INP (p98 of interactions, via
`PerformanceObserver` when available) plus per-element `mountMs` are tracked once as `loader.vitals@1` on page hide.

**`window.SS`** (namespaced, idempotent — booting twice for the same website returns the running instance and mounts
nothing twice): `track`, `identify`, `consent.get/set`, `elements.get(key)` (the mounted headless instance, so a
merchant can drive a drop-in element from their own code), `elements.list()`, `on`, `refresh()` (SPA navigation; also
on `popstate`). Calls made before the Loader arrives can be queued in a stub: `window.SS = { q: [['track', 'custom.x', {}]] }`.

## Namespaced ids and read clients (F.18)

- A bundle element may carry `product` (its product slug): its id is then `<product>:<key>`, so two products can
  deliver the same key on one page. `SS.elements.get(name)` accepts the id, or a bare key that only one element has;
  `list()` entries add `id` and `product`. Element events reach `SS.on` as `<key>.<verb>` and as
  `<product>:<key>.<verb>` (the events client still sends `<key>.<verb>`). Containers keep `data-ss-element="<key>"`
  and add `data-ss-product` and `data-ss-id`. Frequency caps stay keyed by the bare key while it is unique.
- `reads: { <slug>: { baseUrl } }` on a bundle element gives its headless core `clients[<slug>]`, an element API client
  (`createElementApi`) bound to that base and the website key — how packs read service products (`manifest.reads`).
  `mountHeadless(definition, { clients })` passes them to `create({ clients })`.

## Renderer helpers (Mode A)

- `h(tag, props, ...children)` — allowlisted HTML tags (no `script`, `style`, `iframe`, `object`, `embed`, `form`,
  `template`, `link`, `meta`, `base`) plus icon SVG; strings/numbers become **text nodes**; only allowlisted attributes plus
  `aria-*`/`data-*`; `on*` only as functions (`onClick`); `href` limited to http(s)/mailto/tel/relative, `src` to
  http(s)/relative; `target=_blank` forces `rel="noopener noreferrer"`; `style` only as an object and CSS values refuse
  `url()`, `expression()`, `;{}<>\`, `@import`. Never `innerHTML`.
- `tokens.toVars(theme)` / `tokens.apply(el, theme)` — nested design tokens → `--ss-<path>` custom properties (sanitised).
- `slot(name, slots, fallback)` — merchant content: Node (cloned), text, `{ template: '#id' }` (clone of a `<template>`
  on the merchant's own page) or a function; falls back to the renderer default.
- `reserveSpace(el, { minHeight, minWidth, aspectRatio })` → `release()`; `prefersReducedMotion()`.
- `focusables(root)`, `focusFirst(root)`, `saveFocus()`, `trapFocus(root, { onEscape })` → `release()` (restores focus).
- `button({ label, icon?, onClick })` always has an accessible name; `liveRegion(parent)` → `{ announce(text), destroy }`;
  `VISUALLY_HIDDEN`, `uniqueId()`.

## Size

Measured with esbuild (`--bundle --minify --format=esm`, gzip -9): Loader + events client + renderer helpers used by the
Loader ≈ 12.8 kB gzip (31 kB min), inside the < 15 kB core budget (§4.1). The audience evaluator adds ≈ 9 kB gzip
(`evaluateAudienceProgram`, precompiled programs) or ≈ 12 kB (`evaluateAudience`, with the parser), so it is only
bundled for websites that use audience rules, and its size counts against that website's budget.
