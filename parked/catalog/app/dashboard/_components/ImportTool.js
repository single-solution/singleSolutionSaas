'use client';
/**
 * CSV import: choose a file → dry run (diff per item, row errors) → apply with the versions the dry run saw (conflicts
 * follow the conflict policy). POST /v1/dashboard/imports with the dashboard session; audited.
 */
import { createElement as h, useState } from 'react';
import { Button, Callout } from '@ss/ui';
import { createTranslator } from '../../../headless/strings.js';
import en from '../../../strings/en.json' with { type: 'json' };

const t = createTranslator(en);

/** @param {{ websiteId: string, canWrite: boolean }} props */
export function ImportTool({ websiteId, canWrite }) {
	const [csv, setCsv] = useState('');
	const [report, setReport] = useState(/** @type {any} */ (null));
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState(/** @type {string | null} */ (null));
	/** @param {boolean} dryRun */
	const send = async (dryRun) => {
		setBusy(true);
		setError(null);
		const response = await fetch('/v1/dashboard/imports', {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID(), 'x-ss-website': websiteId },
			body: JSON.stringify({ csv, dryRun, ...(dryRun || !report ? {} : { expectedVersions: report.versions }) }),
		});
		const json = await response.json().catch(() => ({}));
		setBusy(false);
		if (response.ok) setReport(json);
		else setError(json.detail ?? json.title ?? String(response.status));
	};
	/** @param {any} event */
	const pick = async (event) => {
		const file = event.target.files?.[0];
		setReport(null);
		setCsv(file ? await file.text() : '');
	};
	const summary = report?.summary;
	return h(
		'div',
		{ className: 'space-y-4' },
		h(
			'label',
			{ className: 'block text-sm font-semibold' },
			t('dashboard.import.file'),
			h('input', { type: 'file', accept: '.csv,text/csv', className: 'mt-1 block', onChange: pick }),
		),
		h(
			'div',
			{ className: 'flex gap-2' },
			h(
				Button,
				{ type: 'button', disabled: !csv || !canWrite, loading: busy, onClick: () => send(true) },
				t('dashboard.import.dry_run'),
			),
			h(
				Button,
				{
					type: 'button',
					variant: 'secondary',
					disabled: !report?.dryRun || !canWrite,
					loading: busy,
					onClick: () => send(false),
				},
				t('dashboard.import.apply'),
			),
		),
		error ? h(Callout, { tone: 'danger' }, error) : null,
		summary
			? h(
					Callout,
					{
						tone: summary.errors > 0 ? 'warning' : 'info',
						title: t(report.dryRun ? 'dashboard.import.preview' : 'dashboard.import.done'),
					},
					t('dashboard.import.summary', {
						create: summary.create,
						update: summary.update,
						unchanged: summary.unchanged,
						errors: summary.errors,
					}),
				)
			: null,
		report
			? h(
					'ul',
					{ className: 'space-y-2 text-sm' },
					report.items
						.slice(0, 200)
						.map((/** @type {any} */ item) =>
							h(
								'li',
								{ key: item.key, className: 'rounded-md border border-line p-2' },
								h(
									'strong',
									null,
									`${item.slug ?? item.itemId} · ${t(`dashboard.import.action.${item.action}`)}${item.outcome ? ` · ${item.outcome}` : ''}`,
								),
								item.changes.length > 0
									? h(
											'p',
											{ className: 'text-muted' },
											item.changes
												.map(
													(/** @type {any} */ c) =>
														`${c.field}: ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`,
												)
												.join('; '),
										)
									: null,
								item.errors.length > 0
									? h(
											'p',
											{ className: 'text-danger' },
											item.errors
												.map(
													(/** @type {any} */ e) =>
														`${t('dashboard.import.line', { line: e.line })} ${e.path} ${e.code}`,
												)
												.join('; '),
										)
									: null,
							),
						),
				)
			: null,
	);
}
