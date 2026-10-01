import { createElement as h } from 'react';

export const metadata = { title: '{{name}}' };

/** @param {{ children: unknown }} props */
export default function RootLayout({ children }) {
	return h('html', { lang: 'en' }, h('body', null, children));
}
