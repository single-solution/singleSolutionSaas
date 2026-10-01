/**
 * Identity issuer: what to register in the Portal (Website → Identity) so every other product accepts this website's
 * customer tokens, and whether the signed entitlement document already carries it.
 */
import { createElement as h } from 'react';
import { Callout, Card } from '@ss/ui';
import { dashboardContext } from '../../_lib/dashboard.js';
import { Shell, t } from '../_components/Shell.js';

export const dynamic = 'force-dynamic';

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function Identity({ searchParams }) {
	const { website } = await searchParams;
	const context = await dashboardContext(typeof website === 'string' ? website : null);
	if (context.state !== 'ready') return h(Shell, { context, active: 'identity' });
	const issuer = await context.data.issuer();
	const row = (/** @type {string} */ label, /** @type {string} */ value) =>
		h(
			'div',
			{ key: label, className: 'grid gap-1 sm:grid-cols-[12rem_1fr]' },
			h('dt', { className: 'text-sm text-muted' }, label),
			h('dd', { className: 'break-all font-mono text-sm' }, value),
		);
	return h(
		Shell,
		{ context, active: 'identity' },
		h(
			Callout,
			{ tone: issuer.registered ? 'success' : 'warning' },
			t(issuer.registered ? 'dashboard.identity.registered' : 'dashboard.identity.not_registered'),
		),
		h(
			Card,
			{ title: t('dashboard.nav.identity') },
			h('p', { className: 'mb-4 text-sm' }, t('dashboard.identity.intro')),
			h(
				'dl',
				{ className: 'space-y-2' },
				row(t('dashboard.identity.issuer'), issuer.issuer),
				row(t('dashboard.identity.jwks'), issuer.jwksUrl),
				row(t('dashboard.identity.audience'), issuer.audience),
			),
			h('p', { className: 'mt-4 text-sm' }, t('dashboard.identity.claims')),
			h('p', { className: 'mt-1 text-sm text-muted' }, t('dashboard.identity.keys', { count: issuer.keys.length })),
			context.portalLink
				? h(
						'p',
						{ className: 'mt-4' },
						h('a', { className: 'underline', href: context.portalLink }, t('dashboard.nav.identity')),
					)
				: null,
		),
	);
}
