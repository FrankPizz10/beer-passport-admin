/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/test', '<rootDir>/scripts'],
  testMatch: ['**/src/**/*.test.ts', '**/test/**/*.test.ts', '**/scripts/**/*.test.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: { rootDir: '.', types: ['node', 'jest'] } }],
  },
};
