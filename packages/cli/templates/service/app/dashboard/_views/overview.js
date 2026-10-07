/**
 * Dashboard (SSO). The Portal sends the browser to app-kit's `GET /sso?launch=<jwt>`, which verifies the launch
 * (signature, issuer, audience, kind/scope, single use), stores a session and sets the HttpOnly `ss_session` cookie,
 * then redirects here. Supports merchant, demo, admin(scope), impersonate, partner and developer launches;
 * impersonation shows the audit banner and ends at the launch's `impExp`.
 */
import { createElement as h } from 'react';
import { cookies } from 'next/headers.js';
import { redirect } from 'next/navigation.js';
import { createTranslator } from '../../../headless/strings.js';
import { sessionView } from '../../../api/session.js';
import { getProduct, getStrings } from '../../_lib/product.js';

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function Dashboard({ searchParams }) {
	const { launch } = await searchParams;
	if (typeof launch === 'string') redirect(`/sso?launch=${encodeURIComponent(launch)}`);
	const t = createTranslator((await getStrings()).en ?? {});
	const product = await getProduct();
	const session = await product.launch.session((await cookies()).get('ss_session')?.value);
	if (!session) return h('main', { className: 'ss-dashboard' }, h('p', { role: 'alert' }, t('dashboard.launch_required')));
	const view = sessionView(session);
	return h(
		'main',
		{ className: 'ss-dashboard' },
		view.actor
			? h('div', { role: 'status', className: 'ss-dashboard__audit' }, t('dashboard.audit_banner', { actor: view.actor }))
			: null,
		h('h1', null, t('dashboard.title', { name: '{{name}}' })),
		h('p', null, t('dashboard.signed_in_as', { user: session.user?.email ?? view.user ?? '—', role: view.role })),
		h('p', null, t('dashboard.scope', { scope: JSON.stringify(view.scope) })),
	);
}
