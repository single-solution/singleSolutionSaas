/** Reconciliation: every payment and refund across orders in a period, with totals per currency. */
import { createElement as h } from 'react';
import { Card, EmptyState, KeyValueList } from '@ss/ui';
import { formatMoney } from '../../../core/money.js';
import { dashboardContext } from '../../_lib/dashboard.js';
import { Shell, t } from '../_components/Shell.js';

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function Ledger({ searchParams }) {
	const params = await searchParams;
	const context = await dashboardContext(typeof params.website === 'string' ? params.website : null);
	if (context.state !== 'ready') return h(Shell, { context, active: 'ledger' });
	const pick = (/** @type {string} */ key) => (typeof params[key] === 'string' ? String(params[key]) : undefined);
	const { items, totals } = await context.data.ledger({ from: pick('from'), to: pick('to'), kind: pick('kind') });
	const { labels } = context.data;
	return h(
		Shell,
		{ context, active: 'ledger' },
		h(
			Card,
			{ title: t('dashboard.nav.ledger') },
			h(KeyValueList, {
				items: Object.entries(totals).map(([currency, sums]) => ({
					label: currency,
					value: t('dashboard.ledger.totals', {
						payments: formatMoney(/** @type {any} */ (sums).payments, currency, labels.lang),
						refunds: formatMoney(/** @type {any} */ (sums).refunds, currency, labels.lang),
						net: formatMoney(/** @type {any} */ (sums).net, currency, labels.lang),
					}),
				})),
			}),
			items.length === 0
				? h(EmptyState, { title: t('dashboard.ledger.empty'), compact: true })
				: h(
						'ul',
						{ className: 'mt-4 space-y-1 text-sm' },
						items.map((e) =>
							h(
								'li',
								{ key: e.id },
								`${e.at.slice(0, 10)} · ${e.number} · ${e.kind === 'refund' ? '−' : '+'}${formatMoney(e.amount, e.currency, labels.lang)} · ${labels.methodLabel(e.method)} · ${e.reference ?? '—'}`,
							),
						),
					),
		),
	);
}
