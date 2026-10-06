import { defineConfig } from 'eslint/config';
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Type-checked lint — the src tree (including src/bin) runs under
 * strictTypeChecked, the strictest type-aware tier: no-non-null-assertion
 * (narrow instead), no-unnecessary-condition, no-confusing-void-expression,
 * deprecated-call policing, misused-spread, … Numbers and booleans are
 * allowed in template expressions (configured below) — the rule targets
 * the real hazards (null/undefined/objects interpolating as
 * "undefined"/"[object Object]"), and String(n) wrapping-noise helps no
 * one. Tests intentionally relax the fixture-hostile rules: regression
 * fixtures assert presence with !, defensively double-check (that is the
 * point of a regression), interpolate loosely typed values into assertion
 * messages, and deliberately call deprecated store APIs to pin them.
 */
export default defineConfig(
  // `scripts/` is standalone tooling (the self-audit gate runs it directly
  // via `npm run audit`); type-checked lint rules add nothing there.
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'scripts/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['eslint.config.js'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],
      'no-console': 'error',
      eqeqeq: ['error', 'always'],
    },
  },
  {
    files: ['src/bin/**/*.ts'],
    rules: {
      // CLI entry points legitimately write to stdout/stderr — the same
      // strictTypeChecked tier as the rest of src otherwise.
      'no-console': 'off',
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      // Test plumbing is deliberately fire-and-forget (mock bus) and
      // uses defensive assertions; strictness here fights the fixtures.
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      // strictTypeChecked tier vs fixtures (see the file header).
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/no-confusing-void-expression': 'off',
      '@typescript-eslint/no-meaningless-void-operator': 'off',
      '@typescript-eslint/restrict-plus-operands': 'off',
      '@typescript-eslint/no-misused-spread': 'off',
      '@typescript-eslint/no-unnecessary-type-parameters': 'off',
      '@typescript-eslint/no-deprecated': 'off',
      '@typescript-eslint/use-unknown-in-catch-callback-variable': 'off',
    },
  },
);
