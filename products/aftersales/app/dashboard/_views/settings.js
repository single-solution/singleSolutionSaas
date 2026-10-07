/** Settings live in the Portal (the product never stores merchant configuration): a summary and the configure link. */
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
	const on = (/** @type {any} */ key) => t(settings.enabled(key) ? 'dashboard.settings.on' : 'dashboard.settings.off');
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
					{
						label: t('dashboard.settings.types'),
						value: settings.vocabulary.types.map((type) => `${type.label} (${type.window_days})`).join(', '),
					},
					{ label: t('dashboard.settings.reasons'), value: String(settings.vocabulary.reasons.length) },
					{ label: t('dashboard.settings.statuses'), value: settings.vocabulary.statuses.map((s) => s.label).join(' · ') },
					{ label: t('dashboard.settings.window_start'), value: settings.claims.window_start_events.join(', ') },
					{ label: t('dashboard.settings.rules'), value: String(settings.claims.window_rules.length) },
					{
						label: t('dashboard.settings.guests'),
						value: t(settings.claims.guest_access ? 'dashboard.settings.on' : 'dashboard.settings.off'),
					},
					{ label: t('dashboard.settings.photos'), value: on('photos') },
					{ label: t('dashboard.settings.refunds'), value: on('refunds') },
					{ label: t('dashboard.settings.restock'), value: on('restock') },
					{ label: t('dashboard.settings.serials'), value: on('serial_registry') },
					{ label: t('dashboard.settings.messages'), value: on('messages') },
					{ label: t('dashboard.settings.time_zone'), value: settings.timeZone },
				],
			}),
		),
	);
}
