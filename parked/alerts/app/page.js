import { createElement as h } from 'react';

export default function Home() {
	return h(
		'main',
		null,
		h('h1', null, 'Alerts & Waitlists'),
		h('p', null, 'Service product. Open the dashboard from the Portal.'),
	);
}
