/** Knowledge (SSO): FAQ entries (add from here) and the configured web pages with their fetch state (refresh due ones). */
import { createElement as h } from 'react';
import { Card, StatusBadge } from '@ss/ui';
import { dashboardContext } from '../../_lib/dashboard.js';
import { EntryForm } from '../_components/EntryForm.js';
import { RefreshSources } from '../_components/RefreshSources.js';
import { Shell, t } from '../_components/Shell.js';

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function Knowledge({ searchParams }) {
	const { website } = await searchParams;
	const context = await dashboardContext(typeof website === 'string' ? website : null);
	if (context.state !== 'ready') return h(Shell, { context, active: 'knowledge' });
	const [entries, sources] = await Promise.all([context.data.entries(), context.data.sources()]);
	return h(
		Shell,
		{ context, active: 'knowledge' },
		h(
			Card,
			{ title: t('dashboard.nav.knowledge') },
			entries.length === 0
				? h('p', { className: 'text-muted' }, t('dashboard.knowledge.empty'))
				: h(
						'dl',
						{ className: 'space-y-3' },
						entries.map((entry) =>
							h(
								'div',
								{ key: entry.id },
								h('dt', { className: 'font-semibold text-fg' }, entry.question),
								h('dd', { className: 'text-muted' }, entry.answer),
							),
						),
					),
			context.data.canWrite ? h(EntryForm, { websiteId: context.data.websiteId }) : null,
		),
		h(
			Card,
			{ title: t('dashboard.knowledge.sources') },
			h(
				'ul',
				{ className: 'divide-y divide-line' },
				sources.map((source) =>
					h(
						'li',
						{ key: source.id, className: 'flex items-center justify-between gap-3 py-2' },
						h('span', { className: 'truncate' }, source.title ?? source.url),
						h(StatusBadge, {
							status: source.status === 'ok' ? 'active' : source.status === 'failed' ? 'error' : 'pending',
							label: `${source.status} · ${source.chunks}`,
						}),
					),
				),
			),
			context.data.canWrite && sources.length > 0 ? h(RefreshSources, { websiteId: context.data.websiteId }) : null,
		),
	);
}
