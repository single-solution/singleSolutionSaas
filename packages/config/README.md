# @ss/config — shared tooling

The one place the code standard lives (PLAN F.6, F.17): every unit of the repository (`platform/`, each `products/*`,
each `packages/*`, `e2e/`) builds its own lint, typecheck, format and test config from this package, so each folder
works on its own and can move to a repository of its own unchanged.

| Entry                           | What it is                                                                                                                                                                                   |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@ss/config/eslint`             | `createEslintConfig({ jsx?, browserJsx?, ignores? })`: the functional rules (no classes, no `console`, no mutation of inputs, `===`), plus a JSX variant for React components in `.js` files |
| `@ss/config/tsconfig.base.json` | `tsc --checkJs --strict --noUncheckedIndexedAccess` over JSDoc-typed JavaScript, no emit                                                                                                     |
| `@ss/config/prettier.json`      | tabs, width 130, single quotes                                                                                                                                                               |
| `@ss/config/vitest`             | `defineUnitConfig({ dir, include?, coverageInclude?, coverageExclude?, jsx?, mongo? })`: thresholds 90 % lines, 90 % functions, 85 % branches                                                |
| `@ss/config/mongo-setup`        | Vitest global setup: one MongoMemoryReplSet for the run, exposed as `SS_TEST_MONGO_URI` (TTL monitor off)                                                                                    |

## Use

```js
// eslint.config.js
import { createEslintConfig } from '@ss/config/eslint';

export default createEslintConfig({ jsx: ['app/**/*.js'], browserJsx: ['src/console/**/*.js'] });
```

```js
// vitest.config.js
import { defineUnitConfig } from '@ss/config/vitest';

export default defineUnitConfig({ dir: import.meta.dirname, coverageInclude: ['src/**'], mongo: true });
```

```json
// tsconfig.json
{ "extends": "@ss/config/tsconfig.base.json", "include": ["src/**/*.js", "test/**/*.js"] }
```

```json
// package.json
{ "prettier": "@ss/config/prettier.json" }
```

`jsx` lists the unit's folders whose `.js` files contain JSX; `@ss/ui` sources are always transformed (also when the
package comes from `node_modules`, where Vitest inlines it). `mongo: true` adds the Mongo global setup: one
single-node replica set per run, reference-counted across Vitest projects (the root `pnpm test:all` shares one between
every unit) and skipped when `SS_TEST_MONGO_URI` is already set. Test helpers give each test file its own databases
on it. Its TTL monitor is off because tests run on an injected clock: documents must never expire by wall time.

The tools themselves are peer dependencies (`eslint`, `prettier`, `typescript`, `vitest`, `@vitest/coverage-v8`, and
`mongodb` + `mongodb-memory-server` for the Mongo setup): each unit declares the versions it runs.

## Check

```sh
pnpm check   # format, lint, typecheck, vitest with coverage
```
