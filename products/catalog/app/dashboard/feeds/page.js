/** Feeds: the feeds configured in the settings with their tokened public URLs (treat them like passwords). */
import { createElement as h } from 'react';
import { Callout, Card, CodeBlock, EmptyState } from '@ss/ui';
import { dashboardContext } from '../../_lib/dashboard.js';
import { Shell, t } from '../_components/Shell.js';

export const dynamic = 'force-dynamic';

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function Feeds({ searchParams }) {
	const { website } = await searchParams;
	const context = await dashboardContext(typeof website === 'string' ? website : null);
	if (context.state !== 'ready') return h(Shell, { context, active: 'feeds' });
	if (!context.data.settings.enabled('feeds'))
		return h(Shell, { context, active: 'feeds' }, h(Callout, { tone: 'info' }, t('dashboard.feeds.disabled')));
	const feeds = await context.data.feeds();
	return h(
		Shell,
		{ context, active: 'feeds' },
		h(
			Card,
			{
				title: t('dashboard.nav.feeds'),
				subtitle: t('dashboard.feeds.intro', { seconds: context.data.settings.feeds.cache_seconds }),
			},
			feeds.length === 0
				? h(EmptyState, { title: t('dashboard.feeds.empty'), compact: true })
				: h(
						'ul',
						{ className: 'space-y-4' },
						feeds.map((feed) =>
							h(
								'li',
								{ key: feed.key },
								h('p', { className: 'font-semibold' }, `${feed.name} (${feed.format})`),
								h(CodeBlock, { code: feed.url, label: t('dashboard.feeds.url') }),
								feed.invalidSources.length > 0
									? h(
											Callout,
											{ tone: 'warning' },
											t('dashboard.feeds.invalid', { sources: feed.invalidSources.join(', ') }),
										)
									: null,
							),
						),
					),
		),
	);
}
