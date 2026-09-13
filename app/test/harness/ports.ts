/**
 * Ports for the end-to-end chain test's own server instance.
 *
 * **Deliberately not the e2e suite's 47651/47652.** The two configs can be run at the same time — a
 * developer running one while the other is mid-flight is ordinary — and two servers racing for a
 * port produces failures that read as application faults. The e2e config's own comment records what
 * that costs: its first run pointed at 8787, found an earlier app listening, and tested a different
 * application entirely while four assertions passed.
 */
export const PORT_LOCAL = 47661
export const PORT_TAILNET = 47662
