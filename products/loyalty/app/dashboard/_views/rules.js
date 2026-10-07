/** Earn rules: the effective rules from the Portal configuration, each condition checked, and a live rules@1 editor. */
import { createElement as h } from 'react';
import { Badge, Card, CodeBlock } from '@ss/ui';
import { compileCondition } from '../../../core/rules.js';
import { dashboardContext } from '../../_lib/dashboard.js';
import { RuleChecker } from '../_components/RuleChecker.js';
import { Shell, t } from '../_components/Shell.js';

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function Rules({ searchParams }) {
	const { website } = await searchParams;
	const context = await dashboardContext(typeof website === 'string' ? website : null);
	if (context.state !== 'ready') return h(Shell, { context, active: 'rules' });
	const { rules } = context.data.settings;
	return h(
		Shell,
		{ context, active: 'rules' },
		h(
			Card,
			{ title: t('dashboard.nav.rules'), subtitle: t('dashboard.rules.intro') },
			h(RuleChecker, { initial: rules[0]?.when ?? '' }),
		),
		...rules.map((rule) => {
			const compiled = compileCondition(rule.when);
			return h(
				Card,
				{
					key: rule.id,
					title: rule.name || rule.id,
					subtitle: rule.trigger,
					actions: h(Badge, {
						tone: compiled.ok ? (rule.enabled === false ? 'neutral' : 'success') : 'danger',
						children: compiled.ok ? (rule.enabled === false ? 'off' : 'on') : compiled.error.code,
					}),
				},
				h(CodeBlock, { code: JSON.stringify(rule, null, 2) }),
			);
		}),
	);
}
