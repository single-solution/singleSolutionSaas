/** rules@1 condition checker: the language of group / option `when`, exclusion rules and price rules. */
import { createElement as h } from 'react';
import { Card } from '@ss/ui';
import { dashboardContext } from '../../_lib/dashboard.js';
import { RuleChecker } from '../_components/RuleChecker.js';
import { Shell, t } from '../_components/Shell.js';

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function Rules({ searchParams }) {
	const { website } = await searchParams;
	const context = await dashboardContext(typeof website === 'string' ? website : null);
	if (context.state !== 'ready') return h(Shell, { context, active: 'rules' });
	return h(
		Shell,
		{ context, active: 'rules' },
		h(
			Card,
			{ title: t('dashboard.nav.rules'), subtitle: t('dashboard.rules.intro') },
			h(RuleChecker, { initial: "selection.size == 'XL' and selection.color != 'sand'" }),
		),
	);
}
