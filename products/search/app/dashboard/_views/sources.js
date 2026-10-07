/** Sources: Catalog events and API writes (on/off), crawled sources with their last run, "crawl now" and "crawl due sources". */
import { createElement as h } from 'react';
import { Badge, Card, EmptyState, KeyValueList } from '@ss/ui';
import { dashboardContext } from '../../_lib/dashboard.js';
import { ActionButton } from '../_components/ActionButton.js';
import { Shell, t } from '../_components/Shell.js';

/**
 * Whether a source is due (never crawled, in progress, or its next run time passed).
 * @param {{ status?: string | null, nextRunAt?: string | null } | null} crawl
 * @param {number} now
 */
const isDue = (crawl, now) => !crawl || crawl.status === 'running' || !crawl.nextRunAt || Date.parse(crawl.nextRunAt) <= now;

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function Sources({ searchParams }) {
	const { website } = await searchParams;
	const context = await dashboardContext(typeof website === 'string' ? website : null);
	if (context.state !== 'ready') return h(Shell, { context, active: 'sources' });
	const sources = await context.data.sources();
	const now = Date.now();
	const onOff = (/** @type {boolean} */ on) => t(on ? 'dashboard.settings.on' : 'dashboard.settings.off');
	return h(
		Shell,
		{ context, active: 'sources' },
		h(
			Card,
			{ title: t('dashboard.nav.sources'), subtitle: t('dashboard.sources.intro') },
			h(KeyValueList, {
				items: [
					{ label: t('dashboard.sources.catalog'), value: `${onOff(sources.catalog.enabled)} (${sources.catalog.type})` },
					{ label: t('dashboard.sources.api'), value: onOff(sources.api.enabled) },
				],
			}),
		),
		h(
			Card,
			{
				title: t('dashboard.sources.crawls'),
				actions:
					sources.items.length > 0 && context.data.canWrite
						? h(ActionButton, {
								path: '/v1/dashboard/crawl-due',
								label: t('dashboard.sources.crawl_due'),
								websiteId: context.data.websiteId,
							})
						: null,
			},
			sources.items.length === 0
				? h(EmptyState, { title: t('dashboard.sources.none'), compact: true })
				: h(
						'ul',
						{ className: 'space-y-4' },
						sources.items.map((/** @type {any} */ source) =>
							h(
								'li',
								{ key: source.key, className: 'space-y-2 border-t border-line pt-3' },
								h(
									'p',
									{ className: 'flex flex-wrap items-center gap-2' },
									h('span', { className: 'font-semibold' }, source.key),
									source.allowed
										? h(Badge, {
												tone: source.crawl?.status === 'failed' ? 'danger' : 'neutral',
												children: source.crawl?.status ?? t('dashboard.sources.never'),
											})
										: h(Badge, { tone: 'warning', children: t(`dashboard.sources.refused.${source.reason}`) }),
									source.allowed && isDue(source.crawl, now)
										? h(Badge, { tone: 'info', children: t('dashboard.sources.due') })
										: null,
									source.url ? h('span', { className: 'text-sm text-muted' }, `${source.kind} · ${source.url}`) : null,
								),
								source.crawl
									? h(
											'p',
											{ className: 'text-sm text-muted' },
											t('dashboard.sources.progress', {
												processed: source.crawl.processed,
												total: source.crawl.total,
												indexed: source.crawl.indexed,
												failed: source.crawl.failed,
												removed: source.crawl.removed,
											}),
											source.crawl.error ? ` · ${source.crawl.error}` : '',
											source.crawl.nextRunAt
												? ` · ${t('dashboard.sources.next', { at: source.crawl.nextRunAt.slice(0, 16).replace('T', ' ') })}`
												: '',
										)
									: null,
								source.allowed && context.data.canWrite
									? h(ActionButton, {
											path: `/v1/dashboard/sources/${encodeURIComponent(source.key)}/crawl`,
											label: t(
												source.crawl?.status === 'running' ? 'dashboard.sources.continue' : 'dashboard.sources.crawl',
											),
											websiteId: context.data.websiteId,
										})
									: null,
							),
						),
					),
		),
	);
}
