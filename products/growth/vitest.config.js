import { defineUnitConfig } from '@ss/config/vitest';

export default defineUnitConfig({
	dir: import.meta.dirname,
	include: ['tests/**/*.test.js'],
	// app/ is the Next.js wiring and the dashboard page (it calls the kit's dashboard API)
	coverageInclude: ['{core,api,adapters,ui}/**'],
	mongo: true,
});
