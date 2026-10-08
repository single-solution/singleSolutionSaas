/**
 * Next.js config. The product has two functions: the API route `app/api/[...path]/route.js`, which serves every kit
 * and product route through these rewrites (`/.well-known/*`, `/sso`, `/widget.js`, `/docs`, `/oauth/*`, `/v1/*`), and the
 * dashboard page.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// inside the Single Solution monorepo the workspace packages are linked from its root; split off, the project is the root
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
	async rewrites() {
		return ['/.well-known/:path*', '/sso', '/widget.js', '/docs', '/oauth/:path*', '/v1/:path*'].map((source) => ({
			source,
			destination: `/api${source}`,
		}));
	},
};

export default config;
