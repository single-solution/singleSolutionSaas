import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_CSP, staticSecurityHeaders } from './src/infra/security-headers.js';

const here = dirname(fileURLToPath(import.meta.url));
// inside the Single Solution monorepo the workspace packages are linked from its root; extracted, the project is the root
const monorepo = resolve(here, '..');
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
	// One route handler (app/api/[...path]) serves every server path; the public paths stay as they are. Checked before
	// the console's catch-all page, which owns every other path.
	rewrites: async () => ({
		beforeFiles: ['/v1/:path*', '/branding/logo', '/.well-known/jwks.json'].map((source) => ({
			source,
			destination: `/api${source}`,
		})),
	}),
	// the console lives under /websites (signed-out visitors are sent on to /login by the console shell)
	redirects: async () => [{ source: '/', destination: '/overview', permanent: false }],
	headers: async () => [
		{ source: '/:path*', headers: staticSecurityHeaders() },
		{ source: '/api/:path*', headers: [{ key: 'Content-Security-Policy', value: API_CSP }] },
		{ source: '/v1/:path*', headers: [{ key: 'Content-Security-Policy', value: API_CSP }] },
		{ source: '/.well-known/:path*', headers: [{ key: 'Content-Security-Policy', value: API_CSP }] },
	],
};

export default config;
