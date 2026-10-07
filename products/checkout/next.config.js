/** Next.js config: every public server path is rewritten to the one route handler (app/api/[...path]), served by the app-kit router. */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// inside the Single Solution monorepo the workspace packages are linked from its root; extracted, the project is the root
const monorepo = resolve(here, '../..');
const root = existsSync(resolve(monorepo, 'pnpm-workspace.yaml')) ? monorepo : here;

/** @type {import('next').NextConfig} */
const config = {
	poweredByHeader: false,
	reactStrictMode: true,
	outputFileTracingRoot: root,
	turbopack: { root },
	serverExternalPackages: ['mongodb'],
	// the UI library ships untranspiled JSX in .js files
	transpilePackages: ['@ss/ui'],
	// public paths stay as they are (the Portal, websites and tests call them); one function serves them all
	async rewrites() {
		return ['/v1/:path*', '/healthz', '/readyz', '/.well-known/:path*', '/sso', '/webhooks/payments/:websiteId'].map(
			(source) => ({
				source,
				destination: `/api${source}`,
			}),
		);
	},
};

export default config;
