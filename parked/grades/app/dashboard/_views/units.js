/**
 * Recent graded units (tier, score, report link) and inspections, with re-grading, report links and the clean-up of
 * stale photo slots for writers.
 */
import { createElement as h } from 'react';
import { Badge, Card, EmptyState, Table } from '@ss/ui';
import { dashboardContext } from '../../_lib/dashboard.js';
import { Shell, t } from '../_components/Shell.js';
import { SweepPhotos } from '../_components/SweepPhotos.js';
import { UnitActions } from '../_components/UnitActions.js';

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function Units({ searchParams }) {
	const { website } = await searchParams;
	const context = await dashboardContext(typeof website === 'string' ? website : null);
	if (context.state !== 'ready') return h(Shell, { context, active: 'units' });
	const { settings, canWrite, websiteId } = context.data;
	const [units, inspections] = await Promise.all([context.data.units(), context.data.inspections()]);
	const label = (/** @type {string | null} */ key) => (key ? (settings.index.get(key)?.label ?? key) : '—');
	const tiers = settings.tiers.map((tier) => ({ value: tier.key, label: tier.label }));
	return h(
		Shell,
		{ context, active: 'units' },
		h(
			Card,
			{ title: t('dashboard.nav.units') },
			units.length === 0
				? h(EmptyState, { title: t('dashboard.units.empty'), description: t('dashboard.units.empty_help'), compact: true })
				: h(Table, {
						caption: t('dashboard.nav.units'),
						rowKey: (/** @type {any} */ row) => row.id,
						rows: units,
						columns: [
							{
								key: 'serial',
								header: t('dashboard.units.serial'),
								rowHeader: true,
								render: (/** @type {any} */ row) => row.serial ?? row.id,
							},
							{ key: 'itemId', header: t('dashboard.units.item') },
							{ key: 'tier', header: t('dashboard.units.tier'), render: (/** @type {any} */ row) => label(row.tier) },
							{
								key: 'score',
								header: t('dashboard.units.score'),
								align: 'right',
								render: (/** @type {any} */ row) => (row.score === null ? '—' : String(row.score)),
							},
							{
								key: 'available',
								header: t('dashboard.units.available'),
								render: (/** @type {any} */ row) =>
									h(Badge, {
										tone: row.available ? 'success' : 'neutral',
										children: t(row.available ? 'dashboard.yes' : 'dashboard.no'),
									}),
							},
							{
								key: 'actions',
								header: t('dashboard.units.actions'),
								render: (/** @type {any} */ row) =>
									canWrite && websiteId
										? h(UnitActions, {
												unitId: row.id,
												websiteId,
												tier: row.tier,
												tiers,
												canLink: settings.enabled('inspection') && row.lastInspectionId !== null,
											})
										: null,
							},
						],
					}),
		),
		h(
			Card,
			{ title: t('dashboard.inspections.title') },
			inspections.length === 0
				? h(EmptyState, { title: t('dashboard.inspections.empty'), compact: true })
				: h(Table, {
						caption: t('dashboard.inspections.title'),
						rowKey: (/** @type {any} */ row) => row.id,
						rows: inspections,
						columns: [
							{ key: 'unitId', header: t('dashboard.inspections.unit'), rowHeader: true },
							{ key: 'checklist', header: t('dashboard.inspections.checklist') },
							{
								key: 'status',
								header: t('dashboard.inspections.status'),
								render: (/** @type {any} */ row) =>
									h(Badge, {
										tone: row.status === 'completed' ? 'success' : 'warning',
										children: t(`dashboard.inspections.${row.status}`),
									}),
							},
							{
								key: 'score',
								header: t('dashboard.units.score'),
								align: 'right',
								render: (/** @type {any} */ row) => (row.score === null ? '—' : String(row.score)),
							},
							{
								key: 'suggestedTier',
								header: t('dashboard.inspections.suggested'),
								render: (/** @type {any} */ row) => label(row.suggestedTier),
							},
							{ key: 'tier', header: t('dashboard.units.tier'), render: (/** @type {any} */ row) => label(row.tier) },
						],
					}),
			canWrite && websiteId && settings.enabled('inspection') ? h(SweepPhotos, { websiteId }) : null,
		),
	);
}
