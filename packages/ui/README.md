# @ss/ui

React 19 components for the Portal and the product dashboards: design tokens (light and dark, `--ss-*` CSS variables in
`theme.css`), form controls, data display, overlays, `AppShell` and `SchemaForm` (a feature's settings form, rendered
from its settings schema). Untranspiled JSX in `.js` files: Next.js apps list the package in `transpilePackages`, and
Tailwind scans `node_modules/@ss/ui/src` (`@source` in the app's CSS).

| Entry              | What it is                                                                                                                 |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `@ss/ui`           | every component, `cx`, and the schema, format and problem helpers                                                          |
| `@ss/ui/schema`    | settings-schema helpers behind `SchemaForm` (no React): fields, groups, bounds, browser-side validation                    |
| `@ss/ui/format`    | credit (from millicredits), date and number formatting                                                                     |
| `@ss/ui/problems`  | RFC 9457 problem → user message and field-error helpers                                                                    |
| `@ss/ui/theme.css` | the design tokens                                                                                                          |
| `@ss/ui/testing`   | DOM test helpers on `react-dom/client` + jsdom (`render`, `cleanup`, `click`, `type`, `byLabel`, …) for other units' tests |

## SchemaForm

`<SchemaForm schema values onChange errors? overridden? onReset? disabled? />` renders each top-level property of a
settings schema as a control chosen by its type and `x-ui.widget`, grouped by `x-ui.group`, ordered by `x-ui.order`, with
`x-ui.advanced` settings behind a disclosure and `x-ui.hidden` ones left out. Bounds (`minimum`/`maximum`, `maxLength`,
`maxItems`) are shown on the inputs and checked by `validateValues(schema, values)`; the product's own field errors are
passed in `errors`. Settings marked in `overridden` get a Reset link that calls `onReset(name)`.

## StatusBadge

`<StatusBadge status label? />` colours the statuses of PLAN.md 0.5.5: `active` green, `low_balance` and `grace` amber,
`stopped` and `suspended` red, `removed` grey; any other status is grey unless listed in `display.js`.

## Check

```sh
pnpm check   # format, lint, typecheck, vitest (jsdom) with coverage 90 % lines, 90 % functions, 85 % branches
```
