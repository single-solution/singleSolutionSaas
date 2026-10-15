import { createEslintConfig } from '@ss/config/eslint';

// the test product mirrors a generated product's own config: ui/ runs in browsers, app/ holds React components and
// the dashboard test renders them
export default createEslintConfig({
	browserJsx: ['fixtures/*/ui/**/*.js', 'fixtures/*/app/**/*.js', 'fixtures/*/tests/dashboard.test.js'],
	ignores: ['fixtures/*/server/widget-script.js'],
});
