/** The claims queue: claims by status kind with their lines, evidence, history, notes and refunds, and the staff actions. */
import { createElement as h } from 'react';
import { Badge, Card, EmptyState, TabNav } from '@ss/ui';
import { dashboardContext } from '../../_lib/dashboard.js';
import { ClaimActions } from '../_components/ClaimActions.js';
import { Shell, t, withWebsite } from '../_components/Shell.js';

const KINDS = /** @type {const} */ (['open', 'resolved', 'rejected', 'closed']);

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function Queue({ searchParams }) {
	const { website, kind } = await searchParams;
	const context = await dashboardContext(typeof website === 'string' ? website : null);
	if (context.state !== 'ready') return h(Shell, { context, active: 'queue' });
	const current = KINDS.find((k) => k === kind) ?? 'open';
	const { settings } = context.data;
	const statuses = settings.vocabulary.statuses.filter((status) => status.kind === current).map((status) => status.key);
	const claims = await context.data.claims(statuses);
	const link = (/** @type {string} */ k) => {
		const href = withWebsite(context, '/dashboard/queue');
		return `${href}${href.includes('?') ? '&' : '?'}kind=${k}`;
	};
	return h(
		Shell,
		{ context, active: 'queue' },
		h(
			Card,
			{ title: t('dashboard.nav.queue') },
			h(TabNav, {
				label: t('dashboard.nav.queue'),
				current: link(current),
				items: KINDS.map((k) => ({ label: t(`dashboard.kind.${k}`), href: link(k) })),
			}),
			claims.length === 0
				? h(EmptyState, { title: t('dashboard.queue.empty'), compact: true })
				: h(
						'ul',
						{ className: 'mt-4 space-y-4' },
						claims.map((claim) =>
							h(
								'li',
								{ key: claim.id, className: 'rounded-md border border-line p-4' },
								h(
									'div',
									{ className: 'flex flex-wrap items-center gap-2' },
									h('strong', null, `${claim.reference} · ${claim.typeLabel}`),
									h(Badge, { tone: claim.kind === 'open' ? 'info' : 'neutral', children: claim.statusLabel }),
									claim.overdue ? h(Badge, { tone: 'warning', children: t('dashboard.queue.overdue') }) : null,
									h(
										'span',
										{ className: 'text-sm text-muted' },
										`${claim.reasonLabel} · ${claim.submittedAt.slice(0, 10)}`,
									),
								),
								claim.details ? h('p', { className: 'mt-2 whitespace-pre-line' }, claim.details) : null,
								h(
									'ul',
									{ className: 'mt-2 text-sm' },
									claim.lines.map((line) =>
										h(
											'li',
											{ key: line.lineId },
											t('dashboard.queue.line', {
												title: line.title ?? line.itemId,
												quantity: line.quantity,
												serial: line.serial ?? '—',
												restock:
													line.restock === null
														? '—'
														: t(line.restock ? 'dashboard.queue.restocked' : 'dashboard.queue.not_restocked'),
											}),
										),
									),
								),
								claim.photos.length > 0
									? h(
											'p',
											{ className: 'mt-2 flex gap-2 text-sm' },
											claim.photos.map((photo, index) =>
												photo.url
													? h(
															'a',
															{ key: photo.id, href: photo.url, target: '_blank', rel: 'noreferrer' },
															t('dashboard.queue.photo', { n: index + 1 }),
														)
													: null,
											),
										)
									: null,
								h(
									'details',
									{ className: 'mt-2 text-sm' },
									h('summary', null, t('dashboard.queue.history')),
									h(
										'ol',
										null,
										claim.history.map((entry, index) =>
											h(
												'li',
												{ key: index },
												`${entry.at.slice(0, 16).replace('T', ' ')} · ${entry.to}${entry.note ? ` · ${entry.note}` : ''}`,
											),
										),
									),
									claim.notes.length > 0
										? h(
												'ul',
												null,
												claim.notes.map((/** @type {any} */ note) =>
													h('li', { key: note.id }, `${t('dashboard.queue.note')}: ${note.body}`),
												),
											)
										: null,
									claim.refunds.length > 0
										? h(
												'ul',
												null,
												claim.refunds.map((/** @type {any} */ refund) =>
													h(
														'li',
														{ key: refund.id },
														t('dashboard.queue.refund', {
															amount: refund.amount,
															currency: refund.currency,
															method: refund.method,
														}),
													),
												),
											)
										: null,
								),
								context.data.canWrite
									? h(ClaimActions, {
											claim,
											websiteId: /** @type {string} */ (context.data.websiteId),
											statuses: settings.vocabulary.statuses,
											methods: settings.refunds ? settings.refunds.methods : null,
											restock: settings.restock !== null,
											messages: settings.messages !== null,
										})
									: null,
							),
						),
					),
		),
	);
}
