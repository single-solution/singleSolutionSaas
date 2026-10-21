/**
 * The screens that still draw what the kit-only guard (`kit-only.test.js`) refuses: a `DataTable`/`Table`, a closed
 * `Disclosure`, `PillTabs`, or a raw `<table>`, `<select>`, `<input>` or `<textarea>`. The list only shrinks: the jobs
 * K-3, K-4 and K-5 move these screens to `Page list` + `Row`, `Page sections` and the kit fields and delete each entry
 * as it is done, until the list is empty. Never add a file: build the screen from the kit instead.
 * @type {ReadonlyArray<{ file: string, uses: string[] }>}
 */
export const KIT_ONLY_TODO = [];
