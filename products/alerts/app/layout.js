import { createElement as h } from 'react';
import './globals.css';

export const metadata = { title: 'Alerts & Waitlists', robots: { index: false, follow: false } };

/** @param {{ children: import('react').ReactNode }} props */
export default function RootLayout({ children }) {
	return h('html', { lang: 'en' }, h('body', { className: 'min-h-screen bg-canvas font-sans text-fg antialiased' }, children));
}
