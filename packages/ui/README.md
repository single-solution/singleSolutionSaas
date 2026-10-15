# @ss/ui

React 19 components for the Portal and the product dashboards: design tokens (light and dark, `--ss-*` CSS variables in
`theme.css`), form controls, data display, overlays, `AppShell` and `SchemaForm` (a feature's settings form, rendered
from its settings schema). Untranspiled JSX in `.js` files: Next.js apps list the package in `transpilePackages`, and
Tailwind scans `node_modules/@ss/ui/src` (`@source` in the app's CSS).

| Entry              | What it is                                                                                                                 |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `@ss/ui`           | every component, `cx`, and the format and problem helpers                                                                  |
| `@ss/ui/dashboard` | the product dashboard every product shares: the page, its standard tabs, their pieces, words and API helpers               |
| `@ss/ui/problems`  | RFC 9457 problem → user message and field-error helpers                                                                    |
| `@ss/ui/theme.css` | the design tokens                                                                                                          |
| `@ss/ui/testing`   | DOM test helpers on `react-dom/client` + jsdom (`render`, `cleanup`, `click`, `type`, `byLabel`, …) for other units' tests |

## Color rule

One accent (PLAN.md 0.6): indigo (`primary`) is used for primary buttons, links, the active item, icon tiles and
badges; surfaces are neutral; green, amber and red mean status only (`tone` `success`, `warning`, `danger`). `IconBadge`,
`Stat`, `Badge`, `EmptyState` and `AppShell` menu items take a `kind` (`overview`, `merchant`, `website`, `product`,
`feature`, `credit`, `price`, `admin`, `settings`, `default`, `activity`, `connection`, `developer`) that names the thing;
every kind takes the same indigo tint (`primary-soft`), and leaving `kind` out keeps the item neutral. No screen names a
color for meaning. The `hero` card is solid indigo.

## Widths: containers, not the screen

Components follow the width they are given (Tailwind container queries), so a narrow detail pane or card gets the
narrow layout even on a wide screen (PLAN.md 0.6 Medium widths). `AppShell` shows the sidebar from 1024 px; below that
it is the menu button.

- `<Stat>` puts its icon above the label below a 16rem tile; the label wraps on whole words; a figure stays on one line
  and is never cut — its type steps down where the tile is too narrow for it (phrases that are not plain text wrap).
- `<StatGrid label?>` (classes in `STAT_GRID`) holds the tiles: one column, two from 28rem (an odd last tile spans the
  row), three tiles in a row from 42rem and four from 56rem.
- `KeyValueList`, `Masonry` and the field grid also follow their own width.
- `PageHeader` keeps its actions beside the title while both fit on one line, else moves them together under it.
- `Table` cells keep one line (a column with `wrap` wraps on whole words within 10rem); a table wider than its card
  scrolls inside it. With no rows it shows only its empty message.
- `<SoftBreaks text>` lets a domain, email or path wrap between its parts (`<wbr>` after dots, `@` and slashes).

## Masonry and the More menu

`<Masonry columns? as? label?>` lays cards of different heights out in CSS columns (1, 2 from a 42rem container, 3 from
72rem; `columns={2}` stops at two) with every card kept whole, so no card stretches to a taller neighbor; with
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
- `Dialog`, `ActionMenu`, toasts and the phone menu animate in and out (they stay mounted while they leave);
  callouts and field errors fade in (an error with a short shake); new table rows and changed `Stat`
  figures fade in; skeletons shimmer (`Skeleton`, `SkeletonBlock`).
- `AppShell`: the current item's tint slides to the clicked item at once, and the frame holds the thin progress bar on
  top of the page while anything reports progress (`useNavigationProgress(active)`, `RouteProgress` in a loading
  skeleton). `PendingHint` is the fixed-size spinner beside a clicked link.
- `PageTransition` and `SwapTransition` animate page and section changes with React's `ViewTransition` (navigations and
  other transitions only); browsers without view transitions get a CSS enter animation.

## Overviews that talk

One Overview pattern for the Portal and every product dashboard (PLAN.md 0.6 "Overviews talk", `overview.js`): a
greeting with one sentence of what matters now, **Needs you** (each item says what happens if it waits and carries its
button), a setup checklist, the key numbers and the latest activity as a timeline in the viewer's local time.

- The pieces take the caller's words: `NeedsList` (each item says what is wrong, what happens if it waits and carries
  its button; a calm line when nothing needs the viewer), `SetupChecklist` (progress bar; a step to do is a link drawn
  with `linkAs`, a button or plain text) and `Timeline` (initials from `initialsOf`, times with `LocalTime`).
- `<ProductOverview data who product support portal namesOf open recheck needs? steps? numbers?>` is a product
  dashboard's whole Overview from the kit's overview answer, with the words of `overview-texts.js` (US English): the
  status, no feature on, each missing or failed connection, the widget not seen and business.json not found are "Needs
  you" items and setup steps on their own; the product adds its own `needs`, `steps`, `numbers` (`Stat` tiles) and
  sections (`children`). Red items come first; the sentence names the most urgent one. `open(tab)` shows a dashboard
  section (Features, Settings, Connections or Developers); credits send merchants to support and admins to the Portal.
  `OverviewSkeleton` is its loading state; `RecentChanges` is the timeline card also shown under Defaults and Prices.

## Product dashboard

`@ss/ui/dashboard` (client only) is the dashboard of every product (PLAN.md 0.4.3), one implementation for all: a
product's `app/dashboard/page.js` is `<ProductDashboard manifest={manifest} texts={TEXTS} tabs={TABS} />`.

- `ProductDashboard` loads the session, then shows the sidebar (Overview, Features, Settings, Connections, Developers;
  Defaults and Prices for Owners), the website switcher (merchant names for admins), the `Admin view` banner and Back
  to Portal; sections and websites switch inside the page and the address follows (Back and Forward work). `tabs`
  puts a product's own section in a standard tab's place (`{ settings: ChatSettings }`) or adds a tab
  (`{ lists: { component, icon, kind, global? } }`, its label in `texts.tabs`). Each tab gets `TabProps`:
  `websiteId`, `domain`, `who`, `support`, `portal` and `open(tab)`.
- Words: `DASHBOARD_TEXTS` are the shared ones (US English). `dashboardTexts({ title, ...own })` lays the product's
  title and its own words over them group by group (a product may reword one shared text). Both come from `@ss/ui`
  itself, not from the client-only `@ss/ui/dashboard`, because the product's server `app/layout.js` reads its title; `useDashboard()` gives the
  merged words and `namesOf(keys, max?)` (feature names from the manifest) inside the page or a `DashboardProvider`.
- Standard tabs, each taking the product's parts as props: `OverviewTab` (`useMore(overview, props)`, a hook that
  returns the product's `needs`, `steps`, `numbers` and `children`), `FeaturesTab` (`warnings(on)`), `SettingsTab`
  (`sections` first, `notice(key, values, features)` on a feature's card, `featureCards(features)` beside the forms),
  `ConnectionsTab` (`form(item, save)` for a connection's own form, `hint(name)`; Remove sits in the card's ⋯ menu
  and asks first), `DevelopersTab` (`links`, and the product's sections as children instead of the widget script),
  `DefaultsTab` (`notice`) and `PricesTab` (with the Re-seal card).
- Pieces for a product's own tabs: `Loaded`, `Outcome`, `SettingsForms`, `TextsForm` (with a box that finds a text),
  `ThemeForm`, `FormatForm`, `ResealCard`, and `hasSettings`, `toneOf`, `withDependents`.
- API: `call(method, path, body?)` answers `{ ok: true, data }` or `{ ok: false, problem }` (a product that does not
  answer is a 503 problem); `useLoad(path | null)` shows a resource's last answer at once and refreshes it, with
  `reload()`; `fill(text, values)` fills `{name}` placeholders.

## SchemaForm

`<SchemaForm schema values onChange errors? overridden? onReset? disabled? />` renders each setting of a settings schema
(what `@ss/contracts` allows: string, integer, number, boolean and list settings), in the schema's order, as a control
chosen by its type, its `format` (`email`, `uri`) and `x-ui.widget`, grouped by `x-ui.group`, with its `description` as
help. Fields sit in the field grid; long text (a `textarea` widget), lists and fields with `x-ui.wide` span the row. A list of more than 12 choices (or `x-ui.widget: 'tags'`) is a searchable picker
(`ChoicePicker`: chosen ones as chips, a search box, a scrolling list); `x-ui.labels: 'country'` shows ISO country codes
by their names. A list without choices is typed one item per line (a list of on/off values as JSON). Bounds
(`minimum`/`maximum`, `maxLength`) are shown on the inputs (number limits, the character counter of a text area). The
product checks every value when it is saved, and its field errors are passed in `errors`. Settings marked in
`overridden` get a Reset link that calls `onReset(name)`.

## StatusBadge

`<StatusBadge status label? />` colors the statuses of PLAN.md 0.5.5: `active` green, `low_balance` and `grace` amber,
`stopped` and `suspended` red, `removed` gray; any other status is gray unless listed in `display.js`.

## Dates and credits

One style for the Portal and every dashboard, in US English: `formatDate` gives `Oct 4, 2026` and `formatDateTime`
gives `Oct 4, 2026, 2:30 PM UTC` (UTC, so the server and the browser render the same text). With
`formatDateTime(value, { timeZone })` the same style shows another time zone with its short name
(`Oct 4, 2026, 10:30 AM EDT`), for the viewer's local time once the page runs. `formatCredits` gives `12.5 credits`.
`humanize` reads a code as words (`low_balance` → `Low balance`, `api_key` → `API key`): status badges and the choices
of a settings form use it.

## Check

```sh
pnpm check   # format, lint, typecheck, vitest (jsdom) with coverage 90 % lines, 90 % functions, 85 % branches
```
