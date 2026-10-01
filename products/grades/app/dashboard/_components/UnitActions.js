'use client';
/** Re-grade a unit and create its shareable report link (dashboard session; audited). */
import { createElement as h, useState } from 'react';
import { Button, CodeBlock, Select } from '@ss/ui';
import { createTranslator } from '../../../headless/strings.js';
import en from '../../../strings/en.json' with { type: 'json' };

const t = createTranslator(en);

/**
 * @param {{ unitId: string, websiteId: string, tier: string | null, tiers: Array<{ value: string, label: string }>, canLink: boolean }} props
 */
export function UnitActions({ unitId, websiteId, tier, tiers, canLink }) {
	const [value, setValue] = useState(tier ?? '');
	const [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState(/** @type {string | null} */ (null));
	const [link, setLink] = useState(/** @type {string | null} */ (null));
	/** @param {string} path @param {Record<string, unknown>} body */
	const send = async (path, body) => {
		setBusy(true);
		const response = await fetch(`/v1/dashboard/units/${encodeURIComponent(unitId)}/${path}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID(), 'x-ss-website': websiteId },
			body: JSON.stringify(body),
		});
		const json = await response.json().catch(() => ({}));
		setBusy(false);
		setNotice(response.ok ? t('dashboard.units.saved') : (json.detail ?? json.title ?? String(response.status)));
		return response.ok ? json : null;
	};
	return h(
		'div',
		{ className: 'flex flex-wrap items-end gap-2' },
		h(Select, {
			label: t('dashboard.units.tier'),
			value,
			options: [{ value: '', label: '—' }, ...tiers],
			onChange: (/** @type {any} */ event) => setValue(event.target.value),
		}),
		h(
			Button,
			{ type: 'button', variant: 'secondary', loading: busy, onClick: () => send('tier', { tier: value || null }) },
			t('dashboard.units.regrade'),
		),
		canLink
			? h(
					Button,
					{
						type: 'button',
						loading: busy,
						onClick: async () => {
							const created = await send('report-link', {});
							if (created) setLink(created.url ?? created.token);
						},
					},
					t('dashboard.units.report_link'),
				)
			: null,
		link ? h(CodeBlock, { code: link, label: t('dashboard.units.report_link') }) : null,
		notice ? h('p', { role: 'status', className: 'text-sm text-muted' }, notice) : null,
	);
}
