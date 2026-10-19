# @ss/ui

React 19 components for the Portal and the product dashboards: design tokens (light and dark, `--ss-*` CSS variables in
`theme.css`), form controls, data display, overlays, `AppShell` and `SchemaForm` (a feature's settings form, rendered
from its settings schema). Untranspiled JSX in `.js` files: Next.js apps list the package in `transpilePackages`, and
Tailwind scans `node_modules/@ss/ui/src` (`@source` in the app's CSS).

| Entry                | What it is                                                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `@ss/ui`             | every component, `cx`, and the format and problem helpers                                                                  |
| `@ss/ui/dashboard`   | the product dashboard every product shares: the page, its standard tabs, their pieces, words and API helpers               |
| `@ss/ui/problems`    | RFC 9457 problem → user message and field-error helpers                                                                    |
| `@ss/ui/seo-preview` | the search result and share card preview without React, for widgets (`seoPreview`, `SEO_PREVIEW_CSS`, the measure)         |
| `@ss/ui/theme.css`   | the design tokens                                                                                                          |
| `@ss/ui/testing`     | DOM test helpers on `react-dom/client` + jsdom (`render`, `cleanup`, `click`, `type`, `byLabel`, …) for other units' tests |

## Color rule (redesign 2, owner 2026-10-17: 60-30-10, colors carry meaning)

60 % the off-white canvas (`canvas` #F7F8F5; dark: navy #0A1C40), 30 % white surfaces and navy text (`fg` #0A1C40),
pale sage (`surface-2`) for hover and selected rows; 10 % meaning, used sparingly — one `tone` per meaning:

| Tone        | Hue                      | Means                                                       |
| ----------- | ------------------------ | ----------------------------------------------------------- |
| `primary`   | Integrity blue #2226F7   | main buttons, links, the active item, focus                 |
| `success`   | Natural green #24D56D    | success, paid, active, done steps                           |
| `danger`    | Excitement red #F72226   | errors and destructive actions only                         |
| `warning`   | Happiness yellow #FFD527 | warnings, soft highlights (always with dark text)           |
| `attention` | Energetic orange #FE5E20 | needs the person: setup steps, alerts, Needs you; no button |
| `info`      | Kindness teal #00D6A3    | tips, help, empty-state hints                               |
| `new`       | Originality pink #FF3797 | new, featured, promotions                                   |

Every meaning has the brand hue for dots, bars and fills (`bg-success-solid`, `DOTS`), a 50 tint for backgrounds
(`-soft`, `TINTS`) and an AA text shade (`text-success`, `on-success-soft`), darkened where the hue is too light for
text. `IconBadge`, `Stat`, `Badge`, `EmptyState` and `AppShell` menu items take a `kind` (`overview`, `merchant`,
`website`, `product`, …) that names the thing: every kind takes the blue tint, and leaving `kind` out keeps the item
neutral. Each product's chip has its own meaning color, tinted only (`IconBadge product="chat"`, `ListRow product`,
`productLook`): Accounts blue, Payments green, Chat teal, Growth orange, Notifications yellow, Ecommerce pink.

## The premium frame and blocks (owner 2026-10-16)

Panels float on a quiet canvas with 12-16 px of space around them and between them (hairline edge, very soft shadow);
the page is as wide as the window leaves it. Nothing is centered in a narrow column except long reading text.

- `AppShell`: a floating WHITE sidebar, bottom-weighted (240 px, folding to a 64 px icon rail remembered in
  `localStorage`): the logo, the main sections, then at the bottom the `switcher`, `sidebarFooter` (help), the `account`
  menu and the theme with the fold button; a header panel (breadcrumbs and title, `context`, `topbar`, `search`,
  `actions`, `back`) and a phone drawer (the header then holds the account or theme menu). No command bar, no assistant
  dock. `switcher` and `sidebarFooter` may be functions of `{ rail }` (also `useShell()`).
- `PageHeader` (a page's title, `badge`, `meta`, `actions` and `subtitle`): inside an `AppShell` on wide screens the
  title, its status, its context and its main actions sit in the header and the subtitle opens the page; `level={2}`
  (a detail beside a list) stays in the page. `HeaderMeta` puts context in the header without a title, and
  `HeaderFact` is one fact there (`3 websites`, a status dot with its words, Saved 2 min ago).
- `Dialog` / `Drawer`: editing opens in a RIGHT drawer that keeps the page in view (`Dialog` `md` / `lg`, or `Drawer`);
  `size="sm"` and `placement="center"` are centered modals, only for short confirmations (`ConfirmDialog`,
  `TypedConfirmDialog`, `PasswordConfirmDialog`) and a link to copy.
- `LockedState` and `StatusPill status="locked"`: a feature the person cannot use yet, said clearly (what it does; ask
  the admin to switch it on).
- `Grid` / `Col span lg xl`: the page's 12 columns (one column on a phone).
- `SettingsCard` (title, one-line description, actions, `footer`) with setting rows: label and muted help on the left,
  the control on the right, hairlines between, stacked in a narrow card. Fields inside a card (and a `Form` inside one)
  become rows by themselves (`FieldLayoutContext`); `SettingRow` is a row for any other control; `Dialog` and `ListEditor`
  items stack again. `layout="stack" | "row"` on a field overrides.
- `SectionLayout` / `SectionNav` / `useHashSection`: the inner sidebar (about 220 px) ONLY for pages with sub-pages
  (grouped links with their context: counts, `badge`, a `status` dot such as needs setup; sticky, a search box from 10
  links, a button that opens the list on phones); a page without sub-pages uses the full width. ONE section is shown at a time; a section
  mounts when first opened and then stays; the choice is in the hash with a history entry per choice (Back works). A
  section with `children` lists them as sub-items, each its own view. A page with one section has no sidebar. Use it
  (not a long column) for every page with more than about two cards.
- `CardFlow` / `CARD_FLOW` (also what `SectionLayout` panels and `SchemaForm` use): cards in auto-fill columns of at least
  24 rem, always at their natural height (`NO_STRETCH` = `items-start`; never equal heights). A `SettingsCard` or
  `<Card flow>` takes one column; anything else in the flow (table, editor, callout) takes the whole row. A lone card
  takes the whole row (`SettingsCard wide`).
- `Disclosure` (collapsed by default; `forceOpen`), `PillTabs`, `ItemSwitcher` (a list editor's entries one at a time),
  `Paged` (search from 8 items and Previous / Next pages), `ViewTitle`.
- `SchemaForm`: settings with `x-ui.advanced` (or in a group named Advanced) are in a collapsed Advanced block; from three
  groups on only one group shows, under a tab strip (`tabs={false}` lists the cards; `group="Name"` shows one group).
- Controls on native inputs: `Switch` (`role="switch"`), `Checkbox` / `CheckboxInput` (`indeterminate`), `RadioGroup`
  (`cards`: title plus `description`; arrow keys), `SegmentedControl` (up to about four short choices), `Input` with
  `prefix` / `suffix` adornments, `Select`, `TextArea`; 36 px high, the accent focus ring, error and disabled states.
- `ManagedNote` (title, text, `href`): a teal note where a value is shown that the Portal owns (the website's look, Format,
  business facts): what it is and where it is set, with a link to that place in the Portal. The look and the Format have
  no form in any product (they are the Portal's Website settings); `websiteSettingsUrl({ portal, admin, websiteId, merchantId, section })`
  is the address of a section of that page, `WEBSITE_SECTION_NAMES` their names.
- `SaveBar`: the only save control. It floats at the bottom centre of the page area (centred next to the sidebar), shown only while something changed. `disabled` keeps Save off for an entry the server would refuse; a save that returns a promise shows the spinner until it settles. It replaced `SaveRow`: put an Add button in its own row beside the editor. `AccountMenu`, `Avatar`.
- Rows and editors (never draw these by hand; flat, with hairlines, never boxes in a card): `RowList` + `ListRow` (a
  name, a pill, one primary action and a More menu; `wrap` for long names), `EntryGroup` (one entry of a list editor: a
  flat group under a hairline with its name and Move up, Move down and Remove, or collapsed under a `summary`), `Badge onRemove` (a removable tag), `TextLink` (the one
  link in text, a table, a header or a footer; `as` for a router link, `external`, `tone="plain"`), and `Input
type="file"` for a file field.
- `SaveOutcome` (`@ss/ui/dashboard`): the outcome of a save in an editor. Saved and a refused save are toasts; the errors
  that name a row or a field stay inline under the editor (`problemLines` words a 422 answer). `Outcome` is the same
  without the inline list (toasts only).
- Empty and error states are frameless (whitespace, a tinted icon, what to do); loading shows skeletons shaped like the
  content (`Skeleton`, `SkeletonBlock`, `OverviewSkeleton`).
- The setup checklist (`SetupChecklist`, `useSetupSteps` in `@ss/ui/dashboard`): a product declares a short list of
  requirements (a setting, a list or "one of these features on", for the features that are on, with a plain label, a
  one-line why and a button); each is ticked from the saved state and its button opens the exact section
  (`open('settings', 'catalog.page-addresses')` → `?view=settings#catalog.page-addresses`; a hash that names a feature
  opens its first view). The connections a feature needs come from the manifest's `neededBy`, not from the product.

## Widths: containers, not the screen

Components follow the width they are given (Tailwind container queries), so a narrow detail pane or card gets the
narrow layout even on a wide screen (PLAN.md 0.6 Medium widths). `AppShell` shows the sidebar from 1024 px; below that
it is the menu button.

- `<Stat>` puts its icon above the label below a 16rem tile; the label wraps on whole words; a figure stays on one line
  and is never cut — its type steps down where the tile is too narrow for it (phrases that are not plain text wrap).
- `<StatGrid label?>` (classes in `STAT_GRID`) holds the tiles: one column, two from 28rem (an odd last tile spans the
  row), three tiles in a row from 42rem and four from 56rem.
- `KeyValueList`, `Masonry` and the field grid also follow their own width.
- `PageHeader` in the page (no frame, a detail, a phone) keeps its actions beside the title while both fit on one line,
  else moves them together under it.
- `Table` cells keep one line (a column with `wrap` wraps on whole words within 10rem); a table wider than its card
  scrolls inside it (a labeled region the keyboard can focus and scroll). With no rows it shows only its empty message.
- Type sizes beside Tailwind's scale are named in `theme.css`: `text-micro` (11px), `text-label` (13px), `text-lead` (15px),
  `text-heading` (17px), `text-page` (26px) and `text-figure` (28px); use them instead of `text-[13px]`. A failed
  dashboard section (`Loaded` with an answer from `useLoad`) offers Try again; `ConfirmDialog` starts on Cancel when `danger`.
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
  status, no feature on, each missing or failed connection, the widget not seen and the Portal's website settings not set
  (or lacking what the manifest's `websiteSettings.requires` asks for, one item per section with a link to it in the
  Portal) are "Needs you" items and setup steps on their own; the product adds its own `needs`, `steps`, `numbers` (`Stat` tiles) and
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
  `websiteId`, `merchantId`, `domain`, `who`, `support`, `portal` and `open(tab)`. The header has the Docs link.
- Words: `DASHBOARD_TEXTS` are the shared ones (US English). `dashboardTexts({ title, ...own })` lays the product's
  title and its own words over them group by group (a product may reword one shared text). Both come from `@ss/ui`
  itself, not from the client-only `@ss/ui/dashboard`, because the product's server `app/layout.js` reads its title; `useDashboard()` gives the
  merged words and `namesOf(keys, max?)` (feature names from the manifest) inside the page or a `DashboardProvider`.
- Standard tabs, each taking the product's parts as props: `OverviewTab` (`useMore(overview, props)`, a hook that
  returns the product's `needs`, `steps`, `numbers` and `children`), `FeaturesTab` (`warnings(on)`), `SettingsTab`
  (`sections` first, `notice(key, values, features)` on a feature's card, `featureCards(features)` beside the forms),
  `ConnectionsTab` (`form(item, save)` for a connection's own form, `hint(name)`; Remove sits in the card's ⋯ menu
  and asks first), `DevelopersTab` (the product's `sections` instead of the widget script, `children` under More; the
  website id and tokens are in the Portal),
  `DefaultsTab` (`notice`) and `PricesTab` (with the Re-seal card).
- Pieces for a product's own tabs: `Loaded`, `Outcome`, `SaveOutcome`, `SettingsForms`, `TextsForm` (with a box that finds a text),
  `ResealCard`, and `hasSettings`, `toneOf`, `withDependents`. A setting marked `x-ui.defaultFrom` says "Using your
  website's language. Change it in the Portal" under its help while it uses the Portal's value (`SchemaForm`'s
  `inherited`).
- API: `call(method, path, body?)` answers `{ ok: true, data }` or `{ ok: false, problem }` (a product that does not
  answer is a 503 problem); `useLoad(path | null)` shows a resource's last answer at once and refreshes it, with
  `reload()`; `fill(text, values)` fills `{name}` placeholders.

## SchemaForm

`<SchemaForm schema values onChange errors? overridden? onReset? disabled? title? description? before? after? dirty? onSave? onDiscard? />`
renders each setting of a settings schema (what `@ss/contracts` allows: string, integer, number, boolean and list
settings) as a control chosen by its type, its `format` (`email`, `uri`) and `x-ui.widget`, with its `description` as help.
The settings are titled cards, one per `x-ui.group` (settings without a group share one card, titled with the feature's
`title`; with several groups `title` heads them), each setting a row, in the schema's order or by `x-ui.order` (those
with an order first, ascending). A boolean is a toggle, a choice of up to four short words a segmented control (longer
words a radio list), more choices a select. With `onSave` the sticky Save changes bar (Discard) shows while `dirty`; the
dashboards' `SettingsForms` use one bar for all features. Long text (a `textarea` widget), lists and fields with `x-ui.wide` take the whole row. A list of more than 12 choices (or `x-ui.widget: 'tags'`) is a searchable picker
(`ChoicePicker`: chosen ones as chips, a search box, a scrolling list); `x-ui.labels: 'country'` shows ISO country codes
by their names, and a map (`{ cod: 'Pay on delivery' }`) gives each choice the product's own words. `x-ui.suggestions`
makes "pick one or type your own": a text is a `SuggestInput` (the suggestions as the browser's list), a list of texts
a `ChoicePicker` with `allowOwn` (what is typed in its search box is added). A list without choices is typed one item per line (a list of on/off values as JSON). Bounds
(`minimum`/`maximum`, `maxLength`) are shown on the inputs (number limits, the character counter of a text area). The
product checks every value when it is saved, and its field errors are passed in `errors`. Settings marked in
`overridden` get a Reset link that calls `onReset(name)`.

## ListEditor (merchant lists)

`<ListEditor legend items onChange newItem renderItem nameOf? max? help? error? texts? />` is the one pattern for
every list a merchant (or the Owner) owns: rows they add, rename, reorder and remove (payment methods, contact
channels, claim kinds, units…). `renderItem(item, index, update)` draws a row's fields; the editor adds Move up, Move
down and Remove on each row (named with the row, `Move up: Email`), Add at the end until `max`, and the empty text.
`moveItem(list, from, to)` is its pure reorder.

Every fieldset of the kit (`RadioGroup`, `CheckboxGroup`, `ChoicePicker`, `ListEditor`) floats its legend full width
(`LEGEND_FLOW`) and clears what follows it (`LEGEND_CLEAR`): a browser draws a plain legend IN the fieldset's top border,
so the hairline between two rows of a `SettingList` ran through the legend. A new fieldset uses the same two classes.

## StatusBadge

`<StatusBadge status label? />` colors the statuses of PLAN.md 0.5.5: `active` green, `low_balance` and `grace` yellow,
`stopped` and `suspended` red, `missing` orange (needs setup), `pending` teal, `removed` gray; any other status is gray
unless listed in `display.js`. `StatusPill` is the one look of a state: `active`, `setup` (orange), `off`, `error`,
`warning`, `info`, `new` (pink) and `locked`.

## Dates and credits

One style for the Portal and every dashboard, in US English: `formatDate` gives `Oct 4, 2026` and `formatDateTime`
gives `Oct 4, 2026, 2:30 PM UTC` (UTC, so the server and the browser render the same text). With
`formatDateTime(value, { timeZone })` the same style shows another time zone with its short name
(`Oct 4, 2026, 10:30 AM EDT`), for the viewer's local time once the page runs. `formatCredits` gives `12.5 credits`.
On a product dashboard the picked website's Format `locale` sets how dates and numbers read (`DisplayLocale`,
`useDisplayLocale()`; `LocalTime`, the credits and `formatNumber` follow it: `en-GB` gives `4 Oct 2026, 14:30`, `de-DE`
gives `1.234,5`); the words stay US English, and the global tabs stay en-US.
`supportContact(support)` words the Portal's support contact channels in one line (`help@example.com (Email),
https://wa.me/15550100 (WhatsApp)`), or `support` without channels.
`humanize` reads a code as words (`low_balance` → `Low balance`, `api_key` → `API key`): status badges and the choices
of a settings form use it.

## Search result and share preview

`<SeoPreview title description url siteName? image? texts? />` shows a page as Google lists it (site name, breadcrumb
address, title, description) and as a share card (image at 1.91 : 1, domain, title, description). Widgets draw the
same part without React from `@ss/ui/seo-preview`: `seoPreview(document, input, { texts })` gives `{ node, update }`
and the widget adds `SEO_PREVIEW_CSS` to its CSS. Title and description are measured in pixels (a canvas in the
browser, else an estimate that knows Latin, accented, wide and combining characters), never counted in characters, so
it holds for any language and script; past Google's usual widths (`SERP_LIMITS`: title 600 px at 20 px Arial,
description 920 px at 14 px Arial) the text is cut at a word with an ellipsis and a "may be cut" warning shows. The
words are the caller's (`SEO_PREVIEW_TEXTS` holds the English defaults).

## Check

```sh
pnpm check   # format, lint, typecheck, vitest (jsdom) with coverage 90 % lines, 90 % functions, 85 % branches
```
