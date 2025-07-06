/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json', 'node'],
  collectCoverage: true,
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  // Optionally, set a coverage threshold
  // coverageThreshold: {
  //   global: {
  //     branches: 80,
  //     functions: 80,
  //     lines: 80,
  //     statements: -10, // Allow 10 fewer statements than lines for now
  //   },
  // },
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      // ts-jest configuration options
      tsconfig: 'tsconfig.json', // Or point to a specific tsconfig.test.json if you have one
    }],
  },
};
