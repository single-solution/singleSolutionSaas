/** Analytics: searches, zero-result rate and click rate; top queries and zero-result queries (aggregated counts only). */
import { createElement as h } from 'react';
import { Callout, Card, EmptyState, Stat } from '@ss/ui';
import { dashboardContext } from '../../_lib/dashboard.js';
import { Shell, t } from '../_components/Shell.js';

export const dynamic = 'force-dynamic';

/**
 * @param {string} title
 * @param {Array<{ q: string, searches: number, zero: number, clicks: number }>} rows
 * @param {Intl.NumberFormat} format
 */
const queryTable = (title, rows, format) =>
	h(
		Card,
		{ title },
		rows.length === 0
			? h(EmptyState, { title: t('dashboard.analytics.empty'), compact: true })
			: h(
					'table',
					{ className: 'w-full text-sm' },
					h('caption', { className: 'sr-only' }, title),
					h(
						'thead',
						null,
						h(
							'tr',
							{ className: 'text-left text-muted' },
							[
								'dashboard.analytics.query',
								'dashboard.analytics.searches',
								'dashboard.analytics.zero',
								'dashboard.analytics.clicks',
							].map((key) => h('th', { key, scope: 'col', className: 'py-2' }, t(key))),
						),
					),
					h(
						'tbody',
						null,
						rows.map((row) =>
							h(
								'tr',
								{ key: row.q, className: 'border-t border-line' },
								h('td', { className: 'py-2' }, row.q),
								h('td', null, format.format(row.searches)),
								h('td', null, format.format(row.zero)),
								h('td', null, format.format(row.clicks)),
							),
						),
					),
				),
	);

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function Analytics({ searchParams }) {
	const { website, days } = await searchParams;
	const context = await dashboardContext(typeof website === 'string' ? website : null);
	if (context.state !== 'ready') return h(Shell, { context, active: 'analytics' });
	const span = Math.max(1, Math.min(400, Number.parseInt(typeof days === 'string' ? days : '30', 10) || 30));
	const report = await context.data.analytics(span);
	if (!report)
		return h(Shell, { context, active: 'analytics' }, h(Callout, { tone: 'info' }, t('dashboard.analytics.disabled')));
	const format = new Intl.NumberFormat(t('dashboard.locale'));
	const percent = new Intl.NumberFormat(t('dashboard.locale'), { style: 'percent', maximumFractionDigits: 1 });
	return h(
		Shell,
		{ context, active: 'analytics' },
		h('p', { className: 'text-sm text-muted' }, t('dashboard.analytics.window', { days: report.days, from: report.from })),
		h(
			'div',
			{ className: 'grid grid-cols-2 gap-4 sm:grid-cols-4' },
			h(Stat, { label: t('dashboard.analytics.searches'), value: format.format(report.totals.searches) }),
			h(Stat, { label: t('dashboard.analytics.zero_rate'), value: percent.format(report.totals.zeroRate) }),
			h(Stat, { label: t('dashboard.analytics.clicks'), value: format.format(report.totals.clicks) }),
			h(Stat, { label: t('dashboard.analytics.click_rate'), value: percent.format(report.totals.clickRate) }),
		),
		queryTable(t('dashboard.analytics.zero_queries'), report.zeroResults, format),
		queryTable(t('dashboard.analytics.top_queries'), report.top, format),
		h('p', { className: 'text-xs text-muted' }, t('dashboard.analytics.privacy')),
	);
}
