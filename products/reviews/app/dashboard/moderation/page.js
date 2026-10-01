/** Moderation queue: pending reviews (or approved / rejected) with approve, reject (reason) and reply actions. */
import { createElement as h } from 'react';
import { Badge, Card, EmptyState, TabNav } from '@ss/ui';
import { dashboardContext } from '../../_lib/dashboard.js';
import { ModerationActions } from '../_components/ModerationActions.js';
import { Shell, t, withWebsite } from '../_components/Shell.js';

export const dynamic = 'force-dynamic';

const STATUSES = /** @type {const} */ (['pending', 'approved', 'rejected']);

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function Moderation({ searchParams }) {
	const { website, status } = await searchParams;
	const context = await dashboardContext(typeof website === 'string' ? website : null);
	if (context.state !== 'ready') return h(Shell, { context, active: 'moderation' });
	const current = STATUSES.find((s) => s === status) ?? 'pending';
	const reviews = await context.data.reviews(current);
	const moderation = context.data.settings.moderation;
	const link = (/** @type {string} */ s) => {
		const href = withWebsite(context, '/dashboard/moderation');
		return `${href}${href.includes('?') ? '&' : '?'}status=${s}`;
	};
	return h(
		Shell,
		{ context, active: 'moderation' },
		h(
			Card,
			{ title: t('dashboard.nav.moderation') },
			h(TabNav, {
				label: t('dashboard.nav.moderation'),
				current: link(current),
				items: STATUSES.map((s) => ({ label: t(`dashboard.status.${s}`), href: link(s) })),
			}),
			reviews.length === 0
				? h(EmptyState, { title: t('dashboard.moderation.empty'), compact: true })
				: h(
						'ul',
						{ className: 'mt-4 space-y-4' },
						reviews.map((review) =>
							h(
								'li',
								{ key: review.id, className: 'rounded-md border border-line p-4' },
								h(
									'div',
									{ className: 'flex flex-wrap items-center gap-2' },
									h('strong', null, `${review.rating} / ${review.scale}`),
									h('span', { className: 'text-muted' }, review.itemId),
									review.verifiedPurchase ? h(Badge, { tone: 'success', children: t('reviews.verified') }) : null,
									...review.moderation.flags.map((flag) => h(Badge, { key: flag, tone: 'warning', children: flag })),
								),
								review.title ? h('h3', { className: 'mt-2 font-semibold' }, review.title) : null,
								h('p', { className: 'mt-1 whitespace-pre-line' }, review.body ?? ''),
								h(
									'p',
									{ className: 'mt-1 text-sm text-muted' },
									`${review.author.name ?? t('reviews.author.anonymous')} · ${review.submittedAt.slice(0, 10)}`,
								),
								review.reply
									? h('p', { className: 'mt-2 text-sm' }, `${t('reviews.reply')}: ${review.reply.body}`)
									: null,
								context.data.canWrite && moderation
									? h(ModerationActions, {
											reviewId: review.id,
											websiteId: /** @type {string} */ (context.data.websiteId),
											status: review.status,
											reasons: moderation.rejection_reasons,
											replies: moderation.replies_enabled,
										})
									: null,
							),
						),
					),
		),
	);
}
