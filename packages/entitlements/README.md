# @ss/entitlements

The pure maths behind the Portal's hourly charges. The Portal's charging code (`platform/src/modules/commerce`) builds
on these helpers; the money rules themselves (prices, charges, balance, grace) live in the Portal (PLAN.md 0.5).

- JavaScript ESM, functional, JSDoc-typed. No classes, no I/O, no clock: time is always a parameter.
- No runtime dependencies except `node:crypto` (SHA-256), so it runs on Node only.

## Money units (`units.js`)

Every amount is an **integer number of millicredits**: 1 credit = 1000 millicredits.

| Export                              | What it does                                                                                                                                                           |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MILLICREDITS_PER_CREDIT`           | `1000`.                                                                                                                                                                |
| `toMillicredits(credits)`           | A decimal credit amount (up to 3 decimals, for example a price of `0.125`) → integer millicredits. Throws `RangeError` for negative, non-finite or too precise values. |
| `toCredits(millicredits)`           | Millicredits → decimal credits, for display only.                                                                                                                      |
| `isMillicredits(value)`             | True for a non-negative safe integer.                                                                                                                                  |
| `assertMillicredits(value, label?)` | Returns `value`, or throws `RangeError` naming `label` (default `amount`).                                                                                             |

## UTC hours (`time.js`)

Charges are counted per UTC clock hour. Instants are integer milliseconds since the Unix epoch.

| Export                  | What it does                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------- |
| `HOUR_MS`               | `3_600_000`.                                                                                |
| `toMs(instant, label?)` | A number, ISO-8601 string or `Date` → epoch milliseconds. Throws `RangeError` when invalid. |
| `floorHour(ms)`         | Start of the UTC hour containing `ms`.                                                      |
| `ceilHour(ms)`          | Start of the first UTC hour at or after `ms`.                                               |
| `isoHour(ms)`           | `YYYY-MM-DDTHH:00:00Z` for an hour start.                                                   |
| `isoInstant(ms)`        | ISO-8601 UTC, without milliseconds when they are zero (`2026-10-01T10:00:00Z`).             |

## Ledger hash (`hash.js`)

The Portal chains its ledger entries by hashing each entry's canonical JSON.

| Export                   | What it does                                                                                        |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| `stableStringify(value)` | JSON with object keys sorted recursively; arrays keep their order; `undefined` members are dropped. |
| `sha256Hex(text)`        | Hex SHA-256 of a UTF-8 string.                                                                      |
| `deepEqual(a, b)`        | Structural equality through `stableStringify`.                                                      |

## Checks

`pnpm check` runs format, lint, typecheck and the tests (coverage 90 % lines, 90 % functions, 85 % branches).
