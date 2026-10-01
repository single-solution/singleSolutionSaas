/** Customers (newest first), searchable by e-mail, with verification badges. */
import { createElement as h } from 'react';
import { Badge, Button, Card, EmptyState, Input } from '@ss/ui';
import { normaliseEmail } from '../../../core/email.js';
import { dashboardContext } from '../../_lib/dashboard.js';
import { Shell, t } from '../_components/Shell.js';

export const dynamic = 'force-dynamic';

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function Customers({ searchParams }) {
	const { website, q } = await searchParams;
	const context = await dashboardContext(typeof website === 'string' ? website : null);
	if (context.state !== 'ready') return h(Shell, { context, active: 'customers' });
	const query = typeof q === 'string' ? q.trim() : '';
	const email = query ? normaliseEmail(query) : null;
	const customers = await context.data.customers(email ? { email } : {});
	return h(
		Shell,
		{ context, active: 'customers' },
		h(
			Card,
			{ title: t('dashboard.nav.customers') },
			h(
				'form',
				{ method: 'get', role: 'search', className: 'mb-4 flex gap-2' },
				context.data.websiteId ? h('input', { type: 'hidden', name: 'website', value: context.data.websiteId }) : null,
				h(Input, {
					label: t('dashboard.customers.search'),
					hideLabel: true,
					name: 'q',
					defaultValue: query,
					placeholder: t('dashboard.customers.search'),
				}),
				h(Button, { type: 'submit', variant: 'secondary' }, t('dashboard.customers.search')),
			),
			customers.length === 0
				? h(EmptyState, { title: t('dashboard.customers.empty'), compact: true })
				: h(
						'table',
						{ className: 'w-full text-sm' },
						h(
							'thead',
							null,
							h(
								'tr',
								null,
								['Customer', t('account.profile.email'), t('account.profile.phone'), 'Created', 'Last sign-in'].map(
									(label) =>
										h(
											'th',
											{ key: label, scope: 'col', className: 'px-2 py-1 text-left text-xs uppercase text-muted' },
											label,
										),
								),
							),
						),
						h(
							'tbody',
							null,
							customers.map((customer) =>
								h(
									'tr',
									{ key: customer.id, className: 'border-t border-line' },
									h('td', { className: 'px-2 py-1 font-mono text-xs' }, customer.id),
									h(
										'td',
										{ className: 'px-2 py-1' },
										customer.email ?? '—',
										customer.verified.email === 'verified'
											? h(Badge, { tone: 'success', children: t('account.profile.verified') })
											: null,
									),
									h(
										'td',
										{ className: 'px-2 py-1' },
										customer.phone ?? '—',
										customer.verified.phone === 'verified'
											? h(Badge, { tone: 'success', children: t('account.profile.verified') })
											: null,
									),
									h('td', { className: 'px-2 py-1' }, (customer.createdAt ?? '').slice(0, 10)),
									h('td', { className: 'px-2 py-1' }, (customer.lastSignInAt ?? '—').slice(0, 10)),
								),
							),
						),
					),
		),
	);
}
