/**
 * Integration tests: real express app + real Postgres (test shard) + real Redis.
 * Run with `npm run test:integration`. Requires Postgres and Redis to be up.
 */
module.exports = {
    preset: "ts-jest",
    testEnvironment: "node",
    roots: ["<rootDir>/tests/integration"],
    testMatch: ["**/*.integration.test.ts"],
    setupFiles: ["<rootDir>/tests/setup-env.ts"],
    globalSetup: "<rootDir>/tests/integration/globalSetup.ts",
    globalTeardown: "<rootDir>/tests/integration/teardown.ts",
    // One shared test DB per region: files must not truncate under each other.
    maxWorkers: 1,
    forceExit: true,
    // Broker round-trips + the scheduler tick test need more than the 5s default.
    testTimeout: 15000,
    transform: {
        // 151002: see jest.config.js
        "^.+\\.ts$": ["ts-jest", {tsconfig: "tsconfig.test.json", diagnostics: {ignoreCodes: [151002]}}],
    },
};
