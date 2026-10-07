/** Import & export: CSV dry run and apply, export download, the import template columns. */
import { createElement as h } from 'react';
import { Callout, Card } from '@ss/ui';
import { dashboardContext } from '../../_lib/dashboard.js';
import { ExportButton } from '../_components/ExportButton.js';
import { ImportTool } from '../_components/ImportTool.js';
import { Shell, t } from '../_components/Shell.js';

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function ImportExport({ searchParams }) {
	const { website } = await searchParams;
	const context = await dashboardContext(typeof website === 'string' ? website : null);
	if (context.state !== 'ready') return h(Shell, { context, active: 'import' });
	const { settings, canWrite, websiteId } = context.data;
	if (!settings.enabled('import_export'))
		return h(Shell, { context, active: 'import' }, h(Callout, { tone: 'info' }, t('dashboard.import.disabled')));
	return h(
		Shell,
		{ context, active: 'import' },
		h(
			Card,
			{
				title: t('dashboard.import.title'),
				subtitle: t('dashboard.import.intro', {
					policy: settings.importing.conflict_policy,
					rows: settings.importing.max_rows,
				}),
			},
			h(ImportTool, { websiteId, canWrite }),
		),
		h(
			Card,
			{
				title: t('dashboard.export.title'),
				subtitle: t('dashboard.export.columns', { columns: settings.importing.columns.join(', ') }),
				// a signed link valid for five minutes (no session header needed for the download itself)
				actions: h(ExportButton, { websiteId }),
			},
			h('p', { className: 'text-sm text-muted' }, t('dashboard.export.help')),
		),
	);
}
