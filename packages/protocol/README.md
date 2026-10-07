# @ss/protocol

Signing and verification shared by the Portal and every product (PLAN.md Part 0: 0.4.3 launches, 0.4.4 tokens, 0.4.5
tickets, 0.4.12 Product ↔ Portal contract).

- JavaScript ESM, functional (no classes), JSDoc-typed, `tsc --checkJs --strict`.
- **EdDSA (Ed25519) only**. Every signature carries a `kid`; keys are published as JWKS.
- Time (`now`), randomness (`randomBytes`) and state (replay stores, `consume`, `isRevoked`) are passed in, so every
  rule can be tested deterministically.
- Every failure throws a `ProtocolError` with a stable `code` (`ERROR_CODES`). Messages never contain tokens, keys or
  secrets, so they are safe to log.
- No URLs, issuers or audiences are hard-coded: they are all parameters.

| Module            | Exports                                                                                                                                                                                                                                                                                            |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `keys.js`         | `generateSigningKey`, `signingKeyFromSeed`, `parseSigningKeys`, `formatSigningKey`, `createSigner`, `importPublicKey`, `importPrivateKey`, `exportPublicJwk`, `toPublicJwk`, `createJwks`, `createKeyResolver`, `thumbprint`                                                                       |
| `tokens.js`       | `issueToken`, `verifyToken`, `TOKEN_TYP`, `TOKEN_KINDS`, `normalizeDomain`, `canonicalOrigin`, `isLocalOrigin`, `originAllowed`, `ticketOriginAllowed`, `isProductId`, `PRODUCT_ID_PATTERN`                                                                                                        |
| `tickets.js`      | `issueTicket`, `verifyTicket`, `TICKET_TYP`, `TICKET_TTL_SECONDS`, `PERMISSION_KEY_PATTERN`                                                                                                                                                                                                        |
| `launch.js`       | `issueLaunch`, `verifyLaunch`, `launchViolation`, `LAUNCH_KINDS`, `LAUNCH_ADMIN_ROLES`, `LAUNCH_TYP`, `DEFAULT_LAUNCH_TTL_SECONDS`, `MAX_LAUNCH_TTL_SECONDS`                                                                                                                                       |
| `assertion.js`    | `signAssertion`, `verifyAssertion`, `ASSERTION_TYP`, `MAX_ASSERTION_LIFETIME_SECONDS`                                                                                                                                                                                                              |
| `notices.js`      | `signNotice`, `verifyNotice`, `NOTICE_PATH`, `NOTICE_TYPES`, `NOTICE_HEADERS`, `NOTICE_TOLERANCE_SECONDS`                                                                                                                                                                                          |
| `registration.js` | connect handshake: `createConnectRequest` / `verifyConnectResponse` (Portal), `verifyConnectRequest` / `createConnectResponse` (product), `generateConnectSecret`, `isConnectSecret`, `canonicalUrl`, `CONNECT_PATH`, `CONNECT_*_HEADER`, `CONNECT_TOLERANCE_SECONDS`, `MIN_CONNECT_SECRET_LENGTH` |
| `replay.js`       | `createMemoryReplayStore` (tests only), `consumeWith`                                                                                                                                                                                                                                              |
| `errors.js`       | `createProtocolError`, `isProtocolError`, `ERROR_CODES`                                                                                                                                                                                                                                            |
| `encoding.js`     | `canonicalJson`                                                                                                                                                                                                                                                                                    |

## What is signed

Every signed object has its own JOSE `typ`, and each verifier accepts only its own, so one kind can never be replayed
as another (a ticket as a token, a launch as an assertion, …).

| Object           | Signed by         | `typ` / label            | Lifetime                    | Replay protection                    |
| ---------------- | ----------------- | ------------------------ | --------------------------- | ------------------------------------ |
| Browser token    | Portal            | `ss-token+jws`           | no expiry; revoked by `jti` | n/a (bearer credential)              |
| Server token     | Portal            | `ss-token+jws`           | no expiry; revoked by `jti` | n/a (bearer credential)              |
| Ticket           | product (own key) | `ss-ticket+jws`          | exactly 15 min              | bound to origin; ends with its `tid` |
| Launch           | Portal            | `ss-launch+jwt`          | 60 s default, ≤ 300 s       | `consume(jti)`: single use           |
| Client assertion | product (its key) | `ss-assertion+jwt`       | ≤ 300 s                     | replay store on `iss\|jti`           |
| Notice           | Portal            | detached, `ss-notice.v1` | `SS-Timestamp` ± 300 s      | replay store on `timestamp\|sha256`  |
| Connect request  | HMAC              | `ss-connect.v1`          | timestamp ± 5 min           | nonce record (product)               |
| Connect answer   | HMAC              | `ss-connected.v1`        | timestamp ± 5 min           | echoes the Portal's request nonce    |

Common JWS rules (`jws.js`): the header must be `alg: EdDSA` with a `kid` and the expected `typ`; `jwk`, `jku`, `x5u`,
`x5c`, `x5t`, `crit`, `b64`, `zip` are refused, so a token can never tell the verifier where to find its key; the
length is capped before parsing; `jose.compactVerify` runs with `algorithms: ['EdDSA']`.

## Browser and server tokens

`issueToken({ signer, issuer, websiteId, domain, productId, kind })` signs exactly
`{ iss, jti, websiteId, domain, productId, kind, iat }`: no expiry, environment, scopes or address. `domain` is
normalised with `normalizeDomain` (lower-case punycode; scheme, port, path, wildcards, IP literals, `localhost` and
single-label names refused).

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
both. `sub` is the merchant or admin id. `verifyLaunch({ token, keyResolver, audience, issuer, consume })` checks
signature, issuer, audience, time, the launch rules (`invalid_launch`), that `sessionExpiresAt` has not passed, and
consumes the `jti` once.

## Notices

Portal → product at `POST <base>/.well-known/ss-events`, with `SS-Timestamp`, `SS-Signature`
(`v1;kid=<kid>;sig=<base64url>`, up to four entries for dual-signing) and the hint `SS-Key-Id`. The signed message is
`ss-notice.v1.<timestamp>.<hex sha256(raw body)>`. `verifyNotice` checks the timestamp (± 300 s), the signature, the
replay store, then the body: `status.changed`, `token.revoked` and `website.deleted` need `websiteId`;
`sessions.revoked` needs `subject`; nothing else is allowed. It returns the checked body.

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

- `createKeyResolver({ jwks | fetchJwks, cacheTtlMs, minRefreshIntervalMs, maxStaleMs, revokedKids, isRevoked })`
  caches a JWKS, refetches on an unknown `kid` (at most once per `minRefreshIntervalMs`), keeps the last-known keys for
  `maxStaleMs` when a refetch fails, and refuses revoked kids at once.
- JWK members may carry `nbf`/`exp` (seconds) for rotation overlap windows: publish the new key ahead of time, keep the
  old one until the overlap ends; each is refused outside its window.
- `signingKeyFromSeed` / `parseSigningKeys` read keys in their environment form `kid:seed[,kid:seed…]`.

## Replay stores

`createMemoryReplayStore` is for tests only. In production use a store shared by every instance (serverless functions
share no memory) with an atomic insert-if-absent and a TTL, for example a MongoDB collection with a unique `_id` and a
TTL index on `expiresAt`. `consumeWith(store)` adapts it to the `consume(jti, expiresAtMs)` shape of `verifyLaunch`.
