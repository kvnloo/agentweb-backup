// backend/eslint.config.mjs — ESLint for the backend (Node/Express/TypeScript, CommonJS).
//
// `.mjs`, not `.js`: package.json has no `"type": "module"` (backend builds to CommonJS,
// tsconfig.json `"module": "commonjs"`), and flat config's `import`/`export default` syntax needs
// an unambiguous ESM file regardless of that. partner-portal and customer-portal can use plain
// `.js` because their own package.json sets `"type": "module"`.
//
// Same shape as partner-portal's and customer-portal's own eslint.config.js (js.configs.recommended
// + typescript-eslint's recommended set) minus the two React plugins neither applies to a Node
// service, and Node globals in place of browser ones. No project-specific rule additions: this
// exists so .aw-agent/lib/lintdiff.mjs (D95) has something to run, diff-scoped to lines a change
// adds — it does not judge the ~28k pre-existing lines this config has never seen before.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'coverage'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.jest },
    },
  },
);
