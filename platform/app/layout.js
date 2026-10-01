import './globals.css';

export const metadata = {
	title: { default: 'Single Solution', template: '%s · Single Solution' },
	description: 'Control plane for websites, elements, subscriptions and credits.',
	robots: { index: false, follow: false },
};

export const viewport = { width: 'device-width', initialScale: 1, colorScheme: 'light dark' };

/** @param {{ children: import('react').ReactNode }} props */
export default function RootLayout({ children }) {
	return (
		<html lang="en">
			<body className="min-h-screen bg-canvas font-sans text-fg antialiased">{children}</body>
		</html>
	);
}
