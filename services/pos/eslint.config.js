import js from '@eslint/js';
import globals from 'globals';

// This project has never been linted before, and the goal here is catching
// real bugs (undefined globals, unused vars, unreachable code) days before
// the deadline, not imposing a new style regime. eslint:recommended plus
// the correct Node/ESM globals is deliberately all this is.
export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
];
