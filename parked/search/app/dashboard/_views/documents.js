/** Documents: the index, page by page, and a test search (server view: every field, scores shown). */
import { createElement as h } from 'react';
import { Badge, ButtonLink, Card, EmptyState } from '@ss/ui';
import { dashboardContext } from '../../_lib/dashboard.js';
import { Shell, t, withWebsite } from '../_components/Shell.js';

/**
 * @param {string[]} heads string keys
 * @param {Array<{ key: string, cells: import('react').ReactNode[] }>} rows
 * @param {string} caption
 */
const table = (heads, rows, caption) =>
	h(
		'table',
		{ className: 'mt-4 w-full text-sm' },
		h('caption', { className: 'sr-only' }, caption),
		h(
			'thead',
			null,
			h(
				'tr',
				{ className: 'text-left text-muted' },
				heads.map((key) => h('th', { key, scope: 'col', className: 'py-2' }, t(key))),
			),
		),
		h(
			'tbody',
			null,
			rows.map((row) =>
				h(
					'tr',
					{ key: row.key, className: 'border-t border-line' },
					row.cells.map((cell, index) => h('td', { key: index, className: 'py-2 pr-3' }, cell)),
				),
			),
		),
	);

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function Documents({ searchParams }) {
	const { website, cursor, q } = await searchParams;
	const context = await dashboardContext(typeof website === 'string' ? website : null);
	if (context.state !== 'ready') return h(Shell, { context, active: 'documents' });
	const query = typeof q === 'string' ? q.slice(0, 200) : '';
	const typeLabel = (/** @type {string} */ key) => context.data.settings.types.get(key)?.label ?? key;
	const searchForm = h(
		'form',
		{ method: 'get', role: 'search', className: 'flex gap-2' },
		context.data.websiteId ? h('input', { type: 'hidden', name: 'website', value: context.data.websiteId }) : null,
		h('input', {
			type: 'search',
			name: 'q',
			defaultValue: query,
			'aria-label': t('dashboard.documents.search'),
			placeholder: t('dashboard.documents.search'),
			className: 'flex-1 rounded-md border border-line bg-surface px-3 py-2',
		}),
		h(
			'button',
			{ type: 'submit', className: 'rounded-md border border-line px-3 py-2 font-semibold' },
			t('dashboard.documents.run'),
		),
	);
	if (query !== '') {
		const result = await context.data.search(query);
		return h(
			Shell,
			{ context, active: 'documents' },
			h(
				Card,
				{
					title: t('dashboard.documents.results', { query }),
					subtitle: result
						? t('dashboard.documents.summary', { total: result.total, engine: t(`dashboard.engine.${result.engine}`) })
						: t('dashboard.documents.failed'),
				},
				searchForm,
				result && result.relaxed ? h('p', { className: 'mt-2 text-sm text-muted' }, t('dashboard.documents.relaxed')) : null,
				!result || result.items.length === 0
					? h(EmptyState, { title: t('dashboard.documents.none'), compact: true })
					: table(
							[
								'dashboard.documents.title',
								'dashboard.documents.type',
								'dashboard.documents.score',
								'dashboard.documents.url',
							],
							result.items.map((hit) => ({
								key: hit.id,
								cells: [
									hit.title || hit.id,
									typeLabel(hit.type),
									String(/** @type {any} */ (hit).score ?? ''),
									hit.url ?? '—',
								],
							})),
							t('dashboard.documents.results', { query }),
						),
			),
		);
	}
	const page = await context.data.documents({ cursor: typeof cursor === 'string' ? cursor : null });
	return h(
		Shell,
		{ context, active: 'documents' },
		h(
			Card,
			{ title: t('dashboard.nav.documents') },
			searchForm,
			page.items.length === 0
				? h(EmptyState, { title: t('dashboard.documents.empty'), compact: true })
				: table(
						[
							'dashboard.documents.title',
							'dashboard.documents.type',
							'dashboard.documents.source',
							'dashboard.documents.updated',
						],
						page.items.map((doc) => ({
							key: doc.id,
							cells: [
								doc.title || doc.id,
								typeLabel(doc.type),
								h(Badge, { tone: 'neutral', children: String(doc.source ?? '—') }),
								String(doc.updatedAt ?? '').slice(0, 10),
							],
						})),
						t('dashboard.nav.documents'),
					),
			page.nextCursor
				? h(
						'div',
						{ className: 'mt-4' },
						h(
							ButtonLink,
							{
								href: withWebsite(context, `/dashboard/documents?cursor=${encodeURIComponent(page.nextCursor)}`),
								variant: 'secondary',
							},
							t('dashboard.documents.next'),
						),
					)
				: null,
		),
	);
}
