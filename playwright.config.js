import { defineConfig, devices } from '@playwright/test';

/**
 * @see https://playwright.dev/docs/test-configuration
 */
export default defineConfig({
    testDir: './tests',
    /**
     * 以下は Playwright のテストではなく node で単体実行する検証。
     * 既定の testMatch（*.spec.ts / *.test.ts）に一致するため収集され、
     * Playwright の `test()` を持たないのに**収集時にトップレベルの
     * スクリプトが走ってしまう**。他の spec の `/api/test/clear` と競合して
     * 無関係な assert 失敗を出し、全体実行が常に赤く見える＝本物の失敗が
     * 埋もれるため除外する。実行は `npm run test:node`。
     *
     * - audit-unit.test.ts  … 自前 runner（サーバ不要）
     * - audit.spec.ts       … node:test（サーバ不要）
     * - audit-http.spec.ts  … 自前 runner（dev 必要）
     * - audit-mcp.spec.ts   … 自前 runner（dev 必要）
     */
    testIgnore: [
        '**/audit-unit.test.ts',
        '**/audit.spec.ts',
        '**/audit-http.spec.ts',
        '**/audit-mcp.spec.ts',
        '**/github-email-unit.spec.ts',
        '**/server-security-unit.spec.ts',
        '**/mcp-oauth-purge-unit.spec.ts',
        '**/i18n-unit.spec.ts',
    ],
    outputDir: './tests/test-results',
    /* Run tests in files in parallel */
    fullyParallel: false,
    /* Fail the build on CI if you accidentally left test.only in the source code. */
    forbidOnly: !!process.env.CI,
    /* Retry on CI only */
    retries: process.env.CI ? 2 : 0,
    /* Opt out of parallel tests on CI. */
    workers: 1,
    /* Reporter to use. See https://playwright.dev/docs/test-reporters */
    reporter: [['html', { outputFolder: './tests/playwright-report' }]],
    /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
    use: {
        /* Base URL to use in actions like `await page.goto('/')`. */
        baseURL: 'http://localhost:3000',
        locale: 'ja-JP',

        /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
        trace: 'on-first-retry',
    },

    /* Configure projects for major browsers */
    projects: [
        {
            name: 'chromium',
            use: {
                ...devices['Desktop Chrome'],
                headless: true,
            },
        },
    ],

    /* Run your local dev server before starting the tests */
    // src 編集後の stale dist を検証しないよう、webServer 起動時に必ず build を挟む
    webServer: {
        command: 'npm run build && npm run dev:sandbox',
        url: 'http://localhost:3000',
        reuseExistingServer: !process.env.CI,
    },
});
