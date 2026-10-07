import { createElement as h } from 'react';
import { createTranslator } from '../headless/strings.js';
import en from '../strings/en.json' with { type: 'json' };

const t = createTranslator(en);

export default function Home() {
	return h(
		'main',
		{ className: 'mx-auto max-w-3xl p-8' },
		h('h1', { className: 'text-2xl font-extrabold' }, t('dashboard.title')),
		h('p', null, t('dashboard.launch_required')),
	);
}
