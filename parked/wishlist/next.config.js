/** Next.js config: every public server path is rewritten to the one route handler (app/api/[...path]), served by the app-kit router. */
const config = {
	// public paths stay as they are (the Portal, websites and tests call them); one function serves them all
	async rewrites() {
		return ['/v1/:path*', '/.well-known/:path*', '/sso'].map((source) => ({
			source,
			destination: `/api${source}`,
		}));
	},
};

export default config;
