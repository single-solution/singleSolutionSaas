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

## Colour rule

Colour carries meaning only through semantic tokens (PLAN.md 0.6). `IconBadge`, `Stat`, `Badge`, `EmptyState` and
`AppShell` menu items take a `kind` (`overview`, `merchant`, `website`, `product`, `feature`, `credit`, `price`, `admin`,
`settings`, `default`, `activity`, `connection`, `developer`); its colour comes from `--tone-<kind>`, `--tone-<kind>-tint`
and `--tone-<kind>-on` in `theme.css`. Palette A (default) gives each kind its own colour; palette B
(`data-palette="mono"` on `<html>`) maps every kind to the indigo tint. Status colours stay on `tone`
(`success`, `warning`, `danger`).

## Field grid

Every control (`Input`, `Select`, `TextArea`, `Checkbox`, `Switch`, `RadioGroup`, `CheckboxGroup`) is a grid cell. Inside
a `Form`, a `FieldGrid` or a `SchemaForm` group, short controls pack into 1 / 2 / 3 columns by the width of the form
(container queries); `TextArea`, `CheckboxGroup` and any control with `wide` span the row, as do children that are not
controls (buttons, callouts).

## SchemaForm

`<SchemaForm schema values onChange errors? overridden? onReset? disabled? />` renders each top-level property of a
settings schema as a control chosen by its type and `x-ui.widget`, grouped by `x-ui.group`, ordered by `x-ui.order`, with
`x-ui.advanced` settings behind a disclosure and `x-ui.hidden` ones left out. Fields sit in the field grid; long text (a
`textarea` widget or a `format` of `textarea`, `multiline`, `markdown` or `html`), JSON, lists, fieldsets and fields with
`x-ui.wide` span the row. Bounds (`minimum`/`maximum`, `maxLength`,
`maxItems`) are shown on the inputs and checked by `validateValues(schema, values)`; the product's own field errors are
passed in `errors`. Settings marked in `overridden` get a Reset link that calls `onReset(name)`.

## StatusBadge

`<StatusBadge status label? />` colours the statuses of PLAN.md 0.5.5: `active` green, `low_balance` and `grace` amber,
`stopped` and `suspended` red, `removed` grey; any other status is grey unless listed in `display.js`.

## Check

```sh
pnpm check   # format, lint, typecheck, vitest (jsdom) with coverage 90 % lines, 90 % functions, 85 % branches
```
