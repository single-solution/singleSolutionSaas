/** Settings live in the Portal (the product never stores merchant configuration): link to the subscription's configure page. */
import { createElement as h } from 'react';
import { ButtonLink, Card, KeyValueList } from '@ss/ui';
import { dashboardContext } from '../../_lib/dashboard.js';
import { Shell, t } from '../_components/Shell.js';

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function Settings({ searchParams }) {
	const { website } = await searchParams;
	const context = await dashboardContext(typeof website === 'string' ? website : null);
	if (context.state !== 'ready') return h(Shell, { context, active: 'settings' });
	const { settings } = context.data;
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
					{ label: 'Time zone', value: settings.timeZone },
					{ label: 'Earn rules', value: String(settings.rules.length) },
					{
						label: 'Redemption',
						value: `${on('redeem')} · max ${settings.redeem.max_share_percent}% · min ${settings.redeem.min_points}`,
					},
					{ label: 'Tiers', value: on('tiers') },
					{ label: 'Expiry', value: settings.expiry ? `${settings.expiry.months} months` : 'off' },
					{ label: 'Referrals', value: on('referrals') },
					{ label: 'Adjustments', value: on('adjustments') },
					{ label: 'Reversal', value: on('reversal') },
				],
			}),
		),
	);
}
