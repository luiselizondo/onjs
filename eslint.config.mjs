import js from '@eslint/js'

export default [
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'writable',
        exports: 'writable',
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        describe: 'readonly',
        it: 'readonly',
        before: 'readonly',
        after: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly'
      }
    },
    rules: {
      semi: ['error', 'never'],
      quotes: ['error', 'single'],
      indent: ['error', 2],
      'no-var': 'error',
      'space-before-function-paren': ['error', 'always'],
      'comma-dangle': ['error', 'always-multiline'],
      'max-len': ['error', {
        code: 120,
        ignoreUrls: true,
        ignoreComments: true
      }]
    }
  },
  {
    // Legacy test files are not bulk-reformatted: style rules are off for them,
    // and so is no-unused-vars (they carry unused legacy imports/args). no-undef
    // stays active from js.configs.recommended, and lib/** keeps the strict
    // configuration above.
    files: ['tests/**/*.js'],
    rules: {
      'no-var': 'off',
      quotes: 'off',
      semi: 'off',
      'comma-dangle': 'off',
      'max-len': 'off',
      'space-before-function-paren': 'off',
      indent: 'off',
      // Off for the legacy tests: they carry unused imports/args (`should`,
      // `MQ`, `incomingData`, `data`, `eventsInstance`) that would require
      // editing tests/** to fix. lib/** keeps the rule active.
      'no-unused-vars': 'off'
    }
  }
]
