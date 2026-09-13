/**
 * How a test obtains §13.8's identity token for a path.
 *
 * **Deliberately the long way round: reconcile the row, then read the token off it.** That is
 * exactly what the client does — paint a row from `tree.children` or `tree.entry`, keep its token,
 * send it back with the mutation — so a test using this helper exercises the real round trip rather
 * than a shortcut around the control.
 *
 * The alternative considered and rejected: injecting a known salt into `createServices` and minting
 * the expected token directly in the test. It is fewer lines and it proves less. A token minted
 * beside the assertion cannot catch the failure that matters here — the server handing out a token
 * that its own verifier will not accept — because both sides would be the test's arithmetic rather
 * than the server's.
 *
 * *Worth knowing about the two sides:* the token a client is given is minted from the **index
 * row**, and the token the server checks is computed from **disk**. That asymmetry is intentional
 * (`services.ts`, `requireUnchanged`) and it is why the reconcile below is not optional — a row
 * indexed before the file was written carries the wrong identity, and the mutation is correctly
 * refused as stale.
 */

import { reconcileEntry } from '../../src/core/indexer'
import type { IndexStore } from '../../src/core/index-store'
import type { RegisteredRoot } from '../../src/core/fs/containment'
import type { Services } from '../../src/server/services'

export interface TokenReaderOptions {
  readonly services: Pick<Services, 'tree.entry'>
  readonly index: IndexStore
  readonly root: RegisteredRoot
}

/** Returns `token(segments)` — the current token for a path, as the client would hold it. */
export function tokenReader(
  { services, index, root }: TokenReaderOptions,
): (segments: readonly string[]) => Promise<string> {
  return async segments => {
    await reconcileEntry(root, index, segments)
    return services['tree.entry']({ rootId: root.id, segments: [...segments] }).token
  }
}
