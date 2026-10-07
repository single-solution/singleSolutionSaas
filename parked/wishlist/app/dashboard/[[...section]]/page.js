/**
 * The dashboard's only page (one server function for the whole dashboard): renders the view of each subpath —
 * /dashboard, /dashboard/lists, /dashboard/notifications —
 * from `../_views/`; any other subpath is a 404. Views take the same `params` / `searchParams` they had as pages.
 */
import { createElement as h } from 'react';
import { notFound } from 'next/navigation.js';
import { configProblems } from '@ss/app-kit';
import Overview from '../_views/overview.js';
import Lists from '../_views/lists.js';
import Notifications from '../_views/notifications.js';

export const dynamic = 'force-dynamic';

/** Subpath patterns (`:name` captures a segment into `params`) and their views. */
const VIEWS = /** @type {Array<[string[], (props: any) => unknown]>} */ ([
	[[], Overview],
	[['lists'], Lists],
	[['notifications'], Notifications],
]);

/**
 * @param {string[]} pattern
 * @param {string[]} section
 * @returns {Record<string, string> | null}
 */
const match = (pattern, section) => {
	if (pattern.length !== section.length) return null;
	/** @type {Record<string, string>} */
	const params = {};
	for (const [index, part] of pattern.entries()) {
		const value = section[index] ?? '';
		if (part.startsWith(':')) params[part.slice(1)] = value;
		else if (part !== value) return null;
	}
	return params;
};

/** @param {{ params: Promise<{ section?: string[] }>, searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function Dashboard({ params, searchParams }) {
	// no separate proxy function: the route handler answers 503 `misconfigured` itself, the dashboard shows the reasons
	const problems = configProblems(process.env);
	if (problems.length > 0)
		return h(
			'main',
			{ role: 'alert', className: 'mx-auto max-w-3xl p-8' },
			h('h1', { className: 'text-xl font-bold' }, 'This product is misconfigured'),
			h('ul', null, ...problems.map((problem) => h('li', { key: problem }, problem))),
		);
	const { section = [] } = await params;
	for (const [pattern, View] of VIEWS) {
		const found = match(pattern, section);
		if (found) return h(/** @type {any} */ (View), { params: Promise.resolve(found), searchParams });
	}
	notFound();
}
