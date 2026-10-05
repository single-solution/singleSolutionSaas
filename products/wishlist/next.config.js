/** Next.js config: /v1/* is served by the app-kit router; project files read at runtime are traced into the build. */
const config = {
	async rewrites() {
		return [{ source: '/v1/:path*', destination: '/api/v1/:path*' }];
	},
	outputFileTracingIncludes: { '/**': ['./manifest.json', './schemas/**/*', './strings/**/*'] },
};

export default config;
