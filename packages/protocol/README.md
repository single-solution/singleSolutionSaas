# @ss/protocol

App Protocol primitives shared by the Portal and every product (PLAN.md §8, §11, Part E §5 and §10).

- JavaScript ESM, functional (no classes), JSDoc-typed, `tsc --checkJs --strict`.
- **EdDSA (Ed25519) only**, every signature carries a `kid`, keys are published as JWKS.
- Time (`now`), randomness (`randomBytes`) and state (replay stores, nonce stores, burn functions, revocation lists) are
  always passed in, so every rule can be tested deterministically.
- Every failure throws a `ProtocolError` with a stable `code` (see `ERROR_CODES`). Messages never contain tokens, keys
  or secrets, so they are safe to log.
- No URLs, issuers or audiences are hard-coded: they are all parameters.

| Module               | Exports                                                                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `keys.js`            | `generateSigningKey`, `createSigner`, `importPublicKey`, `importPrivateKey`, `exportPublicJwk`, `toPublicJwk`, `createJwks`, `createKeyResolver`, `thumbprint`      |
| `launch.js`          | `issueLaunch`, `verifyLaunch`, `kindScopeViolation`, `LAUNCH_KINDS`, `LAUNCH_TYP`, TTL constants                                                                    |
| `assertion.js`       | `signAssertion`, `verifyAssertion`, `ASSERTION_TYP`, `MAX_ASSERTION_LIFETIME_SECONDS`                                                                               |
| `replay.js`          | `createMemoryReplayStore` (tests only), `consumeWith`                                                                                                               |
| `website-keys.js`    | `issueWebsiteKey`, `verifyWebsiteKey`, `originAllowed`, `normalizeDomain`, `hashSecretKey`, `compareSecretKey`                                                      |
| `entitlement-doc.js` | `signEntitlementDocument`, `verifyEntitlementDocument`, `DEFAULT_GRACE_MS`                                                                                          |
| `events.js`          | `signEvent`, `verifyEvent`, `EVENT_HEADERS`                                                                                                                         |
| `registration.js`    | `createRegistrationRequest` + `verifyRegistrationResponse` (Portal), `createRegistrationHandler` (product), `hashManifest`, `hashRegistrationToken`, `canonicalUrl` |
| `errors.js`          | `createProtocolError`, `isProtocolError`, `ERROR_CODES`                                                                                                             |

## Token types

Every signed object has its own JOSE `typ`, and each verifier accepts only its own, so a token of one kind can never be
replayed as another (a launch as an assertion, an entitlement document as a website key, …).

| Object               | `typ`                          | Lifetime                             | Replay protection                   |
| -------------------- | ------------------------------ | ------------------------------------ | ----------------------------------- |
| Launch               | `ss-launch+jwt`                | 60 s default, ≤ 300 s                | `consume(jti)` — single use         |
| Client assertion     | `ss-assertion+jwt`             | ≤ 300 s                              | replay store on `iss\|jti`          |
| Website key          | `ss-website-key+jws`           | optional `exp`; revocable by `keyId` | n/a (bearer credential)             |
| Entitlement document | `ss-entitlement+jws`           | `validUntil` + offline grace         | n/a (idempotent state)              |
| Registration request | `ss-registration+jws`          | `iat` ± 5 min                        | nonce store + one-time token burn   |
| Registration proof   | `ss-registration-response+jws` | `iat` ± 5 min                        | echoes the Portal's request nonce   |
| Event delivery       | detached, `SS-*` header        | `SS-Timestamp` ± 300 s               | replay store on `timestamp\|sha256` |

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
| `admin`       | `scope.merchantId` (admins are always scoped to a merchant)                       | `act`, `impExp`           |
| `demo`        | —                                                                                 | `scope.merchantId`, `act` |
| `partner`     | `scope.partnerId`                                                                 | `act`, `impExp`           |
| `developer`   | `scope.developerId`                                                               | `act`, `impExp`           |
| `impersonate` | `act.sub` (staff actor, ≠ `sub`), `scope.merchantId`, `iat < impExp ≤ iat + 3600` | —                         |

`impExp` is the maximum session length the product may grant for an impersonation (at most 1 h), independent of the
60 s launch lifetime. Products must show the audit banner and record `act.sub` on every action.

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

## Registration handshake (one-time token + pinned Portal URL)

```
Developer              Portal                                              Product (deployed)
  │                      │                                                   │ env: REGISTRATION_TOKEN_HASH,
  │                      │                                                   │      PORTAL_URL (pinned)
  │ paste token ───────▶ │ createRegistrationRequest({ portalUrl, signer,    │
  │                      │   registrationToken, audience, appId })           │
  │                      │── POST /.well-known/ss-register ─────────────────▶│ handle({ headers, body })
  │                      │   Authorization: Bearer <token>                   │  1. token not burned
  │                      │   { request: JWS{ portalUrl, nonce, iat, tth,     │  2. sha256(token) = stored hash (const-time)
  │                      │                   aud, appId, portalJwksUrl } }   │  3. fetch JWKS from the PINNED URL only
  │                      │◀─────────── GET <pinned>/.well-known/jwks.json ───│     verify JWS (typ, kid, EdDSA)
  │                      │                                                   │  4. signed portalUrl = pinned URL
  │                      │                                                   │  5. |now − iat| ≤ 5 min
  │                      │                                                   │  6. tth = sha256(bearer token)
  │                      │                                                   │  7. aud = expectedAudience (if set)
  │                      │                                                   │  8. nonce unused (nonce store)
  │                      │                                                   │  9. sign proof with productSigner:
  │                      │                                                   │     JWS{ appId, manifestHash, jkt,
  │                      │                                                   │          nonce (echo), portalUrl, iat }
  │                      │                                                   │ 10. burnToken() atomically → true
  │                      │                                                   │ 11. onRegistered({ portalUrl, appId, portalKid })
  │                      │◀──── 200 { manifest, publicJwk, proof } ──────────│
  │                      │ verifyRegistrationResponse({ response,            │
  │                      │   expectedNonce: req.nonce, expectedPortalUrl,    │
  │                      │   expectedAppId })                                │
  │                      │  a. proof verifies under the included publicJwk   │
  │                      │     (header kid = JWK kid, typ, EdDSA)            │
  │                      │  b. jkt = RFC 7638 thumbprint(publicJwk)          │
  │                      │  c. nonce = our request nonce                     │
  │                      │  d. portalUrl = us, appId = expected              │
  │                      │  e. manifestHash = sha256(canonicalJson(manifest))│
  │                      │  f. |now − iat| ≤ 5 min                           │
  │                      │ → trust publicJwk as the app key, import manifest │
```

- The body's `portalJwksUrl` is informational and ignored: keys come only from the pinned Portal JWKS URL (by default
  `<allowedPortalUrl>/.well-known/jwks.json`, and it must share the pinned origin). An attacker holding a stolen token
  still cannot register without the Portal's private key.
- The token is never stored by either side: the product holds `hashRegistrationToken(token)`; the Portal uses it only
  for the request header. The signed `tth` binds the Portal's signature to that exact token.
- Every failure returns the same `401 { error: 'unauthorized' }`; the internal `reason` (`token_invalid`,
  `token_burned`, `portal_url`, `signature:<code>`, `timestamp`, `token_binding`, `audience`, `nonce_invalid`,
  `nonce_reused`, `body_malformed`, `internal_error`) is for server logs only.
- The token is burned before `onRegistered` runs. If `onRegistered` fails, the handler returns
  `500 { error: 'registration_failed' }` and the token stays burned; a new token is needed for a retry. Nothing can
  register twice.
- The response carries only the product's public JWK (`toPublicJwk` strips any private member).
- **Proof of possession.** The product signs its response with the private key of the JWK it registers
  (`productSigner`, same `kid`). The Portal verifies it with `verifyRegistrationResponse`, which proves that the product
  holds that private key, so nobody can register a public key they cannot sign with. Because the proof echoes the
  Portal's nonce and portal URL, a response cannot be replayed into another handshake or to another Portal. Because it
  signs the manifest hash, a proxy or tampered deployment cannot swap the manifest. The manifest hash is SHA-256 over
  canonical JSON (`canonicalJson`: sorted keys, no whitespace, RFC 8785-style), so key order and re-serialisation do
  not change it. The proof is signed before the token is burned; if signing fails, the token is not consumed.
- Portal-side error codes: `malformed` (shape, JWK, claims), `unknown_kid` (proof header kid ≠ JWK kid), `signature`
  (bad signature, thumbprint or manifest hash), `replay` (nonce not echoed), `audience` (other Portal), `subject` (other
  app), `expired` / `not_yet_valid` (outside ±5 min), `wrong_type`.

## Testing

```
pnpm vitest run packages/protocol --coverage
```

The tests cover happy paths and every rejection path: expiry, not-yet-valid, wrong `aud`/`iss`/`kid`/`typ`, tampered
payloads and signatures, forged keys that reuse a kid, replayed `jti`s and events, revoked and retired keys, rotation
overlap, more than 50 origin cases, stale entitlements inside and past the grace window, and the full registration
matrix.
