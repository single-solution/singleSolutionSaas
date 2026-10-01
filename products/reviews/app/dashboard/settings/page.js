/** Settings live in the Portal (the product never stores merchant configuration): link to the subscription's configure page. */
import { createElement as h } from 'react';
import { ButtonLink, Card, KeyValueList } from '@ss/ui';
import { dashboardContext } from '../../_lib/dashboard.js';
import { Shell, t } from '../_components/Shell.js';

export const dynamic = 'force-dynamic';

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
					{ label: t('dashboard.settings.who'), value: settings.collection.who },
					{ label: t('dashboard.settings.delay'), value: String(settings.collection.request_delay_hours) },
					{ label: t('dashboard.settings.scale'), value: String(settings.content.rating_scale) },
					{ label: t('dashboard.settings.rules'), value: String(settings.moderation?.rules.length ?? 0) },
					{ label: t('dashboard.settings.request_flow'), value: on('request_flow') },
					{ label: t('dashboard.settings.photos'), value: on('photos') },
					{ label: t('dashboard.settings.qna'), value: on('qna') },
					{ label: t('dashboard.settings.time_zone'), value: settings.timeZone },
				],
			}),
		),
	);
}
