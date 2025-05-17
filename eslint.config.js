import globals from 'globals'
import tseslint from 'typescript-eslint'
import pluginReact from 'eslint-plugin-react'
import pluginReactHooks from 'eslint-plugin-react-hooks'
import pluginVitest from 'eslint-plugin-vitest'
import pluginPrettier from 'eslint-plugin-prettier'
// For react/jsx-runtime, usually covered by pluginReact.configs.recommended or pluginReact.configs.jsx-runtime
// If not, you might need a specific import or ensure your React plugin version supports it directly in flat config.

// Helper to trim global keys
function trimGlobals(globalsObj) {
  return Object.fromEntries(
    Object.entries(globalsObj).map(([k, v]) => [k.trim(), v]),
  )
}

export default [
  // Global ignores
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'build/**',
      'coverage/**',
      '**/*.config.js',
      '**/*.config.ts',
      'eslint.config.js',
    ],
  },
  // Base ESLint recommended & TypeScript setup
  ...tseslint.configs.recommended,
  // React specific setup
  {
    files: ['**/*.{jsx,tsx}'],
    plugins: {
      react: pluginReact,
      'react-hooks': pluginReactHooks,
      prettier: pluginPrettier,
    },
    languageOptions: {
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: {
        ...trimGlobals(globals.browser),
      },
    },
    settings: {
      react: {
        version: 'detect',
      },
    },
    rules: {
      ...pluginReact.configs.recommended.rules,
      ...pluginReact.configs['jsx-runtime'].rules,
      ...pluginReactHooks.configs.recommended.rules,
      ...pluginPrettier.configs.recommended.rules,
      'prettier/prettier': 'warn',
      'react/prop-types': 'off',
      'react/no-unknown-property': ['warn', { ignore: ['cmdk-input-wrapper'] }],
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  // Vitest specific setup
  {
    files: ['**/__tests__/**/*.test.{ts,tsx}', '**/*.test.{ts,tsx}'],
    plugins: {
      vitest: pluginVitest,
    },
    rules: {
      ...pluginVitest.configs.recommended.rules,
      'vitest/no-focused-tests': 'warn',
      '@typescript-eslint/no-explicit-any': 'off',
    },
    languageOptions: {
      globals: {
        ...trimGlobals(globals.node),
        describe: true,
        it: true,
        test: true,
        expect: true,
        beforeEach: true,
        afterEach: true,
        beforeAll: true,
        afterAll: true,
        vi: true,
      },
    },
  },
  // General rules for the project
  {
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
      indent: 'off',
      'prefer-const': 'warn',
      '@typescript-eslint/no-unsafe-function-type': 'warn',
      '@typescript-eslint/ban-ts-comment': [
        'warn',
        {
          'ts-expect-error': 'allow-with-description',
          'ts-ignore': 'allow-with-description',
          'ts-nocheck': true,
          'ts-check': false,
          minimumDescriptionLength: 3,
        },
      ],
      '@typescript-eslint/no-require-imports': 'warn',
    },
  },
]
