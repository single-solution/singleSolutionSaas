# @ss/net

Safe outbound networking shared by the Portal and products. It provides SSRF policy and IP address classification,
DNS-pinned guarded lookups, a guarded HTTP(S) client, MongoDB connection-string safety and AWS SigV4 signing.

- Node only (`node:http`, `node:https`, `node:dns`, `node:crypto`). No dependencies. JavaScript ESM, functional, JSDoc-typed.
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
	classifyAddress,
	isBlockedAddress,
	createOutboundPolicy,
	checkUrl,
	checkHost,
	isAllowlisted,
	guardedLookup,
	resolveVetted,
	safeFetch,
	textOf,
	jsonOf,
	isSafeMongoUri,
	parseMongoUri,
	signV4,
	presignV4,
	uriEncode,
	objectUrl,
	isNetError,
} from '@ss/net';
```

### `classifyAddress(ip) → AddressClass`

```js
{ category, blocked, family: 4 | 6 | null, address /* canonical */, canonical, range, via?, embedded? }
```

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

| Option                  | Default            | Meaning                                                                        |
| ----------------------- | ------------------ | ------------------------------------------------------------------------------ |
| `allowHosts`            | `[]`               | exact host names / IP literals admitted despite the rules (development only)   |
| `allowHttpForAllowed`   | `true`             | allowlisted hosts may use plain `http:`                                        |
| `ports`                 | `[443, 8443]`      | ports allowed for non-allowlisted hosts (implicit 443 for https)               |
| `maxRedirects`          | `3`                | redirects `safeFetch` follows                                                  |
| `sameHostRedirectsOnly` | `true`             | only follow redirects to the same origin                                       |
| `timeoutMs`             | `10000`            | overall deadline of one `safeFetch` call, redirects included                   |
| `maxBytes`              | `1048576`          | response body cap                                                              |
| `resolve`               | `dns.lookup` (all) | `(host, { family? }) => Promise<Array<{ address, family }>>` — inject in tests |
| `userAgent`             | `ss-net/1`         | default `user-agent`                                                           |

Allowlisted hosts skip the port and address rules, and may use http when `allowHttpForAllowed` is set. An
allowlisted IP literal also admits that address as a DNS answer for another name. Only enable the allowlist in
development and test environments.

### `checkUrl(url, policy)` / `checkHost(host, policy)`

These checks are pure and run before DNS. They return `{ ok: true, url?, host, port?, ip, allowlisted }` or
`{ ok: false, code: 'bad_url' | 'ssrf_blocked', reason }`. Reasons: `invalid_url`, `url_too_long`, `unsupported_scheme`, `userinfo`,
`invalid_host`, `https_required`, `port`, `internal_name` (`localhost`, `.localhost`, `.local`, `.internal`,
`.home.arpa`, `.localdomain`, `.lan`, `.intranet`, `.corp`), `single_label`, `ip_spelling` (non-canonical numeric
host), `<category>_address`.

### `guardedLookup(policy, { onRefused? }) → lookup`

This returns a `dns.lookup`-compatible function to pass as `lookup` to `http.request`, `https.request`, `net.connect`,
`tls.connect` or `new MongoClient(uri, { lookup })`. A refusal calls back with a `NetError` (`ssrf_blocked`). A DNS
failure calls back with a `NetError` (`network`, `reason: 'dns_failed'`, `detail` set to the DNS code).
`resolveVetted(policy, host, { family? })` is the promise form.

### `safeFetch(url, init?, policy?) → Promise<{ status, headers, body, url }>`

- `init`: `{ method = 'GET', headers, body (string | Uint8Array), signal, redirect = 'follow' | 'manual' | 'error', timeoutMs, maxBytes }`.
- `headers` are lower-case with repeated values joined by `, `, `body` is a `Buffer`, and `url` is the final URL.
  `textOf(res)` and `jsonOf(res)` decode the body.
- Redirects (301/302/303/307/308) are followed only for GET and HEAD, at most `maxRedirects` times, and only to the
  same origin unless `sameHostRedirectsOnly: false`. Every hop is checked again. `authorization`, `cookie` and
  `proxy-authorization` are dropped when the origin changes.
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
`mongodb://` and `mongodb+srv://`. Every host must pass `checkHost`, and only safe URI options are allowed
(`SAFE_MONGO_OPTIONS`). That refuses local file reads (`tlsCAFile`, …), TLS weakening, proxies and ambient cloud
credentials, and only SCRAM is accepted as an auth mechanism. TLS is required unless every host is allowlisted. Also
connect with `{ lookup: guardedLookup(policy) }`, so that SRV answers and discovered replica-set members are vetted
too. Credential rules (user/password required, database name) stay with the caller.

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
  `uriEncode(key, true)` or `objectUrl(store, key)`.
- Query parameters are RFC 3986 encoded and sorted by name, then value.
- The output is checked against the AWS documentation vectors: S3 GET/PUT object, GET lifecycle, list objects,
  presigned GET, and the SigV4 suite `get-vanilla` and `get-vanilla-query-order-key-case`. It is byte-identical to the
  former `@ss/app-kit` and Portal connector implementations.
