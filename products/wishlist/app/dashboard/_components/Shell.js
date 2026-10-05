/**
 * Dashboard frame (server component): title, navigation, the signed-in line and the standard banners — impersonation
 * (audit) and demo. Pages render inside it; states without data (sign in, pick a website) render a callout instead.
 */
import { createElement as h } from 'react';
import { Callout } from '@ss/ui';
import { createTranslator } from '../../../headless/strings.js';
import { sessionView } from '../../../api/session.js';
import en from '../../../strings/en.json' with { type: 'json' };

export const t = createTranslator(en);

const NAV = Object.freeze([
	{ key: 'overview', href: '/dashboard', label: 'dashboard.nav.overview' },
	{ key: 'lists', href: '/dashboard/lists', label: 'dashboard.nav.lists' },
	{ key: 'notifications', href: '/dashboard/notifications', label: 'dashboard.nav.notifications' },
]);

/**
 * @param {import('../../../api/dashboard.js').DashboardContext} context
 * @param {string} href
 */
export const withWebsite = (context, href) =>
	context.state === 'ready' && context.data.websiteId ? `${href}?website=${encodeURIComponent(context.data.websiteId)}` : href;

/**
 * A plain data table (server-rendered).
 * @param {{ columns: string[], rows: Array<{ key: string, cells: import('react').ReactNode[] }>, caption: string }} props
 */
export function DataTable({ columns, rows, caption }) {
	return h(
		'table',
		{ className: 'w-full text-sm' },
		h('caption', { className: 'sr-only' }, caption),
		h(
			'thead',
			null,
			h(
				'tr',
				null,
				columns.map((label) =>
					h('th', { key: label, scope: 'col', className: 'px-2 py-1 text-left text-xs uppercase text-muted' }, label),
				),
			),
		),
		h(
			'tbody',
			null,
			rows.map((row) =>
				h(
					'tr',
					{ key: row.key, className: 'border-t border-line' },
					row.cells.map((value, index) => h('td', { key: String(index), className: 'px-2 py-1' }, value)),
				),
			),
		),
	);
}

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
	const banners = [
		view.actor ? h(Callout, { key: 'audit', tone: 'warning' }, t('dashboard.audit_banner', { actor: view.actor })) : null,
		context.state === 'ready' && context.data.demo
			? h(Callout, { key: 'demo', tone: 'info' }, t('dashboard.demo_banner'))
			: null,
	];
	const body =
		context.state === 'pick_website'
			? h(Callout, { tone: 'info' }, t('dashboard.pick_website'))
			: context.state === 'not_subscribed'
				? h(Callout, { tone: 'warning' }, t('dashboard.not_subscribed'))
				: children;
	return h(
		'div',
		{ className: 'mx-auto max-w-5xl space-y-6 p-6' },
		h(
			'header',
			{ className: 'flex flex-wrap items-baseline justify-between gap-3' },
			h('h1', { className: 'text-2xl font-extrabold text-fg' }, t('dashboard.title')),
			h('p', { className: 'text-sm text-muted' }, t('dashboard.signed_in_as', { user: view.user ?? '—', role: view.role })),
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
		...banners,
		h('main', { className: 'space-y-6' }, body),
	);
}
