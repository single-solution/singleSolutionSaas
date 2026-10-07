/** Serial lookup for staff: the unit's sale, its cover per claim type and the claims raised for it. */
import { createElement as h } from 'react';
import { Callout, Card, KeyValueList } from '@ss/ui';
import { dashboardContext } from '../../_lib/dashboard.js';
import { Shell, t } from '../_components/Shell.js';

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function Serials({ searchParams }) {
	const { website, serial } = await searchParams;
	const context = await dashboardContext(typeof website === 'string' ? website : null);
	if (context.state !== 'ready') return h(Shell, { context, active: 'serials' });
	const enabled = context.data.settings.enabled('serial_registry');
	const query = typeof serial === 'string' ? serial.slice(0, 128) : '';
	const found = enabled && query ? await context.data.serial(query) : null;
	return h(
		Shell,
		{ context, active: 'serials' },
		h(
			Card,
			{ title: t('dashboard.nav.serials') },
			!enabled
				? h(Callout, { tone: 'info' }, t('dashboard.serials.off'))
				: h(
						'form',
						{ method: 'get', className: 'flex gap-2' },
						context.data.websiteId ? h('input', { type: 'hidden', name: 'website', value: context.data.websiteId }) : null,
						h('label', { htmlFor: 'serial', className: 'sr-only' }, t('serials.label')),
						h('input', {
							id: 'serial',
							name: 'serial',
							defaultValue: query,
							className: 'rounded-md border border-line px-2 py-1',
						}),
						h(
							'button',
							{ type: 'submit', className: 'rounded-md bg-primary px-3 py-1 text-on-primary' },
							t('serials.lookup'),
						),
					),
			query && enabled && !found ? h(Callout, { tone: 'warning' }, t('serials.not_found')) : null,
			found
				? h(KeyValueList, {
						items: [
							{ label: t('dashboard.serials.item'), value: found.title ?? found.itemId },
							{ label: t('dashboard.serials.order'), value: found.orderId ?? '—' },
							{ label: t('dashboard.serials.sold'), value: String(found.soldAt ?? '').slice(0, 10) },
							...Object.entries(found.cover).map(([type, state]) => ({
								label: type,
								value: /** @type {any} */ (state).eligible
									? t('dashboard.serials.until', { date: String(/** @type {any} */ (state).closesAt).slice(0, 10) })
									: t('dashboard.serials.no_cover'),
							})),
							{
								label: t('dashboard.serials.claims'),
								value:
									found.claims.map((/** @type {any} */ claim) => `${claim.reference} (${claim.status})`).join(', ') ||
									'—',
							},
						],
					})
				: null,
		),
	);
}
