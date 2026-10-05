'use client';
/**
 * Live preview of a configurator in the dashboard: the headless resolver and pricer (Mode B) running the real core in
 * the browser — no requests, no metering. Shows what shoppers get: the resolved selection, what was changed and why,
 * option states, the combination, stock and the price.
 */
import { createElement as h, useEffect, useMemo, useState } from 'react';
import { Badge, Callout, Input, Select } from '@ss/ui';
import { createPriceDeltas } from '../../../headless/priceDeltas.js';
import { createResolver } from '../../../headless/resolver.js';
import { createTranslator } from '../../../headless/strings.js';
import en from '../../../strings/en.json' with { type: 'json' };

const t = createTranslator(en);

/**
 * @param {{ configurator: { id: string, schema: any }, resolver: Record<string, unknown>, pricing: Record<string, unknown>,
 *   currency: string | null, showPrice: boolean }} props
 */
export function Playground({ configurator, resolver: resolverConfig, pricing, currency, showPrice }) {
	const resolver = useMemo(
		() => createResolver({ config: resolverConfig, strings: en, configurator }),
		[configurator, resolverConfig],
	);
	const pricer = useMemo(
		() => createPriceDeltas({ config: pricing, strings: en, configurator, currency }),
		[configurator, pricing, currency],
	);
	const [selection, setSelection] = useState(/** @type {Record<string, unknown>} */ ({}));
	const [changed, setChanged] = useState(/** @type {string | null} */ (null));
	const [state, setState] = useState(resolver.state());
	const [price, setPrice] = useState(pricer.state());
	useEffect(() => resolver.subscribe(setState), [resolver]);
	useEffect(() => pricer.subscribe(setPrice), [pricer]);
	useEffect(() => {
		void resolver.actions.resolve({ selection, changed }).then((result) => {
			if (result.ok && showPrice) void pricer.actions.price(result.value);
		});
	}, [resolver, pricer, selection, changed, showPrice]);
	const resolution = state.resolution;
	const groups = /** @type {any[]} */ (configurator.schema.groups);
	/** @param {string} key @param {unknown} value */
	const pick = (key, value) => {
		setChanged(key);
		setSelection({ ...(resolution?.selection ?? {}), [key]: value });
	};
	return h(
		'div',
		{ className: 'space-y-4' },
		h(
			'div',
			{ className: 'grid gap-3 sm:grid-cols-2' },
			groups
				.filter((group) => !resolution || resolution.applicable.includes(group.key))
				.map((group) => {
					const value = resolution?.selection[group.key];
					const states = new Map(
						(resolution?.states.find((entry) => entry.key === group.key)?.options ?? []).map((o) => [o.key, o.state]),
					);
					if (group.type === 'single')
						return h(Select, {
							key: group.key,
							label: group.label,
							value: typeof value === 'string' ? value : '',
							options: [
								{ value: '', label: t('widget.none') },
								...group.options
									.filter((/** @type {any} */ o) => !o.hidden)
									.map((/** @type {any} */ o) => ({
										value: o.key,
										label: `${o.label} · ${t(`dashboard.state.${states.get(o.key) ?? 'available'}`)}`,
									})),
							],
							onChange: (/** @type {any} */ event) => pick(group.key, event.target.value || null),
						});
					if (group.type === 'multi')
						return h(
							'fieldset',
							{ key: group.key, className: 'space-y-1' },
							h('legend', { className: 'text-sm font-semibold' }, group.label),
							group.options
								.filter((/** @type {any} */ o) => !o.hidden)
								.map((/** @type {any} */ o) => {
									const list = Array.isArray(value) ? value : [];
									return h(
										'label',
										{ key: o.key, className: 'flex items-center gap-2 text-sm' },
										h('input', {
											type: 'checkbox',
											checked: list.includes(o.key),
											onChange: () =>
												pick(group.key, list.includes(o.key) ? list.filter((k) => k !== o.key) : [...list, o.key]),
										}),
										`${o.label} · ${t(`dashboard.state.${states.get(o.key) ?? 'available'}`)}`,
									);
								}),
						);
					return h(Input, {
						key: group.key,
						label: group.label,
						type: group.type === 'range' ? 'number' : 'text',
						defaultValue: value === undefined ? '' : String(value),
						onBlur: (/** @type {any} */ event) => {
							const raw = event.target.value;
							pick(group.key, raw === '' ? null : group.type === 'range' ? Number(raw) : raw);
						},
					});
				}),
		),
		state.problem ? h(Callout, { tone: 'danger' }, state.problem.detail ?? state.problem.code) : null,
		resolution
			? h(
					'div',
					{ className: 'flex flex-wrap items-center gap-2 text-sm', role: 'status' },
					h(Badge, {
						tone: resolution.exact ? 'success' : 'warning',
						children: resolution.exact ? t('dashboard.preview.exact') : t('dashboard.preview.adjusted'),
					}),
					h(Badge, {
						tone: resolution.inStock ? 'success' : 'danger',
						children: resolution.inStock ? t('dashboard.preview.in_stock') : t('widget.out_of_stock'),
					}),
					resolution.combination
						? h('span', { className: 'font-mono' }, resolution.combination.sku ?? resolution.combination.id)
						: null,
					showPrice && price.unitText ? h('span', { className: 'font-semibold' }, price.unitText) : null,
					...resolution.adjusted.map((change, index) =>
						h(
							'span',
							{ key: index, className: 'text-muted' },
							t('dashboard.preview.change', { group: change.group, reason: change.reason }),
						),
					),
				)
			: null,
	);
}
