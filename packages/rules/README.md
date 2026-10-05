# @ss/rules — `rules@1`

The one expression language every product uses for conditions, eligibility, formulas, segments and triggers
(PLAN Part D §0 L4, Part E §6). It is **safe** (no side effects, no host access, no `eval`), **pure** (the result
depends only on the program, the context and `now`), **time-boxed** (a deterministic step budget) and **versioned**
(programs are plain JSON `{ v: 1, ast }`).

This document is the normative reference for version 1. Behaviour not described here is a bug.

```js
import { compile, evaluate, evaluateCondition, check, explain } from '@ss/rules';

const r = compile("order.total >= 5000 and not inSegment('wholesale') and daysSince(customer.firstOrderAt) < 30");
if (!r.ok) throw new Error(`${r.error.message} at ${r.error.line}:${r.error.column}`);
const res = evaluateCondition(r.program, { order, customer, segments }, { now: new Date(), timeZone: 'Asia/Karachi' });
const matched = res.ok && res.value; // an error never matches
```

---

## 1. API

All functions are pure and **never throw**; failures are returned as `{ ok: false, error }` where
`error = { code, message, line?, column?, offset? }` (positions are 1-based; compile errors only).

| Function                                                                                                 | Returns                                                                                            |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `compile(source, { version?: 1, maxLength?, maxDepth?, maxNodes? })`                                     | `{ ok: true, program }` \| `{ ok: false, error }`                                                  |
| `evaluate(program, context?, { maxSteps?, now?, timeZone?, maxListLength?, maxStringLength? })`          | `{ ok: true, value }` \| `{ ok: false, error }`                                                    |
| `evaluateCondition(program, context?, options?)`                                                         | as `evaluate`, with `value` = `truthy(result)`                                                     |
| `explain(program, context?, options?)`                                                                   | `evaluate`'s result plus `trace` (tree of `{ node, expr, value, children, skipped? }`) and `steps` |
| `check(source, { ...compileOptions, roots?: string[] })`                                                 | `{ ok, errors[], warnings[], paths[], functions[] }` for editors                                   |
| `referencedPaths(program)`                                                                               | sorted context paths the program reads                                                             |
| `functionsUsed(program)`                                                                                 | sorted function names                                                                              |
| `format(program \| node)`                                                                                | canonical source text (the visual builder's code view)                                             |
| `serialize(program)` / `deserialize(jsonOrObject, limits?)`                                              | JSON text / fully re-validated, frozen program                                                     |
| `validateProgram(value, limits?)`                                                                        | same as `deserialize` for an already-parsed object                                                 |
| `truthy(value)`, `DEFAULT_LIMITS`, `FUNCTIONS` (metadata list), `LANGUAGE_VERSION`, `MAX_PATTERN_LENGTH` |                                                                                                    |

- A **program** is `{ v: 1, ast }`, deep-frozen, JSON-serialisable, with no source positions.
  `compile(format(p)).program` deep-equals `p`, and `deserialize(serialize(p))` evaluates identically.
- `evaluate` accepts programs from `compile`/`deserialize` directly; any other object is validated first (and the
  validated copy cached), so a hand-edited or tampered AST can never reach the evaluator unchecked.
- `now` is `options.now`, else `context.now`, else the real clock — read once per evaluation. Pass `now` for
  deterministic results (tests, replays, previews).
- `timeZone` (default `'UTC'`) is the zone used by `dateParts`/`between` when no zone argument is given.
  Use the website's configured zone. An unknown zone in options is an `invalid_option` error.
- `check` warnings: with `roots` (e.g. `['order','customer','event']`), identifiers outside that set produce
  `unknown_identifier` warnings with positions. `paths` uses `[]` for list items: `any(order.lines, it.sku == 'x')`
  reports `order.lines` and `order.lines[].sku`; `sum(order.lines, 'qty')` reports `order.lines[].qty`.
- `explain` frames carry the canonical text of each sub-expression and its value. Static paths are one frame.
  Operands skipped by short-circuiting appear with `skipped: true`. At most 2000 frames are recorded.

## 2. Lexical structure

- **Whitespace**: space, tab, CR, LF. **Comments**: `#` to end of line.
- **Numbers**: decimal `0`, `42`, `3.5`, optional exponent `1e3`, `2.5E-4`. No leading `.`, no hex, no `_`.
  Out-of-range literals (`1e999`) are errors. A leading `-` is the unary operator (folded into the literal).
- **Strings**: `'…'` or `"…"`, single line. Escapes: `\n \t \r \\ \' \" \uXXXX \u{X…}`; any other escape is an error.
- **Durations**: a number immediately followed by a unit, optionally compound: `7d`, `12h`, `30m`, `45s`, `250ms`,
  `2w`, `1h30m`, `1.5h`. Units: `w d h m s ms` (`m` is minutes; there are no months/years — use dates).
  A duration **is a number of milliseconds** at runtime (`1h == 3600000` is true).
- **Dates**: `@YYYY-MM-DD` (UTC midnight) or `@YYYY-MM-DDTHH:MM[:SS[.fff]][Z|±HH:MM]` (no zone = UTC).
  Calendar-validated (`@2026-02-30` is an error). A date is an instant (a JS `Date` at runtime).
- **Identifiers**: `[A-Za-z_][A-Za-z0-9_]*`, case-sensitive. **Keywords** (lower-case only):
  `and or not in contains true false null`. `it` is reserved for predicates; `now` is built in.
- **Operators/punctuation**: `== != < <= > >= + - * / % ( ) [ ] , . ? :`. `&&`, `||`, `!`, `=` are rejected with a hint.

## 3. Grammar (EBNF) and precedence

```
expr       = ternary ;
ternary    = or [ "?" expr ":" expr ] ;                  (* right-associative *)
or         = and { "or" and } ;                           (* n-ary, left to right, short-circuit *)
and        = not { "and" not } ;
not        = "not" not | comparison ;
comparison = additive [ cmpop additive ] ;                (* non-associative: a < b < c is an error *)
cmpop      = "==" | "!=" | "<" | "<=" | ">" | ">=" | "in" | "not" "in" | "contains" ;
additive   = multiplicative { ("+" | "-") multiplicative } ;   (* left-assoc *)
multiplicative = unary { ("*" | "/" | "%") unary } ;      (* left-assoc *)
unary      = "-" unary | postfix ;
postfix    = primary { "." name | "[" expr "]" } ;        (* name may be a keyword: event.data.in *)
primary    = number | string | duration | date | "true" | "false" | "null"
           | list | identifier | call | "(" expr ")" ;
list       = "[" [ expr { "," expr } [ "," ] ] "]" ;
call       = function-name "(" [ expr { "," expr } ] ")" ;  (* only the built-in library *)
```

| Precedence (low → high) | Operators                            | Associativity |
| ----------------------- | ------------------------------------ | ------------- |
| 1                       | `c ? a : b`                          | right         |
| 2                       | `or`                                 | left (n-ary)  |
| 3                       | `and`                                | left (n-ary)  |
| 4                       | `not`                                | prefix        |
| 5                       | `== != < <= > >= in not in contains` | none          |
| 6                       | `+ -`                                | left          |
| 7                       | `* / %`                              | left          |
| 8                       | unary `-`                            | prefix        |
| 9                       | `.name` `[index]` `f(…)`             | left          |

So `not a == b` is `not (a == b)`; `a or b and c` is `a or (b and c)`; `-x.y` is `-(x.y)`;
`a ? b : c ? d : e` is `a ? b : (c ? d : e)`.

## 4. Values

| Type    | Examples                          | Notes                                                                                     |
| ------- | --------------------------------- | ----------------------------------------------------------------------------------------- |
| null    | `null`, any missing path          | also: undefined, functions, NaN, ±Infinity, invalid dates in the context                  |
| boolean | `true`                            |                                                                                           |
| number  | `12.5`, `7d`                      | IEEE double; results that are not finite become `null`; `-0` normalises to `0` in results |
| string  | `'abc'`                           |                                                                                           |
| list    | `[1, 2]`, `order.lines`           |                                                                                           |
| map     | `customer`, `dateParts(now)`      | plain objects from the context                                                            |
| date    | `@2026-10-01`, `now`, `date('…')` | instants; ISO strings/epoch ms are coerced where a date is expected                       |

**Context access** (`event.data.total`, `order.lines[0]`, `order.lines[-1]`, `item.attributes['fit-type']`):

- Only **own data properties** of plain objects/arrays are read. Getters are never invoked, the prototype chain is
  never consulted, and `__proto__`, `constructor`, `prototype` are unreadable (a compile error when literal).
- **Safe navigation**: any missing step, or stepping into a non-map, yields `null` — never an error.
- List indexes are integers; negative indexes count from the end. `.name` on a list/string yields `null` (use `len()`).
- Context data should be JSON-like plus `Date`. Class instances are read as maps of their own data properties
  (e.g. convert database ObjectIds to strings before evaluating).

**Truthiness** (used by `and`, `or`, `not`, `?:` and `evaluateCondition`): falsy = `null`, `false`, `0`, `''`, `[]`,
`{}`; everything else (including every date) is truthy. `and`/`or`/`not` always return booleans. Use `coalesce()`
for defaults.

## 5. Operator semantics and null truth table

**Equality** `==` / `!=` is structural (lists element-wise, maps by keys) with **no coercion** between numbers,
strings and booleans (`1 == '1'` is false). The one coercion: when either side is a date, the other side is read as a
date (ISO string or epoch ms), so `order.createdAt == @2026-10-01` works on ISO strings.

**Ordering** `< <= > >=` is defined for number/number, string/string (UTF-16 code-unit order) and date/date-like.
Anything else — including null on either side — is **false**.

**Membership**: `x in list` (structural equality), `sub in string` (substring, case-sensitive), `key in map`
(own key with a non-null value). `a contains b` ≡ `b in a`. `x not in y` ≡ `not (x in y)`. A non-collection on the
right (including null) contains nothing.

**Arithmetic**: `+ - * / %` on numbers. Division or remainder by zero → `null`. Non-finite results → `null`.
`+` also concatenates when either side is a string (numbers, booleans and dates — as ISO — are stringified) and
concatenates two lists. Date arithmetic: `date ± number(ms)` → date, `date - date` → number of ms (either side may
be an ISO string when the other is a date). Every other combination → `null`.

| Expression (`x` missing / null)               | Result                                |
| --------------------------------------------- | ------------------------------------- |
| `x == null`, `null == null`                   | `true`                                |
| `x != null`                                   | `false`                               |
| `x == 0`, `x == ''`, `x == false`             | `false`                               |
| `x != 0`                                      | `true`                                |
| `x < 1`, `x >= 1`, `x > null`, `null <= null` | `false`                               |
| `x + 1`, `x * 2`, `-x`, `x + 'a'`, `x - 7d`   | `null`                                |
| `1 / 0`, `5 % 0`                              | `null`                                |
| `x in [1, null]`                              | `true` (structural: null is a member) |
| `1 in x`, `'a' in x`                          | `false`                               |
| `1 not in x`                                  | `true`                                |
| `not x`                                       | `true`                                |
| `x and true`                                  | `false`                               |
| `x or true`                                   | `true`                                |
| `x ? 'a' : 'b'`                               | `'b'`                                 |
| `has(x)`                                      | `false`                               |
| `coalesce(x, 5)`                              | `5`                                   |

## 6. Function library

The library is fixed; unknown functions, wrong arity and invalid literal arguments are compile errors. Functions
never throw on bad data: they return `null` (or `false` for predicates) as noted.

| Function                                           | Semantics                                                                                                                                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `has(path)`                                        | `true` when the path exists and is not null. The argument must be a path (compile check).                                                                                             |
| `count(list)` / `count(list, pred)`                | number of items / of items where `pred` is truthy; non-list → `null`                                                                                                                  |
| `sum(list, 'field'?)`                              | sum of numeric items (or `item.field`, dotted paths allowed); non-numbers skipped; `[]` → `0`; non-list → `null`                                                                      |
| `avg(list, 'field'?)`                              | mean of numeric values; none → `null`                                                                                                                                                 |
| `min(list, 'field'?)`, `max(…)`, `min(a, b, …)`    | extreme of comparable values (numbers, strings, or dates); nulls ignored; mixed types or empty → `null`                                                                               |
| `round(x, digits = 0)`                             | half away from zero, decimal-correct (`round(1.005, 2) == 1.01`); digits integer −10…10                                                                                               |
| `floor(x)`, `ceil(x)`, `abs(x)`                    | numbers only, else `null`                                                                                                                                                             |
| `lower(s)`, `upper(s)`, `trim(s)`                  | strings only, else `null`; locale-independent                                                                                                                                         |
| `startsWith(s, p)`, `endsWith(s, p)`               | case-sensitive; non-strings → `false`                                                                                                                                                 |
| `like(s, pattern)`, `ilike(s, pattern)`            | whole-string **glob**: `*` any run, `?` one character, `\` escapes; `ilike` ignores case; non-strings → `false`                                                                       |
| `daysSince(d)`, `hoursSince(d)`, `minutesSince(d)` | whole units from `d` to `now`, truncated toward zero (negative in the future); `d` = date, ISO string or epoch ms; else `null`                                                        |
| `dateParts(d, tz?)`                                | `{ year, month, day, hour, minute, second, weekday, weekdayName }` of `d` in zone `tz` (default `options.timeZone`); `weekday` 1 = Monday … 7 = Sunday, `weekdayName` `'mon'`…`'sun'` |
| `between(t, 'HH:MM', 'HH:MM', tz?)`                | local time-of-day of `t` in `[start, end)`; if start > end the window crosses midnight (`'22:00'`–`'02:00'`); start == end is empty; `'24:00'` allowed as end                         |
| `between(x, low, high)`                            | inclusive range for numbers, strings or dates (when the bounds are not both `HH:MM`)                                                                                                  |
| `inSegment(name)`                                  | `true` when `context.segments` (list of strings) contains `name`                                                                                                                      |
| `any(list, pred)`, `all(list, pred)`               | with `it` bound to each item; `any([])` false, `all([])` true, non-list → `false` for both                                                                                            |
| `filter(list, pred)`, `map(list, expr)`            | new list (subject to `maxListLength`); non-list → `null`                                                                                                                              |
| `coalesce(a, b, …)`                                | first non-null argument; later arguments are not evaluated                                                                                                                            |
| `len(v)`                                           | characters (code points) of a string, items of a list, keys of a map; else `null`                                                                                                     |
| `date(x)`, `number(x)`, `string(x)`                | conversions: `date('2026-10-01')`, `number('12.50')` (decimal strings only), `string(12)`; failure → `null`                                                                           |

**Predicates and `it`.** The second argument of `any`, `all`, `filter`, `map` and `count` is evaluated per item with
`it` bound to that item. Nested predicates shadow: inside `any(order.lines, any(it.tags, it == 'sale'))` the inner
`it` is a tag. Using `it` anywhere else is a compile error.

**Time zones.** Zone arguments are IANA names resolved by the runtime's `Intl.DateTimeFormat` (no hard-coded zone
data; DST handled by the runtime). Literal zones are validated at compile time; an unknown zone from data makes
`dateParts` return `null` and `between` return `false`.

### Decision: glob (`like`) instead of regular expressions

rules@1 has **no regular expressions**. PLAN's `matches()` is provided as `like()`/`ilike()` with glob semantics,
because merchant-authored and data-driven regexes are the classic ReDoS vector and a user-facing footgun. The glob
matcher is iterative with single-star backtracking — worst case O(|s| × |pattern|), no recursion — and is charged to
the step budget proportionally. Patterns are capped at 256 characters (`MAX_PATTERN_LENGTH`): a longer literal
pattern is a compile error, a longer pattern from data never matches. If a future version adds regex, it will be a
new function over a linear-time engine, in a new grammar version.

## 7. Limits

| Limit             | Default               | Error code        | Where                                                                                                                                                                |
| ----------------- | --------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxLength`       | 4000 characters       | `too_long`        | compile                                                                                                                                                              |
| `maxDepth`        | 64 (hard ceiling 256) | `too_deep`        | compile / deserialize (nesting of operators, calls, parentheses; `and`/`or` chains are flat)                                                                         |
| `maxNodes`        | 2000 AST nodes        | `too_many_nodes`  | compile / deserialize                                                                                                                                                |
| `maxSteps`        | 10 000                | `max_steps`       | evaluate: 1 per node, 1 per predicate iteration and per list item visited by list functions/equality/membership, and ~1 per 256 characters of string work (`like`: ~ | s   | ×   | p   | /64) |
| `maxListLength`   | 1000 items            | `list_too_long`   | evaluate: list literals, `filter`, `map`, list `+` list                                                                                                              |
| `maxStringLength` | 10 000 characters     | `string_too_long` | evaluate: `+` concatenation, `string()`                                                                                                                              |

Other error codes: `syntax`, `empty`, `reserved` (`it` outside predicates), `forbidden_key`, `unknown_function`,
`arity`, `invalid_argument`, `invalid_source`, `unsupported_version`, `invalid_program`, `invalid_option`, `internal`.

## 8. Security properties

- Hand-written lexer and Pratt parser; no `eval`, `Function`, `with`, dynamic import or host regexes over input.
- Parser recursion and AST depth are bounded (no stack exhaustion from `((((…`); evaluation is bounded by steps.
- The evaluator reads only own data properties (no getters, no prototype chain, no forbidden keys), never calls
  context values, never mutates the context, and returns fresh values for everything it computes.
- Deserialised programs are fully re-validated (node shapes, operators, identifiers, keys, functions, arity,
  literal arguments, `it` scoping, limits) before evaluation.

## 9. Examples

```
# Coupon eligibility
order.subtotal >= 5000 and not inSegment('wholesale') and count(customer.orders) == 0

# Loyalty points formula
floor(order.total / 100) * (customer.tier == 'gold' ? 2 : 1)

# Deal schedule (weekend evenings in the store's zone)
dateParts(now, 'Asia/Karachi').weekday >= 6 and between(now, '18:00', '23:00', 'Asia/Karachi')

# Chatbot proactive trigger
session.pageViews >= 3 and like(page.path, '/products/*') and not has(session.chatOpenedAt)

# Price-drop alert
item.previousPrice > 0 and (item.previousPrice - item.price) / item.previousPrice >= 0.1
```

## 10. Versioning

Programs carry `v: 1`. Any change that alters the meaning of an existing program requires a new version; the
evaluator refuses versions it does not know (`unsupported_version`). Additive, backwards-compatible library growth
(a new function name) may ship within v1.
