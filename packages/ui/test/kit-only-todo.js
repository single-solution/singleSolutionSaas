/**
 * The screens that still draw what the kit-only guard (`kit-only.test.js`) refuses: a `DataTable`/`Table`, a closed
 * `Disclosure`, `PillTabs`, or a raw `<table>`, `<select>`, `<input>` or `<textarea>`. The list only shrinks: the jobs
 * K-3, K-4 and K-5 move these screens to `Page list` + `Row`, `Page sections` and the kit fields and delete each entry
 * as it is done, until the list is empty. Never add a file: build the screen from the kit instead.
 * @type {ReadonlyArray<{ file: string, uses: string[] }>}
 */
export const KIT_ONLY_TODO = [
	{ file: 'platform/src/console/admin/views/admins.js', uses: ['DataTable'] },
	{ file: 'platform/src/console/admin/views/finance.js', uses: ['DataTable'] },
	{ file: 'platform/src/console/admin/views/merchants.js', uses: ['DataTable'] },
	{ file: 'platform/src/console/admin/views/overview.js', uses: ['DataTable'] },
	{ file: 'platform/src/console/admin/views/products.js', uses: ['DataTable'] },
	{ file: 'platform/src/console/admin/views/settings.js', uses: ['Disclosure'] },
	{ file: 'platform/src/console/views/billing.js', uses: ['Table'] },
	{ file: 'platform/src/console/views/credits.js', uses: ['DataTable'] },
	{ file: 'platform/src/console/views/login-settings.js', uses: ['DataTable'] },
	{ file: 'platform/src/console/views/range.js', uses: ['<input'] },
	{ file: 'platform/src/console/views/setup.js', uses: ['DataTable'] },
	{ file: 'platform/src/console/views/website-connections.js', uses: ['DataTable'] },
	{ file: 'platform/src/console/views/website-page.js', uses: ['DataTable'] },
	{ file: 'platform/src/console/views/website-settings-sections.js', uses: ['DataTable', 'Disclosure'] },
	{ file: 'platform/src/console/views/website-settings.js', uses: ['DataTable'] },
	{ file: 'platform/src/console/views/website.js', uses: ['DataTable'] },
	{ file: 'platform/src/console/views/websites.js', uses: ['DataTable'] },
];
