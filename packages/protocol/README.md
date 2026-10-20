# @ss/protocol

Signing and verification shared by the Portal and every product (PLAN.md Part 0: 0.4.3 launches, 0.4.4 tokens, 0.4.5
tickets, 0.4.12 Product ↔ Portal contract), and the one format of sealed stored secrets (0.4.8).

- JavaScript ESM, functional (no classes), JSDoc-typed, `tsc --checkJs --strict`.
- **EdDSA (Ed25519) only**. Every signature carries a `kid`; keys are published as JWKS.
- Time (`now`), randomness (`randomBytes`) and state (replay stores, `consume`, `isRevoked`) are passed in, so every
  rule can be tested deterministically.
- Every failure throws a `ProtocolError` with a stable `code` (`isProtocolError(error, code?)`). Messages never contain
  tokens, keys or secrets, so they are safe to log.
- No URLs, issuers or audiences are hard-coded: they are all parameters.

What `@ss/protocol` exports, by module:

| Module            | Exports                                                                                                                                                                                                                                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `keys.js`         | `generateSigningKey` (the kid defaults to the key's thumbprint), `signingKeyFromSeed`, `createSigner`, `toPublicJwk`, `createJwks`, `createKeyResolver`                                                                                                                                                         |
| `tokens.js`       | `issueToken`, `verifyToken` (kinds `browser` and `server`), `canonicalOrigin`, `isLocalOrigin`, `originAllowed`, `ticketOriginAllowed`                                                                                                                                                                          |
| `tickets.js`      | `issueTicket`, `verifyTicket` (15 minutes)                                                                                                                                                                                                                                                                      |
| `launch.js`       | `issueLaunch`, `verifyLaunch`                                                                                                                                                                                                                                                                                   |
| `assertion.js`    | `signAssertion`, `verifyAssertion` (and the `ReplayStore` type)                                                                                                                                                                                                                                                 |
| `notices.js`      | `signNotice`, `verifyNotice` (the one check of notice bodies), `NOTICE_PATH`                                                                                                                                                                                                                                    |
| `calls.js`        | `signPortalCall`, `verifyPortalCall`                                                                                                                                                                                                                                                                            |
| `registration.js` | connect handshake: `createConnectRequest` / `verifyConnectResponse` (Portal), `verifyConnectRequest` / `createConnectResponse` (product), `isConnectSecret`, `canonicalUrl`, `CONNECT_PATH`                                                                                                                     |
| `errors.js`       | `isProtocolError`                                                                                                                                                                                                                                                                                               |
| `encoding.js`     | `canonicalJson` (sorted keys, no whitespace; the one deterministic JSON), `sha256Hex`, `hmacSha256Hex`, `constantTimeEqual` (hashes both sides first; anything not text or bytes is never equal), `randomToken(bytes = 32, randomBytes?)` (base64url)                                                           |
| `sealing.js`      | sealing of stored secrets (`ss2.<keyId>.<iv>.<tag>.<data>`, AES-256-GCM, key id derived from the key): `createSealer` (current and optional previous `ENCRYPTION_KEY`, at least 32 characters; `reseal`)                                                                                                        |
| `webhooks.js`     | `signWebhook({ body, secret, now? })` → `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`, `verifyWebhook({ header, body, secret, now?, toleranceSeconds? })` (any `v1`, ± 300 s by default: `WEBHOOK_TOLERANCE_SECONDS`), the signature of every call a product sends to a merchant server, and Stripe's |

## What is signed

Every signed object has its own JOSE `typ`, and each verifier accepts only its own, so one kind can never be replayed
as another (a ticket as a token, a launch as an assertion, …).

| Object           | Signed by          | `typ` / label            | Lifetime                    | Replay protection                        |
| ---------------- | ------------------ | ------------------------ | --------------------------- | ---------------------------------------- |
| Browser token    | Portal             | `ss-token+jws`           | no expiry; revoked by `jti` | n/a (bearer credential)                  |
| Server token     | Portal             | `ss-token+jws`           | no expiry; revoked by `jti` | n/a (bearer credential)                  |
| Ticket           | product (own key)  | `ss-ticket+jws`          | exactly 15 min              | bound to origin; ends with its `tid`     |
| Launch           | Portal             | `ss-launch+jwt`          | 60 s default, ≤ 300 s       | `consume(jti)`: single use               |
| Client assertion | product (its key)  | `ss-assertion+jwt`       | ≤ 300 s                     | replay store on `iss\|jti`               |
| Notice           | Portal             | detached, `ss-notice.v1` | `SS-Timestamp` ± 300 s      | replay store on `aud\|timestamp\|sha256` |
| Portal call      | Portal             | detached, `ss-call.v1`   | `SS-Timestamp` ± 300 s      | replay store on `SS-Nonce`               |
| Connect request  | HMAC               | `ss-connect.v1`          | timestamp ± 5 min           | nonce record (product)                   |
| Connect answer   | HMAC               | `ss-connected.v1`        | timestamp ± 5 min           | echoes the Portal's request nonce        |
| Webhook          | shared secret HMAC | `t=…,v1=…` header        | `t` ± 300 s                 | none (the receiver dedupes by id)        |

Common JWS rules (`jws.js`): the header must be `alg: EdDSA` with a `kid` and the expected `typ`; `jwk`, `jku`, `x5u`,
`x5c`, `x5t`, `crit`, `b64`, `zip` are refused, so a token can never tell the verifier where to find its key; the
length is capped before parsing; `jose.compactVerify` runs with `algorithms: ['EdDSA']`.

## Browser and server tokens

`issueToken({ signer, issuer, websiteId, domain, productId, kind })` signs exactly
`{ iss, jti, websiteId, domain, productId, kind, iat }`: no expiry, environment, scopes or address. `domain` is
normalized by the one domain rule of `@ss/contracts` (`normalizeDomain`: lower-case punycode; IP literals, wildcards,
`localhost` and single-label names refused), and must already be a bare host name (a scheme, port, path or userinfo is
refused, never stripped).

`verifyToken({ token, keyResolver, issuer, productId, kind?, isRevoked? })` checks the signature against the pinned
Portal keys, `typ`, issuer, product, kind and the revocation list. Every failure throws `invalid_token` with the same
message, so callers cannot tell a forged token from a revoked one or one for another product.

Origins:

- `canonicalOrigin(value)` → `scheme://host[:port]` (lower-case, default port dropped) or `null` (userinfo, any path,
  whitespace, control characters and backslashes refused).
- `isLocalOrigin(origin)`: `http(s)://localhost`, `*.localhost`, `127.0.0.1` or `[::1]` on any port.
- `originAllowed({ origin, domain })` (browser tokens): only `https://<exact domain>` on the default port, or a local
  origin. No subdomains, no Referer fallback; a missing Origin is refused.
- `ticketOriginAllowed(origin)` (tickets): any `https://` origin, or a local origin.

## Tickets

`issueTicket({ signer, productId, websiteId, user: { id, name, email }, origin, permissions, tokenId })` →
`{ ticket, expiresAt, claims }` with claims `{ iss: productId, aud: productId, sub: user.id, websiteId, user, origin,
permissions, tid: tokenId, iat, nbf, exp: iat + 900, jti }`. `tid` is the `jti` of the server token the ticket was
made with. `verifyTicket({ ticket, keyResolver, productId, origin, isRevoked? })` checks signature, `typ`, audience,
time, that the request Origin equals the ticket's origin, and that `tid` is not revoked; every failure is
`invalid_token`.

## Launches

`issueLaunch({ signer, issuer, audience, kind, sessionExpiresAt, branding, support, merchant? | admin?, ttlSeconds? })`.
A merchant launch carries `merchant: { id, name, websites: [{ websiteId, domain }], websiteId }` (the website to open
must be in the list); an admin launch carries `admin: { id, name, role: 'owner' | 'support', websiteId | null }`. Never
both. `support` is `{ channels: [{ type: 'email' | 'phone' | 'link', label, url }] }` (at most 10; `mailto:`, `tel:+…`
or an https link, checked by `@ss/contracts/text`). `sub` is the merchant or admin id. `verifyLaunch({ token, keyResolver, audience, issuer, consume })` checks
signature, issuer, audience, time, the launch rules (`invalid_launch`), that `sessionExpiresAt` has not passed, and
consumes the `jti` once.

## Notices

Portal → product at `POST <base>/.well-known/ss-events`, with `SS-Timestamp`, `SS-Signature`
(`v1;kid=<kid>;sig=<base64url>`, up to four entries for dual-signing) and the hint `SS-Key-Id`. The signed message is
`ss-notice.v1`, the timestamp, the product id the notice is for and `<hex sha256(raw body)>`, joined by newlines, so a
notice for one product is refused by another. `verifyNotice` checks the timestamp (± 300 s), the signature, the
replay store, then the body: `status.changed`, `token.revoked` and `website.deleted` need `websiteId`;
`sessions.revoked` needs `subject`; nothing else is allowed. It returns the checked body.

## Portal calls

Requests the Portal itself makes to a product for one website (the Setup sheet reads each product's
`GET /v1/blueprint?websiteId=`). `signPortalCall({ signer | signers, audience, method, target, body?, timestamp })`
returns `SS-Timestamp`, `SS-Nonce` (16 random bytes, base64url), `SS-Signature` (as notices, up to four entries) and the
hint `SS-Key-Id`. The signed message is the lines `ss-call.v1`, the timestamp, the nonce, the product id (`audience`),
the method, the target (path and query exactly as sent) and the hex SHA-256 of the raw body, joined by `\n`.
`verifyPortalCall({ headers, audience, method, target, rawBody?, keyResolver, replayStore })` checks the timestamp
(± 300 s), the signature over the request's own method, target and body against the pinned Portal keys, then the
nonce against the replay store, and returns `{ kid, timestamp }`. A call for one product is refused by every other
product, and a notice signature never verifies as a call.

## Connect handshake

1. Portal: `createConnectRequest({ secret, productUrl, portalUrl, jwks, priceListVersion })` → `POST
   <base>/.well-known/ss-connect` with body `{ portalUrl, jwks, baseUrl, nonce, priceListVersion }` and an HMAC of
   `CONNECT_SECRET` over timestamp and body (the secret is never sent).
2. Product: `verifyConnectRequest` (HMAC in constant time, ± 5 min), check the nonce against a replay store, pin
   `portalUrl` and the Portal keys, keep `baseUrl` as its own address, then
   `createConnectResponse({ secret, productId, nonce, publicJwk, manifest, prices })` (HMAC under a second label).
3. Portal: `verifyConnectResponse({ secret, headers, body, nonce })` → `{ productId, publicJwk, manifest, prices }`.
   The caller checks `manifest` and `prices` with `@ss/contracts`.

## Keys, JWKS and rotation

- `createKeyResolver({ jwks | fetchJwks, cacheTtlMs, minRefreshIntervalMs, maxStaleMs })` caches a JWKS, refetches on
  an unknown `kid` (at most once per `minRefreshIntervalMs`) and keeps the last-known keys for `maxStaleMs` when a
  refetch fails.
- JWK members may carry `nbf`/`exp` (seconds) for rotation overlap windows: publish the new key ahead of time, keep the
  old one until the overlap ends; each is refused outside its window.
- `signingKeyFromSeed(kid, seed)` rebuilds a private key from its 32-byte seed, the form in which the Portal keeps its
  signing keys (sealed).

## Replay stores

A deployable uses a store shared by every instance (serverless functions share no memory) with an atomic
insert-if-absent and a TTL, for example a MongoDB collection with a unique `_id` and a TTL index on `expiresAt`. Tests
import `@ss/protocol/testing`: `createMemoryReplayStore` (in memory, one process) and `consumeWith(store)`, which adapts
a store to the `consume(jti, expiresAtMs)` shape of `verifyLaunch`.
