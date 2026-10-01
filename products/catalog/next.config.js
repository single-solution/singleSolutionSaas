/** Next.js config: /v1/* is served by the app-kit router; project files read at runtime are traced into the build. */
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
	async rewrites() {
		return [{ source: '/v1/:path*', destination: '/api/v1/:path*' }];
	},
	outputFileTracingIncludes: { '/**': ['./manifest.json', './schemas/**/*', './strings/**/*'] },
};

export default config;
