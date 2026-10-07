# Signups & Identity — developer guide

## Add sign-in to a website (Mode B)

```js
import { createElementApi } from '@ss/web/element';
import { createSignupsClient } from '<signups>/headless/client.js';
import { createSessionStore, deviceIdOf } from '<signups>/headless/session.js';
import { createSignIn } from '<signups>/headless/signIn.js';

const session = createSessionStore({ storage: localStorage }); // sessions.browser_storage
const api = createElementApi({ baseUrl: SIGNUPS_URL, key: 'pk_live_…', identity: { token: () => session.token() } });
const client = createSignupsClient({ api });
const widget = createSignIn({
	config: { ...widgetFeatures, channels: otpFeatures.channels, code_length: otpFeatures.code_length, documents },
	strings,
	client,
	session,
	deviceId: deviceIdOf({ storage: localStorage, random: () => crypto.randomUUID() }),
	emit: (type, data) => ss.track(type, data),
});
widget.subscribe(render);
// magic links: on the callback page, finish with the fragment token
const token = new URLSearchParams(location.hash.slice(1)).get('ss_magic');
if (token) widget.actions.consumeLink(token);
```

Send `session.token()` as `SS-Identity` to **any** product of the website once Signups is registered as the website's
identity issuer in the Portal (Website → Identity; `GET /v1/issuer` gives the exact values). Call
`session.ensureFresh(client)` before calls to refresh the access token early.

## Server-side (Mode C)

- Verify a customer on your own server offline: fetch `GET /.well-known/jwks/<websiteId>.json`, check `alg: EdDSA`,
  `iss = <signups base>/i/<websiteId>`, `aud`, `exp`.
- Import customers with `POST /v1/customers` (sk_), forward your customer's IP in `SS-Client-IP` when you proxy
  `POST /v1/otp` from your server.

Configuration comes only from the signed entitlement document (feature schemas in `schemas/`); turning an element off
disables all three modes (403 `element_disabled`).

Nothing runs on a timer on the server (no crons, no background passes): due deletions run when the customer is read
or from the dashboard's "Run due deletions" button, signing keys rotate and are pruned when read, and the identity
issuer request is sent on `entitlement.changed@1` (see `jobs/README.md`).
