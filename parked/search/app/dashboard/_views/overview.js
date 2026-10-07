/**
 * Dashboard overview (SSO). The Portal sends the browser to app-kit's `GET /sso?launch=<jwt>`, which verifies the launch
 * (signature, issuer, audience, kind/scope, single use), stores a session and sets the HttpOnly `ss_session` cookie,
 * then redirects here. Shows the engine in use and the Atlas Search state — including the index definition to create
 * by hand when the database user may not create search indexes — documents against the limit, and today's quota.
 */
import { createElement as h } from 'react';
import { redirect } from 'next/navigation.js';
import { Badge, Callout, Card, CodeBlock, KeyValueList, Stat } from '@ss/ui';
import { dashboardContext } from '../../_lib/dashboard.js';
import { ActionButton } from '../_components/ActionButton.js';
import { Shell, t } from '../_components/Shell.js';

const TONES = /** @type {Record<string, 'success' | 'warning' | 'danger' | 'neutral' | 'info'>} */ ({
	ready: 'success',
	building: 'info',
	missing: 'warning',
	permission_denied: 'danger',
	failed: 'danger',
	unavailable: 'neutral',
	disabled: 'neutral',
	unknown: 'neutral',
});

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function Overview({ searchParams }) {
	const { launch, website } = await searchParams;
	if (typeof launch === 'string') redirect(`/sso?launch=${encodeURIComponent(launch)}`);
	const context = await dashboardContext(typeof website === 'string' ? website : null);
	if (context.state !== 'ready') return h(Shell, { context, active: 'overview' });
	const status = await context.data.status();
	const format = new Intl.NumberFormat(t('dashboard.locale'));
	const atlas = status.engine.atlas;
	const state = String(atlas.state);
	return h(
		Shell,
		{ context, active: 'overview' },
		h(
			'div',
			{ className: 'grid grid-cols-2 gap-4 sm:grid-cols-4' },
			h(Stat, {
				label: t('dashboard.kpi.documents'),
				value: `${format.format(status.documents.total)} / ${format.format(status.documents.limit)}`,
			}),
			h(Stat, { label: t('dashboard.kpi.terms'), value: format.format(status.vocabulary) }),
			h(Stat, {
				label: t('dashboard.kpi.quota'),
				value: `${format.format(status.quota.used)} / ${format.format(status.quota.perDay)}`,
			}),
			h(Stat, { label: t('dashboard.kpi.engine'), value: t(`dashboard.engine.${status.engine.active}`) }),
		),
		h(
			Card,
			{
				title: t('dashboard.engine.title'),
				subtitle: t('dashboard.engine.configured', { engine: status.engine.configured }),
				actions:
					context.data.canWrite && status.engine.configured !== 'portable'
						? h(ActionButton, {
								path: '/v1/dashboard/engine/check',
								label: t('dashboard.engine.check'),
								websiteId: context.data.websiteId,
							})
						: null,
			},
			h(
				'div',
				{ className: 'space-y-4' },
				h(
					'p',
					{ className: 'flex items-center gap-2' },
					h(Badge, { tone: TONES[state] ?? 'neutral', children: t(`dashboard.atlas.${state}`) }),
					atlas.checkedAt
						? h('span', { className: 'text-sm text-muted' }, t('dashboard.atlas.checked', { at: atlas.checkedAt }))
						: null,
				),
				h('p', { className: 'text-sm' }, t(`dashboard.atlas.help.${state}`)),
				'definition' in atlas && atlas.definition
					? h(
							Callout,
							{ tone: state === 'permission_denied' ? 'warning' : 'info', title: t('dashboard.atlas.manual') },
							h(CodeBlock, { code: JSON.stringify(atlas.definition, null, 2), label: t('dashboard.atlas.definition') }),
						)
					: null,
				h(KeyValueList, {
					items: Object.entries(status.documents.byType).map(([type, count]) => ({
						label: context.data.settings.types.get(type)?.label ?? type,
						value: format.format(Number(count)),
					})),
				}),
			),
		),
	);
}
