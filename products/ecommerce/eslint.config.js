import { createEslintConfig } from '@ss/config/eslint';

// ui/ runs in browsers (bundled into widget.js) and app/ holds the dashboard's React components
export default createEslintConfig({ browserJsx: ['ui/**/*.js', 'app/**/*.js'], ignores: ['server/widget-script.js'] });
