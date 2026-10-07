/** Simulator: quote a cart against the website's live deals (no storage, no usage). */
import { createElement as h } from 'react';
import { Card } from '@ss/ui';
import { dashboardContext } from '../../_lib/dashboard.js';
import { Shell, t } from '../_components/Shell.js';
import { Simulator } from '../_components/Simulator.js';

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function SimulatorPage({ searchParams }) {
	const { website } = await searchParams;
	const context = await dashboardContext(typeof website === 'string' ? website : null);
	if (context.state !== 'ready') return h(Shell, { context, active: 'simulator' });
	return h(
		Shell,
		{ context, active: 'simulator' },
		h(Card, { title: t('dashboard.nav.simulator') }, h(Simulator, { websiteId: context.data.websiteId })),
	);
}
