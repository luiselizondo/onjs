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
      'prefer-const': 'error',
      'prefer-template': 'error',
      'template-curly-spacing': ['error', 'never'],
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
    // Tests are formatted with the same style rules as lib/** (the block
    // above): ESLint fixes them on save, including no-var and prefer-const.
    // Only max-len stays off (long string literals cannot be auto-wrapped).
    // Correctness rules (no-undef, no-unused-vars) stay active.
    files: ['tests/**/*.js'],
    rules: {
      'max-len': 'off',
      'no-unused-vars': [
        'error',
        {
          varsIgnorePattern: '^(Events|MQ|eventsInstance)$',
          argsIgnorePattern: '^(data|incomingData)$',
        },
      ],
    },
  }
]
