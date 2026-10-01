import { createElement as h } from 'react';

export const metadata = { title: '{{name}}' };

/** @param {{ children: import('react').ReactNode }} props */
export default function RootLayout({ children }) {
	return h('html', { lang: 'en' }, h('body', null, children));
}
