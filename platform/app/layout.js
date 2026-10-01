import './globals.css';

export const metadata = {
	title: 'Single Solution Portal',
	description: 'Control plane for websites, elements, subscriptions and credits.',
	robots: { index: false, follow: false },
};

/** @param {{ children: import('react').ReactNode }} props */
export default function RootLayout({ children }) {
	return (
		<html lang="en">
			<body className="min-h-screen bg-white font-sans text-neutral-900 antialiased dark:bg-neutral-950 dark:text-neutral-100">
				{children}
			</body>
		</html>
	);
}
