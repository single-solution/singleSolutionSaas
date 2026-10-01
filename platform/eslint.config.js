import { createEslintConfig } from '@ss/config/eslint';

export default createEslintConfig({ jsx: ['app/**/*.js'], browserJsx: ['src/console/**/*.js', 'test/console/**/*.js'] });
