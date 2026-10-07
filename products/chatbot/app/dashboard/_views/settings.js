/** Settings (SSO): configuration lives in the Portal (signed entitlement); this page links to it and shows the AI connector state. */
import { createElement as h } from 'react';
import { ButtonLink, Callout, Card } from '@ss/ui';
import { dashboardContext } from '../../_lib/dashboard.js';
import { Shell, t } from '../_components/Shell.js';

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function Settings({ searchParams }) {
	const { website } = await searchParams;
	const context = await dashboardContext(typeof website === 'string' ? website : null);
	if (context.state !== 'ready') return h(Shell, { context, active: 'settings' });
	return h(
		Shell,
		{ context, active: 'settings' },
		h(
			Card,
			{ title: t('dashboard.nav.settings') },
			h('p', { className: 'text-muted' }, t('dashboard.settings.text')),
			context.portalLink ? h(ButtonLink, { href: context.portalLink, className: 'mt-4' }, t('dashboard.settings.open')) : null,
		),
		h(
			Card,
			{ title: t('dashboard.settings.ai') },
			h(
				Callout,
				{ tone: context.aiConnected ? 'success' : 'warning' },
				t(context.aiConnected ? 'dashboard.settings.ai_connected' : 'dashboard.settings.ai_missing'),
			),
		),
	);
}
