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

One accent (PLAN.md 0.6): indigo (`primary`) is used for primary buttons, links, the active item, icon tiles and
badges; surfaces are neutral; green, amber and red mean status only (`tone` `success`, `warning`, `danger`). `IconBadge`,
`Stat`, `Badge`, `EmptyState` and `AppShell` menu items take a `kind` (`overview`, `merchant`, `website`, `product`,
`feature`, `credit`, `price`, `admin`, `settings`, `default`, `activity`, `connection`, `developer`) that names the thing;
every kind takes the same indigo tint (`primary-soft`), and leaving `kind` out keeps the item neutral. No screen names a
colour for meaning. The `hero` card is solid indigo.

## Widths: containers, not the screen

Components follow the width they are given (Tailwind container queries), so a narrow detail pane or card gets the
narrow layout even on a wide screen (PLAN.md 0.6 Medium widths). `AppShell` shows the sidebar from 1024 px; below that
it is the menu button.

- `<Stat>` puts its icon above the label below a 16rem tile; the label wraps on whole words; a figure stays on one line
  and is never cut — its type steps down where the tile is too narrow for it (phrases that are not plain text wrap).
- `<StatGrid label?>` (classes in `STAT_GRID`) holds the tiles: one column, two from 28rem (an odd last tile spans the
  row), three tiles in a row from 42rem and four from 56rem.
- `KeyValueList`, `HeroCard`, `Masonry` and the field grid also follow their own width.
- `PageHeader` keeps its actions beside the title while both fit on one line, else moves them together under it.
- `Table` cells keep one line (a column with `wrap` wraps on whole words within 10rem); a table wider than its card
  scrolls inside it. With no rows it shows only its empty message.
- `<SoftBreaks text>` lets a domain, e-mail or path wrap between its parts (`<wbr>` after dots, `@` and slashes).

## Masonry and the More menu

`<Masonry columns? as? label?>` lays cards of different heights out in CSS columns (1, 2 from a 42rem container, 3 from
72rem; `columns={2}` stops at two) with every card kept whole, so no card stretches to a taller neighbour; with
`wideAlone` a lone card takes the whole width (a settings section with one form). Settings pages, website cards and the
product dashboards' card lists use it.

`<ActionMenu label items icon? size? />` is the compact ⋯ menu of a detail header or a card: the main one or two actions
stay buttons, the rest go in the menu, a destructive one last with `danger: true`. Arrow keys, Home and End move between
the items; Escape, Tab and a click outside close it. There are no tabs: pages show their sections one under another
(PLAN 0.6).

## Field grid

Every control (`Input`, `Select`, `TextArea`, `Checkbox`, `Switch`, `RadioGroup`, `CheckboxGroup`) is a grid cell. Inside
a `Form`, a `FieldGrid` or a `SchemaForm` group, short controls pack into 1 / 2 / 3 columns by the width of the form
(container queries); `TextArea`, `CheckboxGroup` and any control with `wide` span the row, as do children that are not
controls (buttons, callouts) and a lone control (a card with one short setting does not leave it in a corner).

## Motion and feedback

One motion system for the Portal and every product dashboard (PLAN.md 0.6): three durations (`--ss-motion-fast` 120 ms,
`--ss-motion` 180 ms, `--ss-motion-slow` 240 ms) and three curves (`--ss-ease` for entering and hover, `--ss-ease-move`
between two places, `--ss-ease-exit` for leaving) in `theme.css`; only `transform` (`translate`, `scale`) and `opacity`
move. With `prefers-reduced-motion` nothing moves.

- Buttons tint on hover and press in (`ss-motion ss-press`). A button whose `onClick` returns a promise, and the submit
  button of a `Form` whose `onSubmit` returns one, show the spinner and stay disabled until it settles (`loading` and
  `busy` still work). `FormBusyContext` gives the same to a submit button inside another form.
- `Dialog`, `ActionMenu`, toasts and the phone menu animate in and out (`usePresence` keeps them mounted while they leave);
  callouts and field errors fade in (an error with a short shake); new table rows and changed `Stat` / `HeroCard`
  figures fade in; skeletons shimmer (`Skeleton`, `SkeletonBlock`).
- `AppShell`: the current item's tint slides to the clicked item at once, and the frame holds `NavigationProgress`, the
  thin bar on top of the page while anything reports progress (`useNavigationProgress(active)`, `RouteProgress` in a
  loading skeleton). `PendingHint` is the fixed-size spinner beside a clicked link.
- `PageTransition` and `SwapTransition` animate page and section changes with React's `ViewTransition` (navigations and
  other transitions only); browsers without view transitions get a CSS enter animation.

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
