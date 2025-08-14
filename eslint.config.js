import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Match existing .eslintrc relaxations
      'import/extensions': 'off',
      camelcase: 'off',
    },
  },
  {
    ignores: ['node_modules/**', 'dist/**'],
  },
];


