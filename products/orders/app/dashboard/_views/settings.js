/** Settings live in the Portal (the product never stores merchant configuration): a summary and a link to configure. */
import { createElement as h } from 'react';
import { ButtonLink, Card, KeyValueList } from '@ss/ui';
import { ELEMENTS } from '../../../api/settings.js';
import { dashboardContext } from '../../_lib/dashboard.js';
import { Shell, t } from '../_components/Shell.js';

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function Settings({ searchParams }) {
	const { website } = await searchParams;
	const context = await dashboardContext(typeof website === 'string' ? website : null);
	if (context.state !== 'ready') return h(Shell, { context, active: 'settings' });
	const { settings, labels } = context.data;
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
						label: t('dashboard.settings.statuses'),
						value: settings.matrix.statuses.map((s) => labels.statusLabel(s.key)).join(', '),
					},
					{ label: t('dashboard.settings.transitions'), value: String(settings.matrix.transitions.length) },
					{ label: t('dashboard.settings.carriers'), value: settings.carriers.map((c) => c.name).join(', ') || '—' },
					{
						label: t('dashboard.settings.methods'),
						value: settings.methods.map((m) => labels.methodLabel(m.key)).join(', '),
					},
					{ label: t('dashboard.settings.mappings'), value: settings.mappings.map((m) => m.key).join(', ') || '—' },
					...ELEMENTS.map((key) => ({
						label: key,
						value: t(settings.enabled(key) ? 'dashboard.settings.on' : 'dashboard.settings.off'),
					})),
				],
			}),
		),
	);
}
