# Theme pack: Unite (Shelfway)

**Status:** binding. One visual kit for the whole product surface.

| Surface                   | What loads the pack                                                            |
| ------------------------- | ------------------------------------------------------------------------------ |
| Portal marketing `/`      | `platform/app/globals.css` → `@ss/ui/theme.css`; `site.css` = composition only |
| Portal console / Docs hub | same `globals.css` + kit (`AppShell`, `Page`, …)                               |
| Product dashboards        | each `products/*/app/globals.css` → `@ss/ui/theme.css` + kit                   |
| Widget admin CSS          | `@ss/app-kit` admin/controls CSS aliases Unite `--ss-*` fallbacks              |

## Rules

1. **Unite is the only theme pack.** Do not ship a second marketing palette, product-specific colors, or a parallel type kit.
2. **Tokens and universal kit styles live in** `packages/ui/src/theme.css` (`--ss-*`, `@theme inline`, and core utilities `.wash`, `.grid-hard`, `.signal`, `.glass`, `.hard`, `.eyebrow`, `.accent`). Light / dark via `data-theme` or system preference (`theme.js` / `ThemeScript`).
3. **Marketing home and custom views** (`platform/app/(site)/site.css`, etc.) are for layout, spacing, and page composition only. Every color, radius, font, and surface must consume kit tokens (`--ss-canvas`, `--ss-fg`, `--ss-primary`, `--ss-glass`, `--radius-control`, etc.) and theme kit utilities directly — never define local alias layers or rogue hex values.
4. **New screens** use kit parts (`Page`, `Card`, `Button`, …) and token utilities (`bg-canvas`, `text-fg`, `rounded-control`, …). Do not hand-draw a different look “just for this page.”
5. **Product brand** = Shelfway. **Company** = Shelfway. Naming is copy, not a second theme.

## Why one pack

Strangers and staff should feel the same product whether they land on `/`, open Docs, sign in to Portal, or configure a product. Different layout jobs are fine; different visual systems are not.
