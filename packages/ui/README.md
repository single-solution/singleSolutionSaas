# @ss/ui — console component library

React 19 components for the consoles (the Portal's merchant and admin consoles, product dashboards): design tokens
(light and dark, `--ss-*` CSS variables in `theme.css`), form controls, data display, overlays, `AppShell` and
`SchemaForm` (renders a feature schema as a settings form). Untranspiled JSX in `.js` files: Next.js apps list it in
`transpilePackages`, and Tailwind scans `node_modules/@ss/ui/src` (`@source` in the app's CSS).

| Entry              | What it is                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `@ss/ui`           | every component, `cx`, the schema, format and problem helpers                                                            |
| `@ss/ui/schema`    | feature-schema helpers used by `SchemaForm` (no React)                                                                   |
| `@ss/ui/format`    | credit (millicredit), hour, date and number formatting                                                                   |
| `@ss/ui/problems`  | RFC 9457 problem → user message helpers                                                                                  |
| `@ss/ui/theme.css` | the design tokens                                                                                                        |
| `@ss/ui/testing`   | DOM test helpers on `react-dom/client` + jsdom (`render`, `cleanup`, `click`, `type`, `byLabel`, …) for consumers' tests |

## Check

```sh
pnpm check   # format, lint, typecheck, vitest (jsdom) with coverage
```
