/** One conversation (SSO): messages kept fresh by polling, replies, internal notes and status changes. */
import { createElement as h } from 'react';
import { Callout, Card } from '@ss/ui';
import { dashboardContext } from '../../_lib/dashboard.js';
import { Shell, t } from '../_components/Shell.js';
import { ConversationPanel } from '../_components/ConversationPanel.js';

/** @param {{ params: Promise<{ id: string }>, searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function Conversation({ params, searchParams }) {
	const { id } = await params;
	const { website } = await searchParams;
	const context = await dashboardContext(typeof website === 'string' ? website : null);
	if (context.state !== 'ready') return h(Shell, { context, active: 'inbox' });
	const found = await context.data.conversation(decodeURIComponent(id));
	if (!found)
		return h(Shell, { context, active: 'inbox' }, h(Callout, { tone: 'warning' }, t('dashboard.conversation.not_found')));
	return h(
		Shell,
		{ context, active: 'inbox' },
		h(
			Card,
			{ title: found.conversation.contact?.name ?? found.conversation.customerId ?? found.conversation.id },
			h(ConversationPanel, {
				initial: found,
				websiteId: context.data.websiteId,
				canWrite: context.data.canWrite,
				inbox: Boolean(context.data.settings.inbox),
				canned: (context.data.settings.inbox?.canned_replies ?? []).map((/** @type {any} */ r) => ({
					key: r.key,
					title: r.title ?? r.key,
					body: r.body,
				})),
				pollMs: context.data.settings.window.poll_interval_ms,
			}),
		),
	);
}
