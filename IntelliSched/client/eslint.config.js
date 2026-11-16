import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },

    rules: {
      // Ignore 'React' when checking for unused variables
      'no-unused-vars': 'off',
    },
  },
  {
    // Headless UI suites: Node scripts (CommonJS) whose page.evaluate callbacks run in the browser.
    files: ['tests/ui-legacy/**/*.js'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
      sourceType: 'commonjs',
    },
  },
  {
    // Playwright (Phase 1 Step 10): Node-side test files (ES modules) whose callbacks may run in the browser.
    files: ['e2e/**/*.js', 'playwright.config.js'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
  {
    // Playwright fixtures take a callback named "use"; it is not a React hook.
    files: ['e2e/**/*.js'],
    rules: { 'react-hooks/rules-of-hooks': 'off' },
  },
])
