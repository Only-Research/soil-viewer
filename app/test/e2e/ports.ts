/**
 * The ports the e2e harness runs the real server on.
 *
 * Shared by `playwright.config.ts` and the tests so the two cannot drift — a suite pointed at one
 * port while the server binds another produces failures that read as application faults.
 *
 * Deliberately high and unusual. This started at 8787 and ran the entire suite against an earlier app, which
 * had been listening there for ten days.
 */
export const PORT_LOCAL = 47651
export const PORT_TAILNET = 47652
