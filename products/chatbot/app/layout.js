import { createElement as h } from 'react';
import { ThemeScript } from '@ss/ui';
import './globals.css';

export const metadata = { title: 'Chatbot & Support', robots: { index: false, follow: false } };

/** @param {{ children: import('react').ReactNode }} props */
export default function RootLayout({ children }) {
	// the theme follows the OS unless the dashboard's theme switch stored a choice, applied before paint
	return h(
		'html',
		{ lang: 'en', suppressHydrationWarning: true },
		h('head', null, h(ThemeScript)),
		h('body', { className: 'min-h-screen bg-canvas font-sans text-fg antialiased' }, children),
	);
}
