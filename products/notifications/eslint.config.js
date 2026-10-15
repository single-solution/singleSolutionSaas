import { createEslintConfig } from '@ss/config/eslint';

// ui/ runs in browsers (bundled into widget.js), app/ holds the dashboard's React components and the dashboard tests
// renders them
export default createEslintConfig({
	browserJsx: ['ui/**/*.js', 'app/**/*.js', 'tests/dashboard.test.js', 'tests/dashboard-lists.test.js'],
	ignores: ['server/widget-script.js'],
});
