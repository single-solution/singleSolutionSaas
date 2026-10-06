// Fail fast: validate the configuration when a server instance starts (not during `next build`).
export async function register() {
	if (process.env.NEXT_RUNTIME !== 'nodejs' || process.env.NEXT_PHASE === 'phase-production-build') return;
	const { getPortal } = await import('./src/runtime.js');
	await getPortal();
}
