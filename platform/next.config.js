import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { staticSecurityHeaders } from '@ss/net';
import { API_CSP } from './src/infra/security-headers.js';

const here = dirname(fileURLToPath(import.meta.url));
// inside the Shelfway monorepo the workspace packages are linked from its root; extracted, the project is the root
const monorepo = resolve(here, '..');
const root = existsSync(resolve(monorepo, 'pnpm-workspace.yaml')) ? monorepo : here;

/** @type {import('next').NextConfig} */
const config = {
	poweredByHeader: false,
	reactStrictMode: true,
	// `next dev` would write AGENTS.md / CLAUDE.md into the project when it detects a coding agent
	agentRules: false,
	outputFileTracingRoot: root,
	turbopack: { root },
	serverExternalPackages: ['mongodb'],
	// the UI library ships untranspiled JSX in .js files
	transpilePackages: ['@ss/ui'],
	// One route handler (app/api/[...path]) serves every server path; the public paths stay as they are. Checked before
	// the console's catch-all page, which owns every other path.
	rewrites: async () => ({
		beforeFiles: [
			{ source: '/docs/:productId/openapi.json', destination: '/api/v1/docs/:productId/openapi.json' },
			{ source: '/docs/openapi.json', destination: '/api/v1/docs/openapi.json' },
			...['/v1/:path*', '/branding/logo', '/.well-known/jwks.json'].map((source) => ({
				source,
				destination: `/api${source}`,
			})),
		],
	}),
	// `/` is the public marketing site ((site)/page.js). Signed-in merchants are sent to /overview from that page.
	headers: async () => [
		{ source: '/:path*', headers: staticSecurityHeaders() },
		{ source: '/api/:path*', headers: [{ key: 'Content-Security-Policy', value: API_CSP }] },
		{ source: '/v1/:path*', headers: [{ key: 'Content-Security-Policy', value: API_CSP }] },
		{ source: '/.well-known/:path*', headers: [{ key: 'Content-Security-Policy', value: API_CSP }] },
		{ source: '/docs/:path*.json', headers: [{ key: 'Content-Security-Policy', value: API_CSP }] },
	],
};

export default config;
