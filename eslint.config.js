import js from '@eslint/js';
import nextPlugin from '@next/eslint-plugin-next';
import boundaries from 'eslint-plugin-boundaries';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const REPO_ROOT = import.meta.dirname;

const API_SRC = 'apps/api/src';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/dist/**',
      '**/coverage/**',
      '**/next-env.d.ts',
      'docs/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Node runs our TypeScript natively (type stripping): only erasable syntax is allowed.
      'no-restricted-syntax': [
        'error',
        { selector: 'TSEnumDeclaration', message: 'Use a string-literal union (erasable syntax only).' },
        {
          selector: 'TSParameterProperty',
          message: 'Declare class fields explicitly (erasable syntax only).',
        },
      ],
    },
  },

  // Module boundaries (architecture.md §4.2, D-032): a module may import another module only through that
  // module's public index.ts; platform code never imports modules; only the composition root wires modules.
  {
    files: [`${API_SRC}/**/*.ts`],
    plugins: { boundaries },
    settings: {
      // Resolve element patterns from the repo root, independent of the process working directory.
      'boundaries/root-path': REPO_ROOT,
      'boundaries/elements': [
        // partialMatch: false = patterns match the full path from the repo root (no suffix matching).
        { type: 'module', pattern: `${API_SRC}/modules/*`, capture: ['moduleName'], partialMatch: false },
        { type: 'platform', pattern: `${API_SRC}/platform`, partialMatch: false },
        // Listed last: elements match in order, so only files directly in src/ (app.ts, main.ts) land here.
        { type: 'composition-root', pattern: API_SRC, partialMatch: false },
      ],
      'import/resolver': { node: { extensions: ['.ts'] } },
    },
    rules: {
      'boundaries/no-unknown-files': 'error',
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          policies: [
            // Inside one module: anything.
            {
              from: { element: { type: 'module' } },
              allow: {
                to: {
                  element: {
                    type: 'module',
                    captured: { moduleName: '{{ from.element.captured.moduleName }}' },
                  },
                },
              },
            },
            // Across modules: only the public entry point.
            {
              from: { element: { type: 'module' } },
              allow: { to: { element: { type: 'module', fileInternalPath: 'index.ts' } } },
            },
            // Modules and the composition root may use platform infrastructure.
            {
              from: { element: { types: { anyOf: ['module', 'composition-root'] } } },
              allow: { to: { element: { type: 'platform' } } },
            },
            { from: { element: { type: 'platform' } }, allow: { to: { element: { type: 'platform' } } } },
            // The composition root wires modules through their public entry points only.
            {
              from: { element: { type: 'composition-root' } },
              allow: {
                to: [
                  { element: { type: 'module', fileInternalPath: 'index.ts' } },
                  { element: { type: 'composition-root' } },
                ],
              },
            },
          ],
        },
      ],
    },
  },

  // Next.js apps
  {
    files: ['apps/web/**/*.{ts,tsx}', 'apps/admin/**/*.{ts,tsx}'],
    plugins: { '@next/next': nextPlugin },
    settings: { next: { rootDir: ['apps/web/', 'apps/admin/'] } },
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
    },
  },
);
