/**
 * Dashboard frame (server component): title, navigation and the signed-in line. Pages render inside it; states without data (sign in, pick a website) render a callout instead.
 */
import { createElement as h } from 'react';
import { Callout, ThemeToggle } from '@ss/ui';
import { createTranslator } from '../../../headless/strings.js';
import { sessionView } from '../../../api/session.js';
import en from '../../../strings/en.json' with { type: 'json' };

export const t = createTranslator(en);

const NAV = Object.freeze([
	{ key: 'overview', href: '/dashboard', label: 'dashboard.nav.overview' },
	{ key: 'rules', href: '/dashboard/rules', label: 'dashboard.nav.rules' },
	{ key: 'members', href: '/dashboard/members', label: 'dashboard.nav.members' },
	{ key: 'settings', href: '/dashboard/settings', label: 'dashboard.nav.settings' },
]);

/**
 * @param {import('../../../api/dashboard.js').DashboardContext} context
 * @param {string} href
 */
export const withWebsite = (context, href) =>
	context.state === 'ready' && context.data.websiteId ? `${href}?website=${encodeURIComponent(context.data.websiteId)}` : href;

/**
 * @param {{ context: import('../../../api/dashboard.js').DashboardContext, active: string, children?: import('react').ReactNode }} props
 */
export function Shell({ context, active, children }) {
	if (context.state === 'signin')
		return h(
			'main',
			{ className: 'mx-auto max-w-3xl p-8' },
			h(Callout, { tone: 'warning', title: t('dashboard.title') }, t('dashboard.launch_required')),
		);
	const view = sessionView(/** @type {any} */ (context.session));
	const body =
		context.state === 'pick_website'
			? h(Callout, { tone: 'info' }, t('dashboard.pick_website'))
			: context.state === 'not_subscribed'
				? h(Callout, { tone: 'warning' }, t('dashboard.not_subscribed'))
				: children;
	return h(
		'div',
		{ className: 'mx-auto w-full max-w-[1600px] space-y-6 px-4 py-6 md:px-6 lg:px-8' },
		h(
			'header',
			{ className: 'flex flex-wrap items-center justify-between gap-3' },
			h('h1', { className: 'text-2xl font-extrabold text-fg' }, t('dashboard.title')),
			h(
				'div',
				{ className: 'flex flex-wrap items-center gap-3' },
				h('p', { className: 'text-sm text-muted' }, t('dashboard.signed_in_as', { user: view.user ?? '—', role: view.role })),
				h(ThemeToggle),
			),
		),
		h(
			'nav',
			{ 'aria-label': t('dashboard.title'), className: 'flex gap-2 border-b border-line pb-2' },
			NAV.map((item) =>
				h(
					'a',
					{
						key: item.key,
						href: withWebsite(context, item.href),
						'aria-current': item.key === active ? 'page' : undefined,
						className: `rounded-md px-3 py-1.5 text-sm font-semibold ${item.key === active ? 'bg-surface-2 text-fg' : 'text-muted hover:text-fg'}`,
					},
					t(item.label),
				),
			),
		),
		h('main', { className: 'space-y-6' }, body),
	);
}
