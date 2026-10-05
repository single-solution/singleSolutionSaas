/** One configurator: groups and options, rules, combinations, a live preview (the real resolver and pricer) and the editor. */
import { createElement as h } from 'react';
import { Badge, Callout, Card, KeyValueList } from '@ss/ui';
import { dashboardContext } from '../../../_lib/dashboard.js';
import { Shell, t } from '../../_components/Shell.js';
import { Editor } from '../../_components/Editor.js';
import { Playground } from '../../_components/Playground.js';

export const dynamic = 'force-dynamic';

/** @param {{ params: Promise<{ id: string }>, searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function ConfiguratorPage({ params, searchParams }) {
	const { id } = await params;
	const { website } = await searchParams;
	const context = await dashboardContext(typeof website === 'string' ? website : null);
	if (context.state !== 'ready') return h(Shell, { context, active: 'overview' });
	const found = await context.data.get(decodeURIComponent(id));
	if (!found)
		return h(Shell, { context, active: 'overview' }, h(Callout, { tone: 'warning' }, t('dashboard.configurator.not_found')));
	const { record, preview, problem } = found;
	const { schema } = record;
	const { settings } = context.data;
	return h(
		Shell,
		{ context, active: 'overview' },
		h(
			Card,
			{ title: record.name, subtitle: schema.description ?? undefined },
			h(KeyValueList, {
				items: [
					{ label: t('dashboard.column.status'), value: h(Badge, { children: t(`dashboard.status.${record.status}`) }) },
					{ label: t('dashboard.column.key'), value: record.key ?? '—' },
					{ label: t('dashboard.column.version'), value: String(record.version) },
					{
						label: t('dashboard.configurator.source'),
						value:
							schema.source.type === 'catalog'
								? t('dashboard.configurator.linked', { item: schema.source.itemId })
								: t('dashboard.configurator.standalone'),
					},
					{ label: t('dashboard.configurator.rules'), value: String(schema.rules.length) },
					{
						label: t('dashboard.configurator.combinations'),
						value: String(preview?.schema.combinations.length ?? schema.combinations.length),
					},
				],
			}),
		),
		h(
			Card,
			{ title: t('dashboard.configurator.groups') },
			h(
				'ul',
				{ className: 'space-y-2 text-sm' },
				schema.groups.map((group) =>
					h(
						'li',
						{ key: group.key },
						h('span', { className: 'font-semibold' }, group.label),
						' ',
						h(
							'span',
							{ className: 'font-mono text-muted' },
							`${group.key} · ${t(`dashboard.type.${group.type}`)}${group.required ? ` · ${t('dashboard.configurator.required')}` : ''}`,
						),
						group.options.length > 0
							? h(
									'div',
									{ className: 'text-muted' },
									group.options.map((option) => option.label).join(t('widget.list.separator')),
								)
							: null,
						group.when
							? h(
									'div',
									{ className: 'font-mono text-xs text-muted' },
									t('dashboard.configurator.when', { when: group.when }),
								)
							: null,
					),
				),
			),
			schema.rules.length > 0
				? h(
						'ul',
						{ className: 'mt-4 space-y-1 text-sm' },
						schema.rules.map((rule) =>
							h(
								'li',
								{ key: rule.id, className: 'font-mono' },
								`${rule.id}: ${rule.when}${rule.message ? ` — ${rule.message}` : ''}`,
							),
						),
					)
				: null,
		),
		problem ? h(Callout, { tone: 'warning' }, t(`dashboard.problem.${problem}`)) : null,
		preview
			? h(
					Card,
					{ title: t('dashboard.preview.title'), subtitle: t('dashboard.preview.intro') },
					h(Playground, {
						configurator: preview,
						resolver: {
							in_stock: settings.resolver.inStock,
							tie_break: settings.resolver.tieBreak,
							partial: settings.resolver.partial,
							fallback: settings.resolver.fallback,
						},
						pricing: {
							rounding_mode: settings.rounding.mode,
							rounding_increment: settings.rounding.increment,
							rounding_ending: settings.rounding.ending,
						},
						currency: settings.website.currency,
						showPrice: settings.enabled('price_deltas'),
					}),
				)
			: null,
		context.data.canWrite && context.data.websiteId && record.status !== 'archived'
			? h(
					Card,
					{ title: t('dashboard.editor.title'), subtitle: t('dashboard.editor.intro') },
					h(Editor, { websiteId: context.data.websiteId, record }),
				)
			: null,
	);
}
