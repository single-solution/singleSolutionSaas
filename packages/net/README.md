# @ss/net

The server-side networking and runtime shared by the Portal and products. It provides SSRF policy and IP address
classification, DNS-pinned guarded lookups, a guarded HTTP(S) client, MongoDB connection strings and client rules, AWS
SigV4 signing, the structured logger with redaction and the static security headers.

- Node only (`node:http`, `node:https`, `node:dns`, `node:crypto`). No dependencies (not even the MongoDB driver).
  JavaScript ESM, functional, JSDoc-typed.
- Every outbound call to a merchant- or developer-supplied destination (connect, event
  deliveries, connector checks, object stores, client databases) must go through this package.

## Threat model

An attacker controls a URL, host name or DNS answer and wants the server to reach something internal: cloud
metadata (`169.254.169.254`, `fd00:ec2::254`), loopback services, the private network, or another tenant. The guard
works in two steps:

1. **Before resolution** (`checkUrl` / `checkHost`, pure). The URL must use https, carry no userinfo, use an allowed
   port, and name either a public IP literal or a plausible public DNS name.
2. **At connect time** (`guardedLookup`). The host is resolved once, and **every** answer is classified. One refused
   answer refuses the whole name. The socket receives exactly the vetted answers, so no second lookup happens between
   the check and the connection. A rebinding DNS server that answers "public" once and "private" next time is
   therefore checked on each connection's own answer.

Node skips `lookup` for IP literals, which is why step 1 also checks literals. `safeFetch` and `isSafeMongoUri` run
both steps.

## API

```js
import {
	createOutboundPolicy,
	checkUrl,
	checkHost,
	guardedLookup,
	resolveVetted,
	safeFetch,
	textOf,
	jsonOf,
	isSafeMongoUri,
	mongoDatabaseName,
	DATABASE_DEADLINES,
	databaseClientOptions,
	connectBeforeUse,
	isDatabaseUnavailable,
	createLogger,
	noopLogger,
	redact,
	staticSecurityHeaders,
	signV4,
	presignV4,
	objectUrl,
	isNetError,
	netError,
} from '@ss/net';
```

`isNetError(error, code?)` tells a `NetError` (`{ code, reason, detail? }`) apart; `netError(code, reason, message,
detail?)` makes one, for test doubles that fail the way `safeFetch` does.

### Address categories

Every IP address (a literal in a URL, every DNS answer) is classified; only `public` addresses are reached.

| `category`      | Ranges                                                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `public`        | everything else (IPv6: only inside `2000::/3`)                                                                             |
| `private`       | 10/8, 172.16/12, 192.168/16, fc00::/7, fec0::/10                                                                           |
| `loopback`      | 127/8, ::1                                                                                                                 |
| `link_local`    | 169.254/16, fe80::/10                                                                                                      |
| `metadata`      | 169.254.169.254, 169.254.170.2, 169.254.170.23, fd00:ec2::254, fd00:ec2::23                                                |
| `cgnat`         | 100.64/10                                                                                                                  |
| `benchmark`     | 198.18/15, 2001:2::/48                                                                                                     |
| `documentation` | 192.0.2/24, 198.51.100/24, 203.0.113/24, 2001:db8::/32, 3fff::/20                                                          |
| `multicast`     | 224/4, ff00::/8                                                                                                            |
| `broadcast`     | 255.255.255.255                                                                                                            |
| `unspecified`   | 0/8, ::                                                                                                                    |
| `reserved`      | 192.0.0/24, 192.88.99/24, 240/4, 100::/64, 2001::/23, 5f00::/16, outside 2000::/3, 6to4, Teredo, 64:ff9b:1::/48, ::a.b.c.d |
| `invalid`       | not an IP address (fail closed)                                                                                            |

IPv4-mapped (`::ffff:a.b.c.d`) and NAT64 (`64:ff9b::a.b.c.d`) addresses take the category of the IPv4 address they embed
(`via` and `embedded` record this). 6to4, Teredo, local-use NAT64 and IPv4-compatible addresses are always `reserved`.
The numeric IPv4 spellings that `inet_aton` accepts (`2130706433`, `0x7f.1`, `0177.0.0.1`, `127.1`) are decoded and
classified, with `canonical: false`.

### `createOutboundPolicy(options) → OutboundPolicy` (frozen)

| Option       | Default            | Meaning                                                                        |
| ------------ | ------------------ | ------------------------------------------------------------------------------ |
| `allowHosts` | `[]`               | exact host names / IP literals admitted despite the rules (development only)   |
| `resolve`    | `dns.lookup` (all) | `(host, { family? }) => Promise<Array<{ address, family }>>` — inject in tests |
| `userAgent`  | `ss-net/1`         | default `user-agent`                                                           |

Hosts not on the allowlist need https on port 443 or 8443. Allowlisted hosts skip the port and address rules and may
use http. An allowlisted IP literal also admits that address as a DNS answer for another name. Only enable the
allowlist in development and test environments.

### `checkUrl(url, policy)` / `checkHost(host, policy)`

These checks are pure and run before DNS. They return `{ ok: true, url?, host, port?, ip, allowlisted }` or
`{ ok: false, code: 'bad_url' | 'ssrf_blocked', reason }`. Reasons: `invalid_url`, `url_too_long`, `unsupported_scheme`, `userinfo`,
`invalid_host`, `https_required`, `port`, `internal_name` (`localhost`, `.localhost`, `.local`, `.internal`,
`.home.arpa`, `.localdomain`, `.lan`, `.intranet`, `.corp`), `single_label`, `ip_spelling` (non-canonical numeric
host), `<category>_address`.

### `guardedLookup(policy) → lookup`

This returns a `dns.lookup`-compatible function to pass as `lookup` to `http.request`, `https.request`, `net.connect`,
`tls.connect` or `new MongoClient(uri, { lookup })`. A refusal calls back with a `NetError` (`ssrf_blocked`). A DNS
failure calls back with a `NetError` (`network`, `reason: 'dns_failed'`, `detail` set to the DNS code).
`resolveVetted(policy, host, { family? })` is the promise form.

### `safeFetch(url, init?, policy?) → Promise<{ status, headers, body, url }>`

- `init`: `{ method = 'GET', headers, body (string | Uint8Array), signal, redirect = 'follow' | 'manual' | 'error', timeoutMs = 10000, maxBytes = 1048576 }`
  (`timeoutMs` covers every hop, redirects included).
- `headers` are lower-case with repeated values joined by `, `, `body` is a `Buffer`, and `url` is the final URL.
  `textOf(res)` and `jsonOf(res)` decode the body.
- Redirects (301/302/303/307/308) are followed only for GET and HEAD, at most 3 times, and only to the same scheme,
  host and port, so credentials never leave the origin. Every hop is checked again.
- No connection reuse (`agent: false`). The size cap applies to both the declared `content-length` and the streamed
  bytes.
- Throws a `NetError` with a `code`:

| `code`             | When                                                                      |
| ------------------ | ------------------------------------------------------------------------- |
| `bad_url`          | unparseable URL, non-http(s) scheme, userinfo, invalid host or method     |
| `ssrf_blocked`     | policy refusal before or after DNS (`reason` says which)                  |
| `timeout`          | the overall deadline passed                                               |
| `too_large`        | the body exceeds `maxBytes`                                               |
| `redirect_refused` | redirect not allowed (mode, method, cross-origin, too many, bad location) |
| `aborted`          | `init.signal` aborted                                                     |
| `network`          | DNS, connection or TLS failure (`detail` = system code)                   |

### `isSafeMongoUri(uri, policy)`

This returns `{ ok: true, value: ParsedMongoUri, tls, allowlisted }` or
`{ ok: false, code: 'bad_url' | 'ssrf_blocked' | 'unsafe_option' | 'tls_required', reason }`. It accepts only
`mongodb://` and `mongodb+srv://`. Every host must pass `checkHost`, and only a list of safe URI options is
allowed. That refuses local file reads (`tlsCAFile`, …), TLS weakening, proxies and ambient cloud
credentials, and only SCRAM is accepted as an auth mechanism. TLS is required unless every host is allowlisted. Also
connect with `{ lookup: guardedLookup(policy) }`, so that SRV answers and discovered replica-set members are vetted
too. Credential rules (user/password required, database name) stay with the caller.

`mongoDatabaseName(uri)` is the database the string names (its path, decoded, as the driver's `client.db()` takes
it): `null` when it names none, `''` when its escapes are malformed.

### Database clients (no driver inside: callers pass their client)

- `DATABASE_DEADLINES`: finding a server and opening a connection 5 s, waiting for a pooled connection 10 s, each send
  or receive 10 s, so a database that cannot be reached fails fast in a serverless function.
- `databaseClientOptions({ maxPoolSize = 5, appName? })`: the options of `new MongoClient(uri, options)`, a small pool
  (`minPoolSize: 0`, `maxIdleTimeMS: 60000`) with the deadlines. Add driver options (`lookup`) to the copy.
- `connectBeforeUse(client) → () => Promise<void>`: connects once, shares one attempt between concurrent calls and
  forgets a failed one, so the next request after an outage connects again on the same warm instance.
- `isDatabaseUnavailable(error)`: true for a driver network error or deadline, a failed DNS lookup of the database or
  an operation over its `maxTimeMS` (requests answer 503).

### `createLogger({ level = 'info', write?, now?, fields? }) → Logger`

JSON lines to standard output (or to `write`), with `debug`, `info`, `warn`, `error` and `child(fields)`; an unknown
level is `info`. `noopLogger` writes nothing. Every record goes through `redact(value)`: members whose name (lower case,
`_` and `-` removed) contains `secret`, `token`, `password`, `passwd`, `passphrase`, `authorization`, `cookie`,
`apikey`, `accesskey`, `privatekey`, `privatejwk`, `signingkey`, `credential`, `connectionstring`, `descriptor`, `kek`,
`pepper` or `sealed`, ends in `uri` or equals `d` become `[redacted]`; signed tokens (`eyJ….….…`) and the user part of
addresses are redacted inside every text, error messages too; errors become `{ name, message, code? }`, dates ISO
texts and big integers decimal texts (a log call never throws).

### `staticSecurityHeaders() → Array<{ key, value }>`

The static headers of every page, as `next.config.js` `headers()` takes them (a fresh copy each call):
`Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`,
`Permissions-Policy` (no powerful features), `Cross-Origin-Opener-Policy: same-origin`, `X-DNS-Prefetch-Control: off`
and `X-Permitted-Cross-Domain-Policies: none`. Each side adds its own Content-Security-Policy.

### `clientIpOf(headers) → string | null`

The caller's IP address as the hosting layer saw it, for per-visitor limits and stored answers: `X-Real-IP` first (the
hosting platform sets it itself), else the LAST `X-Forwarded-For` hop (the one our own proxy appended; the first values
are whatever the caller wrote), else `null`. A value that is not an IP address is never used.

### `createLocalWindows({ maxEntries = 10000 }?) → { hit(key, windowMs, now) → { count, resetAt } }`

Fixed-window rate-limit counters in this instance's memory, the same windows the shared stores keep. The Portal and the
kit count with them while their shared limit store fails, so a limit never switches off with the store (it only becomes
per instance). At most `maxEntries` counters are kept: expired ones go first, then the least recently hit.

### `signV4(params) → headers` / `presignV4(params) → url`

```js
signV4({ method, url, headers, body, region, service = 's3', accessKeyId, secretAccessKey, sessionToken, now,
	payloadHash /* optional, e.g. 'UNSIGNED-PAYLOAD' */, contentSha256Header = true });
presignV4({ method, url, region, service = 's3', accessKeyId, secretAccessKey, sessionToken, now, expiresIn /* 1..604800 */,
	headers /* signed, sent verbatim by the client */, query /* extra params */ });
```

- `signV4` returns every signed header except `host`, plus `authorization`, `x-amz-date`, `x-amz-content-sha256` and
  `x-amz-security-token` when present.
- The canonical URI is the URL path **as given**, which follows S3 semantics. Encode object keys once with
  `objectUrl(store, key)`.
- Query parameters are RFC 3986 encoded and sorted by name, then value.
- The output is checked against the AWS documentation vectors: S3 GET/PUT object, GET lifecycle, list objects,
  presigned GET, and the SigV4 suite `get-vanilla` and `get-vanilla-query-order-key-case`.
