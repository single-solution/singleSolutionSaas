/**
 * The tier ladder with warranty periods, and the mapping table (tier × vocabulary) with its problems (values outside a
 * vocabulary's allowed list, tiers without a value). Settings are edited in the Portal; this page shows their effect.
 */
import { createElement as h } from 'react';
import { Badge, Callout, Card, Table } from '@ss/ui';
import { readableValue } from '../../../core/mapping.js';
import { translator } from '../../../core/text.js';
import { warrantyTerms } from '../../../core/warranty.js';
import en from '../../../strings/en.json' with { type: 'json' };
import { dashboardContext } from '../../_lib/dashboard.js';
import { Shell, swatch, t } from '../_components/Shell.js';

export const dynamic = 'force-dynamic';

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function Tiers({ searchParams }) {
	const { website } = await searchParams;
	const context = await dashboardContext(typeof website === 'string' ? website : null);
	if (context.state !== 'ready') return h(Shell, { context, active: 'tiers' });
	const { settings, mappingProblems } = context.data;
	const terms = new Map(
		warrantyTerms({ tiers: settings.tiers, config: settings.warranty, t: translator(en) }).map((term) => [term.tier, term]),
	);
	return h(
		Shell,
		{ context, active: 'tiers' },
		h(
			Card,
			{ title: t('dashboard.nav.tiers'), subtitle: t('dashboard.tiers.intro') },
			h(Table, {
				caption: t('dashboard.nav.tiers'),
				rowKey: (/** @type {any} */ row) => row.key,
				rows: [...settings.tiers],
				columns: [
					{
						key: 'label',
						header: t('dashboard.tiers.label'),
						rowHeader: true,
						render: (/** @type {any} */ row) =>
							h('span', { className: 'inline-flex items-center gap-2' }, swatch(row), row.label),
					},
					{ key: 'key', header: t('dashboard.tiers.key') },
					{ key: 'order', header: t('dashboard.tiers.order'), align: 'right' },
					{
						key: 'active',
						header: t('dashboard.tiers.status'),
						render: (/** @type {any} */ row) =>
							h(Badge, {
								tone: row.active ? 'success' : 'neutral',
								children: t(row.active ? 'dashboard.tiers.shown' : 'dashboard.tiers.hidden'),
							}),
					},
					{
						key: 'warranty',
						header: t('dashboard.tiers.warranty'),
						render: (/** @type {any} */ row) =>
							settings.enabled('warranty') ? (terms.get(row.key)?.periodText ?? '—') : '—',
					},
					{ key: 'description', header: t('dashboard.tiers.notes') },
				],
			}),
		),
		h(
			Card,
			{ title: t('dashboard.mapping.title'), subtitle: t('dashboard.mapping.intro') },
			mappingProblems.length > 0
				? h(
						Callout,
						{ tone: 'warning', title: t('dashboard.mapping.problems', { count: mappingProblems.length }) },
						h(
							'ul',
							{ className: 'list-disc pl-5' },
							mappingProblems.map((row) =>
								h(
									'li',
									{ key: `${row.vocabulary}:${row.tier}` },
									t(`dashboard.mapping.problem.${row.problem}`, { vocabulary: row.vocabulary, tier: row.tier }),
								),
							),
						),
					)
				: null,
			h(Table, {
				caption: t('dashboard.mapping.title'),
				rowKey: (/** @type {any} */ row) => row.key,
				rows: [...settings.tiers],
				columns: [
					{ key: 'label', header: t('dashboard.tiers.label'), rowHeader: true },
					...settings.vocabularies.map((vocabulary) => ({
						key: vocabulary.key,
						header: vocabulary.name,
						render: (/** @type {any} */ row) => {
							const value = vocabulary.byTier[row.key];
							return value ? readableValue(value) : '—';
						},
					})),
				],
			}),
		),
	);
}
