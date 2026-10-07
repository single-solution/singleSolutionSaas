import { createElement as h } from 'react';
import { createTranslator } from '../headless/strings.js';
import en from '../strings/en.json' with { type: 'json' };

const t = createTranslator(en);

export default function Home() {
	return h(
		'main',
		{ className: 'mx-auto max-w-2xl p-8' },
		h('h1', { className: 'text-2xl font-bold' }, t('dashboard.title')),
		h('p', { className: 'mt-2 text-muted' }, t('dashboard.launch_required')),
	);
}
