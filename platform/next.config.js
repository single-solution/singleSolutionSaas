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
	// Wire formats are served at /v1/* (F.9); the handler lives in the /api catch-all.
	rewrites: async () => [{ source: '/v1/:path*', destination: '/api/v1/:path*' }],
	headers: async () => [
		{ source: '/:path*', headers: staticSecurityHeaders() },
		{ source: '/api/:path*', headers: [{ key: 'Content-Security-Policy', value: API_CSP }] },
		{ source: '/v1/:path*', headers: [{ key: 'Content-Security-Policy', value: API_CSP }] },
		{ source: '/.well-known/:path*', headers: [{ key: 'Content-Security-Policy', value: API_CSP }] },
		{ source: '/healthz', headers: [{ key: 'Content-Security-Policy', value: API_CSP }] },
		{ source: '/readyz', headers: [{ key: 'Content-Security-Policy', value: API_CSP }] },
	],
};

export default config;
