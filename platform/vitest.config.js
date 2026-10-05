import { defineUnitConfig } from '@ss/config/vitest';

export default defineUnitConfig({
	dir: import.meta.dirname,
	jsx: ['src/console', 'test/console'],
	mongo: true,
});
