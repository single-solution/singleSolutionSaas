import { createElement as h } from 'react';

export default function Home() {
	return h(
		'main',
		{ className: 'mx-auto max-w-3xl p-8' },
		h('h1', { className: 'text-2xl font-extrabold' }, 'Chatbot & Support'),
		h('p', { className: 'text-muted' }, 'Service product. Open the dashboard from the Portal.'),
	);
}
