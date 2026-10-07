import { createEslintConfig } from '@ss/config/eslint';

// fixtures/notes/ui/ runs in browsers (bundled into its widget script, which is generated)
export default createEslintConfig({ browserJsx: ['fixtures/*/ui/**/*.js'], ignores: ['fixtures/*/api/widget-script.js'] });
