import { createElement as h } from 'react';

export default function Home() {
	return h(
		'main',
		{ className: 'mx-auto max-w-2xl p-8' },
		h('h1', { className: 'text-2xl font-bold' }, 'Catalog & PIM'),
		h('p', { className: 'mt-2 text-muted' }, 'Service product. Open the dashboard from the Portal.'),
	);
}
