/** Settings live in the Portal (the product never stores merchant configuration): a summary and a link to configure. */
import { createElement as h } from 'react';
import { ButtonLink, Card, KeyValueList } from '@ss/ui';
import { ELEMENTS } from '../../../api/settings.js';
import { dashboardContext } from '../../_lib/dashboard.js';
import { Shell, t } from '../_components/Shell.js';

export const dynamic = 'force-dynamic';

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function Settings({ searchParams }) {
	const { website } = await searchParams;
	const context = await dashboardContext(typeof website === 'string' ? website : null);
	if (context.state !== 'ready') return h(Shell, { context, active: 'settings' });
	const { settings } = context.data;
	const types = [...settings.types.values()];
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
					{ label: t('dashboard.settings.engine'), value: settings.index.engine },
					{
						label: t('dashboard.settings.types'),
						value: types.map((type) => `${type.label} (${type.fields.length})`).join(', '),
					},
					{
						label: t('dashboard.settings.private'),
						value:
							types
								.flatMap((type) =>
									type.fields.filter((field) => field.private).map((field) => `${type.key}.${field.key}`),
								)
								.join(', ') || '—',
					},
					{ label: t('dashboard.settings.match_mode'), value: settings.rank.mode },
					{ label: t('dashboard.settings.synonyms'), value: String(settings.ranking.synonyms.length) },
					{ label: t('dashboard.settings.pinned'), value: String(settings.ranking.pinned.length) },
					...ELEMENTS.map((key) => ({
						label: key,
						value: t(settings.enabled(key) ? 'dashboard.settings.on' : 'dashboard.settings.off'),
					})),
				],
			}),
		),
	);
}
