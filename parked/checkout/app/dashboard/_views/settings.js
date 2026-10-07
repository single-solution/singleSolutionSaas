/** Settings live in the Portal (link); this page summarises them and holds the integration key form. */
import { createElement as h } from 'react';
import { ButtonLink, Card, KeyValueList } from '@ss/ui';
import { dashboardContext } from '../../_lib/dashboard.js';
import { IntegrationKeyForm } from '../_components/IntegrationKeyForm.js';
import { Shell, t } from '../_components/Shell.js';

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function Settings({ searchParams }) {
	const { website } = await searchParams;
	const context = await dashboardContext(typeof website === 'string' ? website : null);
	if (context.state !== 'ready') return h(Shell, { context, active: 'settings' });
	const { settings } = context.data;
	const integrations = await context.data.integrations();
	const on = (/** @type {any} */ key) => (settings.enabled(key) ? 'on' : 'off');
	return h(
		Shell,
		{ context, active: 'settings' },
		h(
			Card,
			{
				title: t('dashboard.nav.settings'),
				subtitle: t('dashboard.settings.intro'),
				actions: context.portalLink
					? h(ButtonLink, { href: context.portalLink, variant: 'primary' }, t('dashboard.settings.open'))
					: null,
			},
			h(KeyValueList, {
				items: [
					{ label: 'Currency', value: settings.currency ?? '—' },
					{ label: 'Stock reservation', value: settings.place.stock_source },
					{ label: 'Bank transfer', value: `${on('payment_manual')} · ${settings.manual.bank_transfer_enabled}` },
					{ label: 'Cash on delivery', value: `${settings.manual.cod_enabled} · max ${settings.manual.cod_max_order}` },
					{ label: 'Payment proofs', value: on('payment_proofs') },
					{ label: 'Gateway (preview)', value: on('payment_gateway') },
					{
						label: 'Coupons / Deals / Loyalty / Catalog',
						value: `${integrations.coupons} / ${integrations.deals} / ${integrations.loyalty} / ${integrations.catalog}`,
					},
				],
			}),
		),
		context.data.canWrite && context.data.websiteId
			? h(
					Card,
					{ title: t('dashboard.settings.key') },
					h(IntegrationKeyForm, {
						websiteId: context.data.websiteId,
						current: /** @type {string | null} */ (integrations.key),
					}),
				)
			: null,
	);
}
