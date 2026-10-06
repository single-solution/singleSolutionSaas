# @ss/protocol

App Protocol primitives shared by the Portal and every product (PLAN.md §8, §11, Part E §5 and §10).

- JavaScript ESM, functional (no classes), JSDoc-typed, `tsc --checkJs --strict`.
- **EdDSA (Ed25519) only**, every signature carries a `kid`, keys are published as JWKS.
- Time (`now`), randomness (`randomBytes`) and state (replay stores, nonce stores, burn functions, revocation lists) are
  always passed in, so every rule can be tested deterministically.
- Every failure throws a `ProtocolError` with a stable `code` (see `ERROR_CODES`). Messages never contain tokens, keys
  or secrets, so they are safe to log.
- No URLs, issuers or audiences are hard-coded: they are all parameters.

| Module                  | Exports                                                                                                                                                                                                                                       |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `keys.js`               | `generateSigningKey`, `createSigner`, `importPublicKey`, `importPrivateKey`, `exportPublicJwk`, `toPublicJwk`, `createJwks`, `createKeyResolver`, `thumbprint`                                                                                |
| `launch.js`             | `issueLaunch`, `verifyLaunch`, `kindScopeViolation`, `LAUNCH_KINDS`, `LAUNCH_TYP`, TTL constants                                                                                                                                              |
| `assertion.js`          | `signAssertion`, `verifyAssertion`, `ASSERTION_TYP`, `MAX_ASSERTION_LIFETIME_SECONDS`                                                                                                                                                         |
| `replay.js`             | `createMemoryReplayStore` (tests only), `consumeWith`                                                                                                                                                                                         |
| `website-keys.js`       | `issueWebsiteKey`, `verifyWebsiteKey`, `originAllowed`, `normalizeDomain`, `hashSecretKey`, `compareSecretKey`                                                                                                                                |
| `entitlement-doc.js`    | `signEntitlementDocument`, `verifyEntitlementDocument`, `DEFAULT_GRACE_MS`                                                                                                                                                                    |
| `events.js`             | `signEvent`, `verifyEvent`, `EVENT_HEADERS`                                                                                                                                                                                                   |
| `requests.js`           | `signRequest`, `verifyRequest`, `canonicalRequestPath`                                                                                                                                                                                        |
| `registration.js`       | connection codes: `createConnectionCode`, `parseConnectionCode`, `createConnectRequest` / `verifyConnectResponse` (product), `verifyConnectRequest` / `createConnectResponse` (Portal), `hashManifest`, `hashConnectionToken`, `canonicalUrl` |
| `bundle.js`             | `signBundle`, `verifyBundle`, `bundleSigningInput`, `BUNDLE_SIGNING_PREFIX` (element-pack bundles)                                                                                                                                            |
| `manifest-signature.js` | `signManifest`, `verifyManifest`, `MANIFEST_TYP`, `MANIFEST_SIGNATURE_HEADER`, `DEFAULT_MANIFEST_MAX_AGE_SECONDS`                                                                                                                             |
| `errors.js`             | `createProtocolError`, `isProtocolError`, `ERROR_CODES`                                                                                                                                                                                       |

## Token types

Every signed object has its own JOSE `typ`, and each verifier accepts only its own, so a token of one kind can never be
replayed as another (a launch as an assertion, an entitlement document as a website key, …).

| Object                   | `typ`                          | Lifetime                             | Replay protection                               |
| ------------------------ | ------------------------------ | ------------------------------------ | ----------------------------------------------- |
| Launch                   | `ss-launch+jwt`                | 60 s default, ≤ 300 s                | `consume(jti)` — single use                     |
| Client assertion         | `ss-assertion+jwt`             | ≤ 300 s                              | replay store on `iss\|jti`                      |
| Website key              | `ss-website-key+jws`           | optional `exp`; revocable by `keyId` | n/a (bearer credential)                         |
| Entitlement document     | `ss-entitlement+jws`           | `validUntil` + offline grace         | n/a (idempotent state)                          |
| Connect request          | `ss-connect+jws`               | `iat` ± 5 min                        | one-time token burn (Portal)                    |
| Connect answer           | `ss-connected+jws`             | `iat` ± 5 min                        | echoes the product's request nonce              |
| Manifest signature       | `ss-manifest+jws`              | `iat` ≤ `maxAgeSec` (24 h) old       | n/a (binds `appId` + manifest hash)             |
| Pack bundle signature    | detached, `ss-pack-bundle.v1.` | none (pinned developer key)          | n/a (binds the descriptor hash)                 |
| Event delivery           | detached, `SS-*` header        | `SS-Timestamp` ± 300 s               | replay store on `timestamp\|sha256`             |
| Portal → product request | detached, `SS-*` header        | `SS-Timestamp` ± 300 s               | replay store on `ts\|METHOD\|aud\|path\|sha256` |

Common JWS rules (`jws.js`): header must be `alg: EdDSA` (no `none`, no HMAC, no RSA) with a `kid` and the expected
`typ`; `jwk`, `jku`, `x5u`, `x5c`, `x5t`, `crit`, `b64`, `zip` are refused, so a token can never tell the verifier
where to find its key; the length is capped before parsing; `jose.compactVerify` runs with `algorithms: ['EdDSA']`.

## Keys, JWKS and rotation

```
Portal                                       Product
  │ generateSigningKey({kid:'portal-2026-10'})  │
  │ publish JWKS { keys:[old(exp=T+overlap), new] }
  │──────────── GET /.well-known/jwks.json ────▶│ createKeyResolver({ fetchJwks, cacheTtlMs })
  │ sign with new kid                           │ token.kid unknown → refetch (≤ 1 per minRefreshIntervalMs)
  │                                             │ old kid valid until its exp, then key_retired
  │ compromise → revoke kid                     │ revokedKids / isRevoked → revoked_key, immediately
```

- `createKeyResolver` caches the JWKS for `cacheTtlMs` (default 5 min), refetches when it sees an unknown `kid`, but at
  most once per `minRefreshIntervalMs` (default 30 s), so forged kids cannot make it hammer the Portal.
- **Overlap window**: JWK members may carry `nbf`/`exp` (seconds). Publish the new key ahead of time with `nbf`, keep
  the old one with `exp` = end of overlap. Both verify during the overlap; each is refused outside its window.
- **Portal outage**: if a refetch fails, last-known keys keep working until `maxStaleMs` (default 24 h) after the last
  successful fetch, then `jwks_unavailable`. This matches "product runtime unaffected by Portal outage" (§12).
- **Revocation** is checked on every resolve and beats everything else. Duplicate kids in a JWKS are ambiguous and are
  dropped entirely.
- `Signer` is `{ kid, alg, sign(bytes) }`, so a KMS/HSM signer can replace `createSigner(privateJwk)`. Private keys
  are imported non-extractable.

## SSO launch

```
Browser              Portal                                   Product
  │ "Open Coupons"    │                                          │
  │──────────────────▶│ issueLaunch({ kind, user, scope,         │
  │                   │   subscriptions, aud: appId, ttl 60s })  │
  │◀── 302 product/sso?launch=<jwt> ─────────────────────────────│
  │─────────────────────────────────────────────────────────────▶│ verifyLaunch({ issuer, audience: appId,
  │                                                              │   keyResolver(Portal JWKS), consume })
  │                                                              │ → sets its own session; jti consumed
  │◀────────────────────────────── dashboard ────────────────────│
```

Checks: signature and `typ`; `iss` and `aud` are exact string matches (no audience arrays); `exp`/`nbf`/`iat` with a
5 s skew; `exp − iat ≤ 300 s` even if the Portal signed something longer; kind/scope rules; then `consume(jti)`, which
must be atomic and shared across instances (see replay stores below).

Kind/scope rules (`kindScopeViolation`), enforced both when issuing and when verifying:

| kind          | must carry                                                                        | must not carry            |
| ------------- | --------------------------------------------------------------------------------- | ------------------------- |
| `merchant`    | `scope.merchantId`                                                                | `act`, `impExp`           |
| `admin`       | `scope.all: true` (app-wide) **or** `scope.merchantId` (+ `scope.subscriptions?`) | `act`, `impExp`           |
| `demo`        | —                                                                                 | `scope.merchantId`, `act` |
| `partner`     | `scope.partnerId`                                                                 | `act`, `impExp`           |
| `developer`   | `scope.developerId`                                                               | `act`, `impExp`           |
| `impersonate` | `act.sub` (staff actor, ≠ `sub`), `scope.merchantId`, `iat < impExp ≤ iat + 3600` | —                         |

`impExp` is the maximum session length the product may grant for an impersonation (at most 1 h), independent of the
60 s launch lifetime. Products must show the audit banner and record `act.sub` on every action.

`scope.all: true` (app-wide management, e.g. platform staff administering the product itself) is allowed only for
`admin` and is exclusive: next to it only `permissions` may appear (no `merchantId`, `websiteId(s)`, `subscriptions`).
`scope.subscriptions`, when present on any kind, must be a list of non-empty ids. The JSDoc types `LaunchScope`,
`LaunchUser` and `LaunchClaims` are exported from the package index.

## Client assertions (product → Portal)

```
Product                                               Portal
  │ signAssertion({ appId, audience, ttl ≤ 300s })      │
  │── Authorization: Bearer <assertion> ───────────────▶│ verifyAssertion({ keyResolverForApp, audience, replayStore })
  │                                                     │  1. peek iss → keys registered for that app only
  │                                                     │  2. signature, typ, iss = sub = appId, aud, jti ≥ 16 chars
  │                                                     │  3. time, lifetime ≤ 300 s, replay store `iss|jti`
```

Keys are looked up per app (from the peeked `iss`), so an app can only authenticate as itself: a token signed by app A
but claiming `iss: B` is checked against B's keys and fails.

**Replay stores**: interface `{ seen(id, expiresAtMs) → boolean | Promise<boolean> }` (true = already seen). Production
must use a store shared by every instance, with atomic insert-if-absent and TTL — for example a MongoDB collection with
a unique `_id` and a TTL index on `expiresAt` (duplicate-key error = seen) or Redis `SET id 1 NX PXAT expiresAt`.
`createMemoryReplayStore` is for tests; when full it fails closed. `consumeWith(store)` adapts a store to the launch
`consume(jti)` shape.

## Website keys

Format: `pk_live_<jws>`, `pk_test_<jws>`, `sk_live_<jws>`, `sk_test_<jws>`. Claims:
`{ v, kind, websiteId, merchantId, domain, allowSubdomains, env, scopes[], keyId, iat, exp? }`; the signing `kid` is in
the JWS header and is returned by `verifyWebsiteKey`. The prefix must agree with the signed `kind` and `env`, so a
`pk_` cannot be relabelled `sk_` or a test key relabelled live.

```
Browser (pk_)            Product                                   Portal
  │── Bearer pk_live_… ──▶│ verifyWebsiteKey (offline, Portal JWKS)   │
  │   Origin: https://…   │ revocations (cached list, ≤ 5 min) ◀──────│ revoked keyIds
  │                       │ originAllowed({ origin, referer, domain,  │
  │                       │   allowSubdomains, env })                 │
Server (sk_)              │                                           │
  │── Bearer sk_live_… ──▶│ verifyWebsiteKey({ expectedKind: 'sk' })  │
```

**Decision for `sk_`: signed token, verified offline, plus server-side revocation by `keyId`.**

- For: products verify without a Portal call per request (latency, cost, and Portal outages do not stop products, §6.4
  and §12); the binding (websiteId, merchantId, env, scopes) is authenticated, so `X-SS-Website` can never override it.
- Against: a leaked `sk_` stays usable until the revocation list reaches every product (bounded by its cache TTL) or
  until `exp`, whereas an opaque random key checked online dies instantly.
- Mitigations: revocation list cache ≤ 5 min (aligned with entitlement freshness), optional `exp`, least-privilege
  `scopes`, test/live separation, a recognisable `sk_` prefix for secret scanners, and the Portal stores only
  `hashSecretKey({ key, pepper })` (HMAC-SHA-256 with a pepper kept outside the database) and shows the key once;
  `compareSecretKey` compares in constant time. The claims inside an `sk_` are readable by whoever holds it, and
  contain nothing secret.
- Signing-key compromise is handled by kid revocation, which invalidates every website key signed with that kid at
  once; website keys should be re-issued on Portal key rotation.

**`pk_` keys are public.** `originAllowed` ties browser traffic to the bound domain, but `Origin`/`Referer` are
forgeable by non-browser clients, so a `pk_` must only unlock browser-safe, rate-limited operations.

`originAllowed` rules:

- `Origin` is authoritative when present; `Referer` is used only when `Origin` is absent; a mismatching `Origin` is
  never rescued by a matching `Referer`; `null` origins are refused.
- `https` only. In the `test` env, `http(s)` origins on `localhost`, `*.localhost`, `127.0.0.1` and `[::1]` are always
  accepted; in `live` they never are.
- Parsed with the WHATWG URL parser; userinfo, whitespace, control characters and backslashes are refused; an Origin
  with a path, query or fragment is refused; ports are ignored.
- Hosts are compared as lower-case punycode with any trailing dot removed: an exact match, or with `allowSubdomains`
  a match on `.` + domain. `evil-example.com`, `example.com.evil.com`, `example.comm` and Cyrillic look-alikes never
  match; `www.` is not implied.

## Entitlement documents

```
Portal                                 Product
  │ signEntitlementDocument(payload)     │
  │── GET /v1/entitlement (pull) ───────▶│ verifyEntitlementDocument({ keyResolver, expectedDomain, graceMs })
  │                                      │  now ≤ validUntil            → { stale: false }
  │     (Portal unreachable)             │  validUntil < now ≤ +grace   → { stale: true }  keep serving, retry refresh
  │                                      │  now > validUntil + grace    → expired (hard stop)
```

The payload schema belongs to `@ss/contracts`; this module needs only `validUntil` (ISO-8601, required) and optionally
`validFrom`, `issuedAt` and `domain`. `expectedDomain` compares normalised punycode hosts. The default grace is 24 h,
matching the manifest's default `offlineGrace: PT24H`; pass the product's declared value.

## Signed events and webhooks

```
Portal / Event Hub                                         Product
  │ headers = signEvent({ signer(s), body, timestamp })      │
  │── POST /.well-known/ss-events ─────────────────────────▶ │ verifyEvent({ headers, rawBody, keyResolver,
  │   SS-Timestamp: 1790812800                               │   replayStore, toleranceSec: 300 })
  │   SS-Signature: v1;kid=portal-2;sig=<b64url>             │  1. |now − ts| ≤ 300 s
  │   SS-Key-Id: portal-2                                    │  2. Ed25519 over "ss-event.v1.<ts>.<sha256hex(body)>"
  │                                                          │  3. replay store on "<ts>|<sha256>" until ts + 300 s
```

- Signed message: `ss-event.v1.${timestamp}.${hex(sha256(rawBody))}`. The `ss-event.v1.` prefix separates it from JWS
  signing inputs made with the same key; hashing the body keeps the message small.
- `SS-Signature` may hold up to four comma-separated entries so the sender can dual-sign during key rotation; the
  verifier accepts the delivery when any entry verifies under a trusted, unrevoked key.
- `SS-Key-Id` is a routing and logging hint only; verification uses the `kid` inside each signature entry.
- Always verify the raw bytes before parsing JSON. Duplicate headers are treated as missing.
- Event signatures cover the body only, so use them only for deliveries to one fixed endpoint (the product's
  declared events endpoint). Every other Portal → product call must use signed requests (below).

## Signed Portal → product requests

```
Portal                                                      Product
  │ headers = signRequest({ signer(s), method, path,          │
  │   audience: appId, body, timestamp })                     │
  │── POST /v1/data:export?b=2&a=1 ──────────────────────────▶│ verifyRequest({ method, path: req.url,
  │   SS-Timestamp: 1790812800                                │   audience: ownAppId, headers, rawBody,
  │   SS-Signature: v1;kid=portal-2;sig=<b64url>              │   keyResolver, replayStore, toleranceSec: 300 })
  │   SS-Key-Id: portal-2                                     │  1. |now − ts| ≤ 300 s
  │                                                           │  2. Ed25519 over
  │                                                           │     "ss-request.v1.<ts>.<METHOD>.<aud>.<canonicalPath>.<sha256hex(body)>"
  │                                                           │  3. replay store on "<ts>|<METHOD>|<aud>|<path>|<sha256>"
```

- Body-only signatures would let a captured signed body be replayed to another endpoint, or with another method,
  inside the tolerance window. Request signatures bind method, path, query and audience as well as the body.
- `ss-request.v1.` differs from `ss-event.v1.`: an event signature never verifies as a request and vice versa.
- `audience` is the receiving product's appId, which may not contain `/`. It stops a product from replaying a Portal
  request it received to another product that trusts the same Portal key. The message stays unambiguous because the
  canonical path always starts with `/` and the body hash is a fixed 64 hex characters.
- `canonicalRequestPath(path)`:
   - The target must be a path starting with a single `/`. A scheme, authority, fragment, whitespace, control
     character or backslash is rejected.
   - Dot segments are resolved and the path is percent-encoded by the WHATWG parser. Escape hex is then upper-cased
     and escapes of unreserved characters are decoded.
   - Query parameters are decoded, sorted by name and then value (duplicates kept) and re-encoded with strict RFC 3986
     encoding. Reordering and equivalent encodings (`%31` for `1`, `+` for a space) therefore verify, while any change
     of a name or value does not. An empty query is dropped.
   - A trailing slash is significant.
- Verify against the path the Portal addressed (normally `req.url`). If a proxy rewrites paths, pass the original path.
- The method is upper-cased and the body defaults to empty (for GET).

## Connection code (one-time token + proof of possession + pinned URLs)

```
Staff / owner          Portal                                              Product (deployed with DATABASE_URI only)
  │ Add product ──────▶ │ createConnectionCode({ portalUrl })              │
  │ ◀── ssc_… (once) ── │  stores sha256(token) only, 24 h, single use     │
  │ paste code at /setup ───────────────────────────────────────────────────▶│ parseConnectionCode → { portalUrl, token }
  │                     │                                                   │ generate an Ed25519 key
  │                     │◀── POST <portalUrl>/v1/apps/connect ──────────────│ createConnectRequest({ code, baseUrl,
  │                     │   Authorization: Bearer <token>                   │   manifest, signer, publicJwk })
  │                     │   { request: JWS{ portalUrl, baseUrl, tth,        │
  │                     │       manifestHash, jkt, nonce, iat }, publicJwk, │
  │                     │     manifest }                                    │
  │                     │ verifyConnectRequest({ headers, body, portalUrl })│
  │                     │  a. tth = sha256(bearer token), token known/open  │
  │                     │  b. JWS verifies under the included publicJwk     │
  │                     │  c. jkt = RFC 7638 thumbprint(publicJwk)          │
  │                     │  d. portalUrl = us; |now − iat| ≤ 5 min           │
  │                     │  e. manifestHash = sha256(canonicalJson(manifest))│
  │                     │ burn the token atomically, pin baseUrl + key      │
  │                     │── 200 createConnectResponse ──────────────────────▶│ verifyConnectResponse({ body, portalUrl,
  │                     │   { appId, jwks, response: JWS{ appId, portalUrl, │   nonce, jkt })
  │                     │       jkt, nonce, iat } signed by the Portal }    │ store portalUrl, appId, key, Portal JWKS
```

- The code is opaque: `ssc_` + base64url(`<portal URL> <token>`), the token 256-bit random (`sct_…`). The Portal keeps
  only `hashConnectionToken(token)`; the product never stores the token at all.
- **Proof of possession.** The request is signed with the private key of the JWK the product connects with, so nobody
  can bind a key they cannot sign with. It also signs the token hash (`tth`), the manifest hash and the base URL, so a
  proxy cannot swap the manifest or the address, and it echoes into the Portal's signed answer (`nonce`, `jkt`), so an
  answer cannot be replayed into another connection.
- **Pinning.** The product accepts the answer only from the Portal URL inside the code, verified against the JWKS it
  returns over TLS, and keeps that URL and those keys. The Portal pins the product's base URL and key; from then on
  both sides trust only each other's keys (client assertions, launches, entitlements, events).
- Errors: `malformed` (shape, token missing, JWK, nonce), `unknown_kid`, `signature` (signature, thumbprint, manifest
  hash, token binding), `audience` (another Portal), `subject` (another key), `replay` (nonce), `expired` (±5 min),
  `wrong_type`. The Portal answers every refusal with the same generic 401.

## Pack bundle signatures

Element packs are published as signed bundles rather than through a connection code. The developer signs
`ss-pack-bundle.v1.<sha256hex(canonicalJson(descriptor))>` with Ed25519. The signature is detached:
`{ kid, alg: 'EdDSA', sig: <base64url 64 bytes> }`.

- `signBundle({ signer, descriptor })` → `BundleSignature`.
- `verifyBundle({ descriptor, signature, publicJwk | keys | keyResolver })` → `Promise<boolean>`. It never throws.
  `publicJwk` is the pinned developer key, whose `kid` must match. `keys` are candidates matched by `kid`.
  `keyResolver` is any `KeyResolver`.

The output is byte-compatible with the Portal catalog's former `signatures.js`. The tests pin a signature vector.

## Signed manifests

A registered product serves `GET /.well-known/ss-app.json` with `SS-Manifest-Signature: <compact JWS>`
(`typ: ss-manifest+jws`), signed with its registered key. The payload is `{ appId, manifestHash, iat }`, where
`manifestHash = hashManifest(manifest)`, the same hash as the connect request. Before importing a refreshed
manifest, the Portal runs `verifyManifest({ manifest, jws, keyResolver /* the app's registered JWKS */, expectedAppId,
now, maxAgeSec = 86400, skewSeconds = 300 })`. It returns `{ appId, manifestHash, iat, kid }` or throws `wrong_type`,
`signature` (bad signature or manifest mismatch), `issuer` (another app), `expired` (older than `maxAgeSec`),
`not_yet_valid`, `malformed` or `unknown_kid`. A compromised host or CDN therefore cannot swap the manifest without
the product key. Before it is connected, a product has no appId and serves the manifest unsigned.

## Testing

```
pnpm check   # in this folder: format, lint, typecheck, vitest with coverage
```

The tests cover happy paths and every rejection path: expiry, not-yet-valid, wrong `aud`/`iss`/`kid`/`typ`, tampered
payloads and signatures, forged keys that reuse a kid, replayed `jti`s and events, revoked and retired keys, rotation
overlap, more than 50 origin cases, stale entitlements inside and past the grace window, and the full connection
matrix.
