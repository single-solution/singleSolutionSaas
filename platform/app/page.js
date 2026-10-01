import { connection } from 'next/server';

// Dynamic so the per-request CSP nonce from proxy.js applies.
export default async function Home() {
	await connection();
	return (
		<main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-4 px-4">
			<p className="text-sm font-medium uppercase tracking-wide text-neutral-500">Single Solution</p>
			<h1 className="text-3xl font-semibold">Portal</h1>
			<p className="text-neutral-600 dark:text-neutral-400">
				The control plane is running. Consoles arrive with the identity and commerce modules.
			</p>
		</main>
	);
}
