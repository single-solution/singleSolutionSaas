/** New configurator: start from a sample (apparel, a computer, a SaaS plan) and edit the JSON. */
import { createElement as h } from 'react';
import { Callout, Card } from '@ss/ui';
import { SAMPLES } from '../../../api/samples.js';
import { dashboardContext } from '../../_lib/dashboard.js';
import { Editor } from '../_components/Editor.js';
import { Shell, t } from '../_components/Shell.js';

export const dynamic = 'force-dynamic';

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function NewConfigurator({ searchParams }) {
	const { website } = await searchParams;
	const context = await dashboardContext(typeof website === 'string' ? website : null);
	if (context.state !== 'ready') return h(Shell, { context, active: 'new' });
	const { canWrite, websiteId } = context.data;
	return h(
		Shell,
		{ context, active: 'new' },
		h(
			Card,
			{ title: t('dashboard.nav.new'), subtitle: t('dashboard.editor.intro') },
			canWrite && websiteId
				? h(Editor, { websiteId, samples: SAMPLES.map((sample) => ({ ...sample })) })
				: h(Callout, { tone: 'info' }, t('dashboard.read_only')),
		),
	);
}
