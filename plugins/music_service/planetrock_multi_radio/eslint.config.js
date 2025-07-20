/* eslint-disable no-magic-numbers */
const js = require('@eslint/js');
const prettier = require('eslint-config-prettier');
const promise = require('eslint-plugin-promise');

module.exports = [
  {
    ignores: [
      'node_modules/',
      '*.min.js',
      'assets/',
      'i18n/',
      'config.json',
      'UIConfig.json',
      'package-lock.json',
      'test*.js', // Ignore test files
      'test.js',
      'test-stations.js',
    ],
  },
  js.configs.recommended,
  prettier,
  {
    plugins: { promise },
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'script',
      globals: {
        // Node.js globals
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        global: 'readonly',
        module: 'readonly',
        require: 'readonly',
        exports: 'readonly',

        // Node.js built-ins
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
      },
    },
    rules: {
      // Error handling
      'no-console': 'off', // Allow console.log for debugging
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],

      // Code style
      indent: ['error', 2],
      'linebreak-style': ['error', 'unix'],
      quotes: ['error', 'single'],
      semi: ['error', 'always'],

      // Best practices
      'prefer-const': 'error',
      'no-var': 'error',
      'no-undef': 'error',
      'no-redeclare': 'warn',
      'no-unreachable': 'error',
      'no-duplicate-case': 'error',
      'no-empty': 'error',
      'no-extra-semi': 'error',
      'no-func-assign': 'error',
      'no-invalid-regexp': 'error',
      'no-irregular-whitespace': 'error',
      'no-obj-calls': 'error',
      'no-sparse-arrays': 'error',
      'no-unexpected-multiline': 'error',

      // ES6+ features
      'arrow-spacing': 'error',
      'no-duplicate-imports': 'error',
      'prefer-destructuring': ['error', { object: true, array: false }],
      'prefer-rest-params': 'error',
      'prefer-spread': 'error',

      // Object and function rules
      'object-shorthand': 'error',
      'prefer-template': 'error',
      'func-style': ['error', 'expression'],
      'no-loop-func': 'error',
      'no-param-reassign': 'error',

      // Async/await
      'no-async-promise-executor': 'error',
      'require-await': 'error',
      'promise/prefer-await-to-then': 'error',

      // Volumio-specific
      'no-global-assign': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-script-url': 'error',

      // Code quality
      complexity: ['warn', 10],
      'max-depth': ['warn', 5],
      'max-lines': ['warn', 1200],
      'max-params': ['warn', 6],

      // Maintainability
      'no-magic-numbers': ['warn', { ignore: [0, 1, 2, 10, 100, 1000] }],
      'no-const-assign': 'error',

      // Security (for Volumio plugins)
      'no-eval': 'error',
    },
  },
];
