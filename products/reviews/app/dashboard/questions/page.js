/** Questions & answers: pending questions to publish or reject, published ones to answer. */
import { createElement as h } from 'react';
import { Card, EmptyState } from '@ss/ui';
import { dashboardContext } from '../../_lib/dashboard.js';
import { AnswerForm } from '../_components/AnswerForm.js';
import { Shell, t } from '../_components/Shell.js';

export const dynamic = 'force-dynamic';

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function Questions({ searchParams }) {
	const { website } = await searchParams;
	const context = await dashboardContext(typeof website === 'string' ? website : null);
	if (context.state !== 'ready') return h(Shell, { context, active: 'questions' });
	if (!context.data.settings.enabled('qna'))
		return h(Shell, { context, active: 'questions' }, h(EmptyState, { title: t('dashboard.questions.off'), compact: true }));
	const [pending, published] = await Promise.all([context.data.questions('pending'), context.data.questions('published')]);
	/** @param {string} title @param {Array<Record<string, any>>} items @param {boolean} awaiting */
	const section = (title, items, awaiting) =>
		h(
			Card,
			{ title },
			items.length === 0
				? h(EmptyState, { title: t('dashboard.questions.empty'), compact: true })
				: h(
						'ul',
						{ className: 'space-y-4' },
						items.map((question) =>
							h(
								'li',
								{ key: question.id, className: 'rounded-md border border-line p-4' },
								h('p', { className: 'font-semibold' }, question.body),
								h(
									'p',
									{ className: 'text-sm text-muted' },
									`${question.itemId} · ${String(question.askedAt).slice(0, 10)}`,
								),
								...question.answers.map((/** @type {any} */ answer) =>
									h(
										'p',
										{ key: answer.id, className: 'mt-2 text-sm' },
										`${answer.by === 'merchant' ? t('reviews.reply') : (answer.author ?? '')}: ${answer.body}`,
									),
								),
								context.data.canWrite
									? h(AnswerForm, {
											questionId: question.id,
											websiteId: /** @type {string} */ (context.data.websiteId),
											awaiting,
										})
									: null,
							),
						),
					),
		);
	return h(
		Shell,
		{ context, active: 'questions' },
		section(t('dashboard.questions.pending'), pending, true),
		section(t('dashboard.questions.published'), published, false),
	);
}
