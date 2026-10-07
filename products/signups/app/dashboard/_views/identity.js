/**
 * Identity issuer: what to register in the Portal (Website → Identity) so every other product accepts this website's
 * customer tokens, whether the signed entitlement document already carries it, and the request Signups sent to the
 * Portal (pending until the merchant approves it) with a button to send it again.
 */
import { createElement as h } from 'react';
import { Callout, Card } from '@ss/ui';
import { dashboardContext } from '../../_lib/dashboard.js';
import { RegisterIssuer } from '../_components/RegisterIssuer.js';
import { Shell, t } from '../_components/Shell.js';

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function Identity({ searchParams }) {
	const { website } = await searchParams;
	const context = await dashboardContext(typeof website === 'string' ? website : null);
	if (context.state !== 'ready') return h(Shell, { context, active: 'identity' });
	const issuer = await context.data.issuer();
	const request = issuer.registered ? null : issuer.request;
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
		request
			? h(
					Callout,
					{ tone: 'info' },
					t(request.status === 'pending' ? 'dashboard.identity.requested' : 'dashboard.identity.requested_active', {
						at: request.requestedAt,
					}),
				)
			: null,
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
			!issuer.registered && !context.data.demo && context.data.websiteId
				? h(RegisterIssuer, { websiteId: context.data.websiteId })
				: null,
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
