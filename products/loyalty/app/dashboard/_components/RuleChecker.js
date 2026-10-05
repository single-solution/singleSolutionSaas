'use client';
/**
 * Live validation of an earn-rule condition with rules@1 `check()` (the same compiler the product uses at runtime):
 * errors with line/column, unknown identifiers, and the context paths the condition reads.
 */
import { createElement as h, useMemo, useState } from 'react';
import { Badge, Callout, TextArea } from '@ss/ui';
import { checkCondition, RULE_ROOTS } from '../../../core/rules.js';
import { createTranslator } from '../../../headless/strings.js';
import en from '../../../strings/en.json' with { type: 'json' };

const t = createTranslator(en);

/** @param {{ initial?: string }} props */
export function RuleChecker({ initial = '' }) {
	const [source, setSource] = useState(initial);
	const result = useMemo(() => checkCondition(source), [source]);
	const error = result.errors[0];
	return h(
		'div',
		{ className: 'space-y-3' },
		h(TextArea, {
			label: t('dashboard.rules.condition'),
			help: RULE_ROOTS.join(', '),
			value: source,
			rows: 3,
			spellCheck: false,
			className: 'font-mono',
			onChange: (/** @type {{ target: { value: string } }} */ event) => setSource(event.target.value),
		}),
		error
			? h(Callout, { tone: 'danger', live: true }, `${error.message}${error.line ? ` (${error.line}:${error.column})` : ''}`)
			: h(
					'div',
					{ role: 'status', className: 'flex flex-wrap items-center gap-2 text-sm' },
					h(Badge, { tone: 'success', children: source.trim() ? t('dashboard.rules.valid') : t('dashboard.rules.always') }),
					result.paths.length > 0
						? h('span', { className: 'text-muted' }, t('dashboard.rules.reads', { paths: result.paths.join(', ') }))
						: null,
				),
		...result.warnings.map((warning, index) => h(Callout, { key: index, tone: 'warning', live: false }, warning.message)),
	);
}
