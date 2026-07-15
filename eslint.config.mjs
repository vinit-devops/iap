import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'coverage/**',
      // Generated, self-contained bundles for the VS Code extension .vsix
      // (esbuild output — not hand-authored source).
      'extensions/vscode/extension.bundled.js',
      'extensions/vscode/server/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['**/*.mjs'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly', structuredClone: 'readonly' },
    },
  },
  {
    // The VS Code extension entry is plain CommonJS loaded by the VS Code host;
    // `vscode`/`vscode-languageclient` are required at runtime (not build-time
    // deps). Give it CommonJS module semantics + Node globals.
    files: ['extensions/vscode/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'writable',
        exports: 'writable',
        __dirname: 'readonly',
        __filename: 'readonly',
        console: 'readonly',
        process: 'readonly',
      },
    },
  },
);
