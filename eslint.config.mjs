import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import hooks from 'eslint-plugin-react-hooks';
import a11y from 'eslint-plugin-jsx-a11y';
export default tseslint.config(
  { ignores: ['.next/**','node_modules/**','.local/**','next-env.d.ts','playwright-report/**','test-results/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ['**/*.{ts,tsx,mjs}'], languageOptions: { globals: { console: 'readonly', process: 'readonly', Buffer: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', URL: 'readonly', fetch: 'readonly', Request: 'readonly', Response: 'readonly', window: 'readonly', document: 'readonly', alert: 'readonly', confirm: 'readonly' } }, rules: { '@typescript-eslint/no-unused-vars': ['error',{argsIgnorePattern:'^_',varsIgnorePattern:'^_'}] } },
  // Supplied handoff test suites and harnesses are vendored verbatim (hash-checked against the
  // package manifests); their style is not ours to rewrite.
  { files: ['tests/handoff/**/*.mjs'], rules: { '@typescript-eslint/no-unused-vars': 'off' } },
  { files: ['**/*.tsx'], plugins: {'react-hooks':hooks,'jsx-a11y':a11y}, rules: {...hooks.configs.recommended.rules,...a11y.configs.recommended.rules} }
);
