import { createEslintConfig } from '@ss/config/eslint';

// headless/bundle and ui/bundle are build output (scripts/build.js)
export default createEslintConfig({ ignores: ['headless/bundle/**', 'ui/bundle/**'] });
