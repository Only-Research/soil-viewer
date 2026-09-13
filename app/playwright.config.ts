import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { defineConfig, devices } from '@playwright/test'

/**
 * Ports live in their own module so the config and the tests cannot drift apart.
 *
 * Deliberately not 8765/8766, and deliberately not anything in the common dev-server range. This
 * started at 8787 and that was a real mistake, kept on the record because it is the whole reason
 * `reuseExistingServer` is now off: **an earlier app had been listening on 8787 for ten days.** Playwright saw
 * a live server, never started ours, and ran the entire suite against the operator's other application —
 * and four assertions passed against it.
 */
import { PORT_LOCAL, PORT_TAILNET } from './test/e2e/ports'
import { E2E_RATE_BURST, E2E_RATE_PER_SECOND } from './test/e2e/limits'

/**
 * THE DECISION THE P3 BRIEF OWED, NOW CLOSED.
 *
 * This used to point at the Vite dev server, because that was the only thing that existed. Spec
 * §2.5 says the shipped product runs **the committed pre-built bundle plus the zero-dependency Node
 * server, never the dev server** — so a browser test against `vite` proved something no user ever
 * executes. `src/server/main.ts` and `vite.server.config.ts` now exist, so these run against the
 * real thing: `npm run build` produces both bundles, `npm run serve` runs the actual product.
 *
 * That distinction is not pedantry. The dev server sets no CSP, serves unbundled modules, and never
 * runs the Host allowlist or the Funnel gate. Every security header these tests assert is a header
 * the dev server would simply not have sent, so passing against it would have meant nothing.
 */

/**
 * A FRESH TEMP DIRECTORY PER RUN, and this is the important line in the file.
 *
 * Unset, `main.ts` defaults `SOIL_STATE_DIR` to `~/.soil-viewer` — so an e2e run would write its
 * mutation log and local log into the real state directory of the real installation. Nothing in
 * this build writes to the operator's files, and that guarantee has to hold for the test harness too or
 * it is not a guarantee.
 */
const stateDir = mkdtempSync(join(tmpdir(), 'soil-viewer-e2e-'))

/**
 * A REGISTERED FOLDER, seeded before the server boots.
 *
 * P7's Files tab shows registered folders, and a server started with an empty state directory has
 * none — so every tree assertion would run against "No folders registered yet." and prove that the
 * empty state renders. That is the shape of test this build keeps catching: green, and about
 * nothing.
 *
 * Seeding the registry file is the honest way in rather than a back door. It is exactly how a real
 * user's folders survive a restart: `restoreRegisteredRoots` reads this file at boot and
 * **re-validates every root through the same §11 rules as a fresh registration** — the spec is
 * explicit that "roots loaded from config at startup are re-validated identically, otherwise the
 * config file is a registration bypass". So this exercises the restore path too.
 *
 * Written here rather than in `globalSetup` because Playwright starts `webServer` first; by the
 * time global setup runs, the server has already read this file.
 */
/**
 * **A FIXED path, not `mkdtemp`, and the reason is a Playwright gotcha worth stating.**
 *
 * This file is imported twice: once by Playwright to read the config, and again by any test that
 * needs to look at the tree on disk. Module scope therefore runs **twice, in different processes**
 * — so `mkdtemp` handed the server one directory and the test worker a different one.
 *
 * The failure was quiet and pointed the wrong way: a test typed into the editor, watched the pill
 * reach "Saved", then read its own copy of the file and found the original text. Everything about
 * it said "the editor does not save", and the editor was saving perfectly to a directory the test
 * had never looked at.
 *
 * A fixed path makes both imports agree.
 *
 * ## The fixtures are seeded ONCE, by the config's own process — never by a worker
 *
 * They used to be rewritten on **every import**, and this module is imported by every test file
 * that needs `E2E_TREE`, in every worker. So a worker starting up rewrote the shared fixtures
 * *while the other engine's worker was mid-test against them*.
 *
 * It presented as the formatting bar being wrong on WebKit: `notes.md` was reset underneath a test
 * that had just bolded a word in it, so the caret ended up somewhere the assertion did not expect.
 * A timing-dependent failure in one engine, in a suite that had nothing to do with fixtures.
 *
 * The guard is the one the scratch folders already use, and for the same reason recorded there.
 * `TEST_WORKER_INDEX` is set in workers and unset in the config process, which is the only place a
 * shared fixture may be written.
 */
/**
 * **One sandbox holds both the registered tree and the folders the picker can add.**
 *
 * They were two sibling directories in `tmpdir()` until 2026-08-09, when the security review's C2 bounded
 * registration to the browse scope. With the scope pointed at only the picker's sandbox, the
 * server refused to restore the seeded root at boot — correctly — and every tree test failed with
 * no rows. Nesting both under one root is the fix, and it also makes the suite's own footprint one
 * directory instead of two.
 */
/**
 * **Resolved before anything is derived from it.** On macOS `tmpdir()` is `/var/folders/…` and
 * `/var` is a symlink to `/private/var`. §11's scope check compares against `realpath`'s answer, so
 * a registry seeded with the `/var` spelling sits *outside* a scope named with the `/private/var`
 * one — and after the security review's C2 bounded registration, the server refused to restore the seeded root at
 * boot. Every tree test then failed with no rows, thirty seconds at a time.
 *
 * One resolved root, everything derived from it, so the two spellings cannot diverge again.
 */
mkdirSync(join(tmpdir(), 'soil-viewer-e2e'), { recursive: true })
export const E2E_SANDBOX = realpathSync(join(tmpdir(), 'soil-viewer-e2e'))
export const E2E_TREE = join(E2E_SANDBOX, 'soil-viewer-e2e-tree')

/**
 * The registered folder's id, exported so a test cannot guess it. `security-headers.spec.ts` did
 * guess it — and its forged-write test passed for three different wrong reasons before that was
 * noticed, because an unknown `rootId` is refused exactly as convincingly as a CSRF attempt.
 */
export const E2E_ROOT_ID = 'e2e'
const seedFixtures = process.env['TEST_WORKER_INDEX'] === undefined

/**
 * **THE PRODUCT'S BUNDLE, STAMPED BEFORE THE SUITE BUILDS ANYTHING.**
 *
 * `build-isolation.spec.ts` reads this back and asserts the two files are untouched. The stamp has
 * to be taken here, in the config process, because Playwright starts `webServer` — and therefore the
 * build — before `globalSetup` runs, so anything later is already too late to have a "before".
 *
 * A fixed path rather than the per-run state directory: this module is imported by every worker, so
 * a `mkdtemp` here would hand each process a different directory, which is the trap this file
 * already records falling into once.
 */
export const DIST_STAMP = join(E2E_SANDBOX, 'dist-stamp.json')
if (seedFixtures) {
  const stampOf = (at: string): { exists: boolean; mtimeMs: number } => {
    try {
      return { exists: true, mtimeMs: statSync(at).mtimeMs }
    } catch {
      // Absent is a legitimate state — a fresh clone has never run `npm run build`. Recorded as
      // such so the assertion becomes "still absent" rather than silently passing on a missing file.
      return { exists: false, mtimeMs: 0 }
    }
  }
  writeFileSync(DIST_STAMP, JSON.stringify({
    'dist/index.html': stampOf(join(import.meta.dirname, 'dist', 'index.html')),
    'dist-server/main.js': stampOf(join(import.meta.dirname, 'dist-server', 'main.js')),
  }))
}
/** Writes only from the config process. Directory creation stays unconditional — it is idempotent
 * and a worker that imports this must not fail because a path is missing. */
const seed = (at: string, bytes: string | Buffer): void => {
  if (seedFixtures) writeFileSync(at, bytes)
}
mkdirSync(E2E_TREE, { recursive: true })
mkdirSync(join(E2E_TREE, '02-projects', 'orchard'), { recursive: true })
/**
 * **A second project, nested inside the first.** `02-projects/orchard/02-work/projects/cider-line`.
 *
 * The Projects board needs two cards to prove A25's swap — that clicking card B while A is open
 * replaces the contents *in place* rather than closing and reopening. One card can only ever
 * demonstrate same-card-closes, and a swap assertion guarded by "if a second card exists" is the
 * shape of test this suite keeps catching: one that passes without exercising its subject.
 *
 * Nested rather than a sibling of `orchard`, because that is how the soil actually nests them and it
 * gives the breadcrumb something real to read. Additive: no suite asserts a count of children under
 * `02-projects` or under `orchard`, only that particular names are present.
 */
mkdirSync(join(E2E_TREE, '02-projects', 'orchard', '02-work', 'projects', 'cider-line'), {
  recursive: true,
})
/**
 * A tasks folder with one lane and one card, so the Tasks board has something to open.
 *
 * The board finds its tasks folder by ownership rather than as a direct child — the soil puts it at
 * `02-work/tasks`, and every fixture in this build had the shape wrong until the real UI was pointed
 * at the mock. This one is shaped the way the soil actually is.
 */
mkdirSync(join(E2E_TREE, '02-projects', 'orchard', '02-work', 'tasks', 'urgent'), { recursive: true })
seed(
  join(E2E_TREE, '02-projects', 'orchard', '02-work', 'tasks', 'urgent', 'press-repair.md'),
  '# Press repair\n\nthe card the slide-over opens\n',
)
/**
 * **INBOXES — and until now the fixture had none at all**, which meant the Inbox tab had zero
 * browser coverage. Found by writing `inbox-list.spec.ts` and getting back a screen that said
 * *"No inboxes found"*: the tab was reachable, shipped, and exercised by nothing.
 *
 * Three of them, because the three things §4.7 asks for each need a different one:
 *
 * - `99-inbox-main` at the top level, with items — the *main* inbox `defaultInbox` picks, which it
 *   identifies by sitting one segment deep rather than by name.
 * - `02-projects/orchard/01-inbox`, with an item — a second FILLED group, so "the monogram marks
 *   what varies" is testable and the numeric-aware sort has more than one home.
 * - `02-projects/orchard/02-work/projects/cider-line/01-inbox`, **left empty** — the group that must
 *   not be drawn, and must still be offered as a capture destination. Without an empty one, the
 *   assertion that separates those two behaviours cannot be made at all.
 *
 * Item names are numbered past ten on purpose: `dropped-item-2` must sort before `dropped-item-10`,
 * which is the comparator `core/inbox.ts` shares with the file tree.
 *
 * Additive. No suite asserts a count of children under the root or under `orchard` — only that
 * particular names are present — and the two suites that count tree rows do so as a before/after
 * delta around their own action.
 */
mkdirSync(join(E2E_TREE, '99-inbox-main'), { recursive: true })
seed(join(E2E_TREE, '99-inbox-main', 'dropped-item-2.md'), '# Dropped item 2\n\ncaught in passing\n')
seed(join(E2E_TREE, '99-inbox-main', 'dropped-item-10.md'), '# Dropped item 10\n\nand another\n')

/**
 * **A FOLDER inside an inbox — and the fixture had none, so the dead end the operator reported could not
 * be tested at all.**
 *
 * Folders are put in inboxes deliberately: *"a lot of these folders is a dead end, so I put
 * folders into the inbox."* Without one here, `folder-jump.spec.ts` skips its Inbox case and the
 * bug they actually hit stays uncovered.
 *
 * Given a child so the landing can assert that its contents are underneath it, not just that its
 * twisty is open.
 */
mkdirSync(join(E2E_TREE, '99-inbox-main', 'content-creation'), { recursive: true })
seed(join(E2E_TREE, '99-inbox-main', 'content-creation', 'draft-outline.md'),
  '# Draft outline\n\ninside a folder that was dropped into the inbox\n')
mkdirSync(join(E2E_TREE, '02-projects', 'orchard', '01-inbox'), { recursive: true })
seed(
  join(E2E_TREE, '02-projects', 'orchard', '01-inbox', 'call-the-roofer.md'),
  '# Call the roofer\n\nthe barn end\n',
)
mkdirSync(
  join(E2E_TREE, '02-projects', 'orchard', '02-work', 'projects', 'cider-line', '01-inbox'),
  { recursive: true },
)

/**
 * **BOARDS — and the fixture had none**, which is the same hole `inbox-list.spec.ts` found: a tab
 * cannot be tested against a tree that contains nothing it can show.
 *
 * **Every folder below is a case the grammar has to separate**, not a happy path repeated. Each one
 * is a shape that will occur in the operator's real tree, and each has a specific place it must land:
 *
 * - `01-doing` / `02-done` — ordinary columns, numerically ordered, so "Doing" precedes "Done"
 *   because of the prefix rather than the alphabet.
 * - `dropped-in-by-an-agent.md`, loose in the board's own folder — the `Uncategorized` case, and
 *   the one the operator has not ruled on. Agents write into folders, not into columns.
 * - `01-doing/attachments/panel-datasheet.md` — deeper than a column. **Not a card, not a column,
 *   drawn nowhere.** This is *"no nested cards"* once it reaches disk.
 * - A second board under a different project — so the home list has to sort and disambiguate rather
 *   than render one row, which would pass against almost any bug.
 * - `archive/board-old-launch` — **must not appear at all.** Archiving is the only retire path,
 *   because nothing in this app deletes; a board that survives it can never be got rid of.
 *
 * Additive, like the inbox block above: no suite asserts a count of children under the root or
 * under `orchard`, only that particular names are present.
 */
const BOARD = join(E2E_TREE, '02-projects', 'orchard', 'board-cold-store')
mkdirSync(join(BOARD, '01-doing', 'attachments'), { recursive: true })
mkdirSync(join(BOARD, '02-done'), { recursive: true })
seed(join(BOARD, '01-doing', 'compressor-quote.md'),
  '# Compressor quote\n\nThree in, and the middle one has done a store this size before.\n')
seed(join(BOARD, '01-doing', 'insulation-spec.md'),
  '# Insulation spec\n\n100mm panel throughout. The corner detail is what nobody costs properly.\n')
seed(join(BOARD, '02-done', 'site-visit.md'),
  '# Site visit\n\nFloor is level to within 8mm across the span.\n')
seed(join(BOARD, 'dropped-in-by-an-agent.md'),
  '# Dropped in by an agent\n\nWritten into the board folder rather than into a column.\n')
seed(join(BOARD, '01-doing', 'attachments', 'panel-datasheet.md'),
  '# Panel datasheet\n\nDeeper than a column, so the board must not draw it.\n')

/**
 * **Inside the EXISTING nested project, not a new top-level one**, and a failing test is why.
 *
 * The first version put this at `02-projects/cider/…`, which creates a **project** — and the
 * Projects board draws one card per project. `card-panel.spec.ts` asserts a count of `.board-card`
 * and went from 1 to 2. The block above claims to be additive; that version was not, and the claim
 * was only true because nobody had added a project before.
 *
 * `cider-line` already exists and is already a project, so this adds a board and nothing else. It
 * still lives somewhere different from the other board, which is the whole point — the home list has
 * to disambiguate two boards by where they sit.
 */
const SECOND_BOARD = join(
  E2E_TREE, '02-projects', 'orchard', '02-work', 'projects', 'cider-line', 'board-tuesday-drops',
)
mkdirSync(join(SECOND_BOARD, 'inbox'), { recursive: true })
seed(join(SECOND_BOARD, 'inbox', 'first-pass.md'),
  '# First pass\n\nA second board, elsewhere, so the list is a list.\n')

for (const project of ['chromium', 'webkit']) {
  const gone = join(E2E_TREE, '02-projects', `scratch-${project}-board-gone`, `board-vanishing-${project}`, 'doing')
  mkdirSync(gone, { recursive: true })
  seed(join(gone, 'a-card.md'), '# A card\n\nin a board that is about to be renamed away\n')
}

/**
 * **THE BOARD TEMPLATE, in the shape the scaffold skill actually defines it:** a `00-context/`
 * holding a context file and an m-thread, and nothing else.
 *
 * Named `board-template-*` deliberately — it is a **board folder by the grammar**, which is the whole
 * problem the template exclusion exists for: registered or not, it answers "is this a board?" with
 * yes. Seeded per engine because registering a template is server state shared across a whole run.
 *
 * **Under `00-context/`, not `02-projects/`, and the first version got that wrong.** A folder under
 * `02-projects` is a **project**, so the template became a card on the Projects board — sorted first
 * by name, which is where `folder-jump.spec.ts` clicks. It broke a suite that has nothing to do with
 * boards. A real template lives under `00-context/templates/work-templates/`, so this is also the
 * more honest location: a template is not a project either.
 */
for (const project of ['chromium', 'webkit']) {
  const boardTemplate = join(E2E_TREE, '00-context', `board-template-${project}`, '00-context')
  mkdirSync(boardTemplate, { recursive: true })
  seed(join(boardTemplate, 'context-template.md'),
    '# Context — board\n\nWhat this board is for.\n')
  seed(join(boardTemplate, 'm-thread-template.md'),
    '# M-Thread\n\n**Project:**\n**Started:**\n')
}

const ARCHIVED_BOARD = join(E2E_TREE, '02-projects', 'orchard', 'archive', 'board-old-launch')
mkdirSync(join(ARCHIVED_BOARD, 'done'), { recursive: true })
seed(join(ARCHIVED_BOARD, 'done', 'shipped.md'),
  '# Shipped\n\nArchived. Must not appear in the Boards tab.\n')

seed(join(E2E_TREE, 'readme.md'), '# Readme\n\nthe top-level document\n')
/**
 * The seeded document, and its CONTENT is load-bearing rather than filler.
 *
 * The format-bar suite selects real words in it and asserts what the markers do — so the words it
 * names have to exist. Its first version was three lines long and those tests failed against a
 * document that simply did not contain them, which reads as a broken formatting bar rather than a
 * thin fixture.
 *
 * Carries the constructs the census says matter, for the same reason P6's sample did: frontmatter
 * (49% of the real tree), a heading, emphasis, a bracketed phrase that is NOT a link, and a
 * blockquote.
 */
export const SAMPLE_DOCUMENT = [
  '---',
  'title: Orchard notes',
  'type: note',
  '---',
  '',
  '# Orchard notes',
  '',
  'what the editor should open, with some **bold** in it.',
  '',
  'A line about quotes that the bar can act on.',
  '',
  '> A blockquote, for the cases where a document quotes something.',
  '',
  'Bracketed prose like [draft] is not a link, it only parses as one.',
  '',
].join('\n')
seed(join(E2E_TREE, '02-projects', 'orchard', 'notes.md'), SAMPLE_DOCUMENT)
/**
 * A REAL 1x1 PNG, and the previous fixture was the string `'not a real image'`.
 *
 * WebKit caught it: an `<img>` whose bytes do not decode has zero dimensions and reports as
 * *hidden*, so the assertion failed there and passed in Chromium, which gives a broken-image
 * placeholder a size. The Chromium pass was the misleading one — it proved an element existed, not
 * that a picture was shown.
 *
 * Same lesson the mock soil's own `photo.png` carries: a fixture that is not the thing it is named
 * after cannot exercise the path that handles that thing.
 */
seed(join(E2E_TREE, '02-projects', 'orchard', 'photo.png'), Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
))
// The pane's other two states. Neither needs real bytes: the assertions are about what the pane
// DOES with a name and a size, and real video would add a megabyte to every run to prove nothing.
seed(join(E2E_TREE, '02-projects', 'orchard', 'clip.mp4'), 'not a real video')
seed(join(E2E_TREE, '02-projects', 'orchard', 'rows.csv'), 'farm,bushels\nHollis,11000\n')
/**
 * A scratch folder per mutating test, per engine, created **before the server boots**.
 *
 * The mutating tests were sharing one tree and destroying it for the read-only ones — a rename in
 * one engine broke every test in the other, since both projects run against one server and one
 * tree. It read as flakiness that depended on worker order.
 *
 * **Guarded to the config process, and that guard is load-bearing.** This file is imported again by
 * every test worker that needs to read the tree, so an unguarded `rmSync` here wipes folders *while
 * other workers are using them* — which is a worse version of the problem it was added to fix, and
 * it presented the same way. `TEST_WORKER_INDEX` is set only inside a worker.
 *
 * Created before boot rather than inside a test because a folder made mid-run is visible only once
 * the **watcher** reconciles it, which puts a filesystem-event race in front of an assertion about
 * a menu.
 */
if (process.env['TEST_WORKER_INDEX'] === undefined) {
  /**
   * **EVERY scratch fixture is removed before any is seeded.** Added 2026-08-13, and it is a
   * correctness fix rather than tidiness.
   *
   * Each fixture below `rmSync`s *itself* and nothing else, so a scratch project that stops being
   * seeded is **never removed** — it lives in `tmpdir()` and survives every run. The tree had
   * therefore been growing **monotonically across runs and across sessions**, reaching **69
   * projects**, every one of which the board's project filter enumerates and every board redraw
   * pays for.
   *
   * That produced two failures that looked like a leak and were not: a `goto` that hung and a board
   * redraw that missed a five-second deadline, both in specs nobody had touched, appearing
   * "suddenly" because the growth was measured in days rather than in commits.
   *
   * **The worst part was reproducibility.** A suite whose baseline is whatever this machine has
   * accumulated is green for one person and red for another **on the same commit**, and no result
   * from it means quite what it says.
   *
   * Safe here and nowhere else: this block runs **only in the config process**
   * (`TEST_WORKER_INDEX === undefined`), before any worker starts, and it seeds every fixture the
   * suite needs immediately afterwards. Doing it per worker would let one engine delete the other's
   * fixtures mid-run.
   *
   * Scoped to `scratch-` prefixed directories, so the hand-written fixtures — `orchard` and the
   * documents beside it — are never touched.
   */
  const projects = join(E2E_TREE, '02-projects')
  mkdirSync(projects, { recursive: true })
  for (const name of readdirSync(projects)) {
    if (name.startsWith('scratch-')) rmSync(join(projects, name), { recursive: true, force: true })
  }

  for (const project of ['chromium', 'webkit']) {
    for (const purpose of [
      'create', 'rename', 'duplicate', 'move', 'save',
      /**
       * The two live-update tests, and they get a folder each for a reason the others do not have.
       *
       * These are the only tests in the suite that write to the tree from **outside** the app while
       * the browser is watching, so a shared folder would mean one test's external write arriving
       * as a `changed` event in the middle of the other's assertion — the tree redrawing for
       * reasons the failing test could not explain.
       */
      'live', 'live-open',
      /**
       * The three §13.8 retained-buffer tests. Separate folders because each one reloads the page
       * mid-edit, and a shared subject would mean one test's rescued buffer being offered to
       * another test's reload — a dialog nobody in that test asked for.
       */
      'retain', 'rescue', 'nonag',
      /**
       * **The phantom-buffer case, added 2026-08-25 from the operator's report.** An agent edits a file
       * they had edited in the viewer earlier, they opens it, and is asked to choose between versions
       * they never left unsaved. Its own folder because it writes to the tree from outside the app,
       * for the same reason `live` and `live-open` have theirs.
       */
      'retain-phantom',
      /** A keystroke landing while a save is in flight — the edit the wrong baseline drops. */
      'retain-inflight',
      /** The residual: a save whose ANSWER was lost, then an agent rewriting the same file. */
      'retain-lost-answer',
      /** The drawn-marker pass needs a document with lists it is allowed to type into. */
      'markers',
      /** Where Phase 8's scaffold test builds. Its own folder, so the tree assertion is exact. */
      'scaffold',
      /**
       * **The Inbox capture test, which writes a real file into a real inbox.**
       *
       * It belongs here rather than in the hand-seeded `99-inbox-main` for the reason this whole
       * block exists: the tree path is fixed, so the file it captures survives the run. The second
       * run captures the same name into the same folder, the server correctly refuses the
       * collision, and the test fails **having passed in isolation** — which is exactly how it
       * presented before it was moved.
       */
      'capture',
      // One per conflict test, not one for both: resolving a conflict leaves a rescue file behind,
      // so the second test would find TWO rows matching its own subject and fail on ambiguity.
      'conflict', 'conflict-keep', 'conflict-later',
      /**
       * **A3's three rename cases, one folder each.** They rename `subject.md` away, so borrowing
       * another test's folder takes that test's fixture with it — which is exactly what happened on
       * the first run: two retained-buffer cases went red in both engines looking for a subject that
       * had been renamed out from under them. The convention above exists for this and was ignored.
       */
      'rename-open', 'rename-typing', 'rename-flush', 'rename-blocked', 'rename-clean',
      /**
       * **§13.2's truncation confirmation, one folder per answer.** Added 2026-08-16 when the sweep
       * found `confirmTruncation` reachable by no product code.
       *
       * Two folders because the two tests end in opposite states on disk — one writes the short
       * document, one must prove the long one is untouched — and a shared subject would let
       * whichever ran first decide what the other was looking at.
       */
      'truncate-yes', 'truncate-no',
      /**
       * **P14 B4's two write tests, one folder each, for the reason this whole block exists.**
       *
       * The first version created boards straight under the registered root with a fixed name. It
       * passed on its own and failed the moment both engines ran — the tree path is fixed, so the
       * board the previous run created was still there with its columns in it, and "the new column
       * is the only column" was false. **A test that cannot be run twice is not a test**, and this
       * is the mechanism the suite already had for it.
       *
       * Two rather than one: `new` only creates a board, `flow` builds columns and cards inside one,
       * and a shared folder would let whichever ran first decide what the other was looking at.
       */
      'board-new', 'board-flow',
      /**
       * The arrange stack needs **three** real columns to prove anything: with two, `Top` and `Up`
       * land on the same square, so a send-to-the-front implemented as a swap would pass. Built by
       * the test through the UI rather than seeded, so the board belongs to that test alone.
       */
      'board-arrange',
      /** The stack outliving the board underneath it — a rename arrives with no click anywhere. */
      'board-arrange-gone',
      /** A board scaffolded from their registered board template. */
      'board-from-template',
      /** P14 follow-up: the folder jump's live-update case writes to the open document. */
      'jump-live',
      /** A board renamed out from under the Boards tab — the stale-restore case. */
      'board-gone',
    ]) {
      const folder = join(E2E_TREE, '02-projects', `scratch-${project}-${purpose}`)
      /**
       * Cleared, because the tree path is fixed rather than random — so yesterday's leftovers are
       * still here: a rescue file from a conflict test, a `subject copy.md` from a duplicate. Both
       * make a locator ambiguous, and the failure reads as the feature being broken.
       *
       * This removes the harness's **own** scratch directories under the system temp folder, the
       * same category as the mock soil's `--remove`. Nothing here can reach a registered folder of
       * the operator's: the path is composed from `tmpdir()` and a literal prefix.
       */
      rmSync(folder, { recursive: true, force: true })
      mkdirSync(folder, { recursive: true })
      // `subject.md`, not `readme.md`: the tree is a FLAT list of rows, so a locator matching
      // "readme" would also match the top-level `readme.md` — which is how the rename test kept
      // renaming the shared fixture out from under every other test in the other engine.
      /**
       * **`rescue` gets a document over the 64 KiB `keepalive` cap, and that is the whole point of
       * it.** Added 2026-08-15 when §12's `keepalive` was implemented.
       *
       * A `keepalive` request **survives the page teardown** — that is what it is for — and it also
       * escapes Playwright's route interception at that moment, at both page and context level;
       * both were tried, and the file was written to disk either way. So the rescue scenario cannot
       * be built from a small document any more: the save simply lands, and the app correctly
       * declines to offer work that is already saved.
       *
       * **What is left is the case the rescue is still genuinely for**: a body above the browser's
       * cap gets no `keepalive`, so it dies with the tab. `open-items.md` carries that residual, and
       * this fixture is how it is tested rather than asserted.
       */
      /**
       * **The truncation folders get a body big enough for "under half" to be unambiguous.** §13.2
       * blocks a save at zero bytes *or* below half the loaded count, and the default fixture is 32
       * bytes — where "half" is a handful of characters and the test would be measuring typing
       * accuracy rather than the guard.
       */
      /**
       * **The drawn-marker document, and it gets its own folder because its test TYPES.**
       *
       * The first version of that test typed into the shared `notes.md`, which three other suites
       * read. That is the failure this whole block exists to prevent — a mutating test on a shared
       * fixture, whose damage lands on whichever suite happens to run next. Caught before it ran in
       * anger; the pattern was already here and I reached past it.
       */
      const markersBody = [
        '# Subject', '', 'the scratch document', '',
        '- a bullet, which should draw as a circle',
        '- a second one, so a single-item list cannot pass by accident', '',
        '1. a numbered item, whose number must stay on screen',
        '2. and its neighbour', '',
        '> a quoted line, whose angle bracket should not be on screen', '',
        'Prose with `inline code` in it, whose backticks are also concealed.', '',
        '```javascript',
        'function greet(name) {',
        '  return `hello, ${name}`',
        '}',
        '```', '',
        '| Column | What it holds | Notes |',
        '|---|---|---|',
        '| One | A short value | Aligned by the pipes |',
        '| Two | A longer value | 1,234 |', '',
        '- [ ] an unticked box',
        '- [x] a ticked one', '',
      ].join('\n')
      const body = purpose === 'markers'
        ? markersBody
        : purpose === 'rescue'
        ? `# Subject\n\nthe scratch document\n${'filler paragraph, long enough to matter.\n'.repeat(1800)}`
        : purpose.startsWith('truncate-')
          ? `# Subject\n\nthe scratch document\n${'a paragraph worth keeping.\n'.repeat(60)}`
          : '# Subject\n\nthe scratch document\n'
      writeFileSync(join(folder, 'subject.md'), body)
      // A destination to move INTO, inside the same scratch folder.
      mkdirSync(join(folder, 'destination'), { recursive: true })
      /**
       * The capture folder gets an inbox to capture into. Empty — the test's own file is the only
       * thing that should ever be in it, so a stray row means the wipe above did not happen.
       */
      if (purpose === 'capture') mkdirSync(join(folder, '01-inbox'), { recursive: true })
    }

    /**
     * **The formatting bar gets its own copy of the sample, per engine.**
     *
     * All four format-bar tests drove the shared `orchard/notes.md`, and the first of them **bolds
     * a selection in it** — so the document the later tests assert against depends on what the
     * other engine's worker has already done to it. It failed as "the bar lights up for the format
     * the caret is inside": a caret placed in what should be plain prose landed inside `**` markers
     * written by the *other* browser, seconds earlier.
     *
     * It survived a fixture-seeding fix because seeding was never the whole cause — concurrent
     * mutation of one file by two engines is. The scratch-folder pattern already solved this for
     * `files-tab`; this extends it to the suite that needs the rich document rather than a stub.
     */
    /**
     * **The template Phase 8 scaffolds from, one per engine.**
     *
     * Per engine because the template *registry* is server-global: both projects run against one
     * server, so a template named `Op` added by Chromium is still there when WebKit adds its own,
     * and the server refuses a duplicate name — correctly. The suite has met this shape twice
     * before (the shared tree, then the shared sample document) and the answer both times was one
     * copy per engine.
     *
     * Its shape is the real problem in miniature: a file to copy verbatim, and an **empty folder
     * held open by a `.gitkeep`**, which §3's dot rule was silently dropping from every copy.
     */
    const template = join(E2E_TREE, '02-projects', `template-source-${project}`)
    rmSync(template, { recursive: true, force: true })
    mkdirSync(join(template, '00-context'), { recursive: true })
    mkdirSync(join(template, '01-inbox'), { recursive: true })
    writeFileSync(join(template, '00-context', 'context-template.md'), '# context\n')
    writeFileSync(join(template, '01-inbox', '.gitkeep'), '')

    /**
     * **A project with one task card, per engine, for the slide-over's live-update test.**
     *
     * Its own project rather than a lane added to `orchard` for the reason every entry above has
     * its own folder: that test rewrites the file **from outside the browser** while the panel is
     * holding it open, and the shared fixtures are read by tests in the other engine at the same
     * time. It is also the reason the heading never changes — the board card is titled from the
     * `#` line, so a rewrite that touched it would move the card the test is asserting against.
     */
    const panelLive = join(E2E_TREE, '02-projects', `scratch-${project}-panel-live`)
    rmSync(panelLive, { recursive: true, force: true })
    mkdirSync(join(panelLive, '02-work', 'tasks', 'urgent'), { recursive: true })
    writeFileSync(
      join(panelLive, '02-work', 'tasks', 'urgent', 'valve.md'),
      '# Valve\n\nthe text this test starts from\n',
    )

    /**
     * **A project with two lanes, per engine, for the quick-add.** Its own project because this
     * test *writes a file into a lane* — a shared board would mean one engine's new card arriving
     * in the middle of the other engine's count, and the card is the assertion.
     *
     * Cleared on every config load, so yesterday's `feed-the-goats.md` is not still sitting in the
     * lane making the locator ambiguous.
     */
    const quickAdd = join(E2E_TREE, '02-projects', `scratch-${project}-quick-add`)
    rmSync(quickAdd, { recursive: true, force: true })
    mkdirSync(join(quickAdd, '02-work', 'tasks', '01-urgent'), { recursive: true })
    mkdirSync(join(quickAdd, '02-work', 'tasks', '02-next'), { recursive: true })
    // One card, so the lanes are certainly drawn and the "it went into THIS lane" assertion has
    // something to be distinguished from.
    writeFileSync(
      join(quickAdd, '02-work', 'tasks', '02-next', 'existing.md'),
      '# Existing task\n\nseeded, so Next is not empty\n',
    )

    /**
     * **A board nobody else writes to, for the Refresh control.** That test adds a file from
     * *outside* the browser and then asserts a card count, so it cannot share a project with the
     * quick-add suite — which adds cards of its own — or with the slide-over's live-update case.
     */
    const boardRefresh = join(E2E_TREE, '02-projects', `scratch-${project}-board-refresh`)
    rmSync(boardRefresh, { recursive: true, force: true })
    mkdirSync(join(boardRefresh, '02-work', 'tasks', '02-next'), { recursive: true })
    writeFileSync(
      join(boardRefresh, '02-work', 'tasks', '02-next', 'first.md'),
      '# First task\n\nthe one that is here before the test starts\n',
    )

    /**
     * **A board for the drag NFR.** One card in `01-urgent`, an empty `02-next` to drop it into.
     * Its own project because a drag *moves a file*, and every other board fixture is being counted
     * by somebody.
     */
    const boardDrag = join(E2E_TREE, '02-projects', `scratch-${project}-board-drag`)
    rmSync(boardDrag, { recursive: true, force: true })
    mkdirSync(join(boardDrag, '02-work', 'tasks', '01-urgent'), { recursive: true })
    mkdirSync(join(boardDrag, '02-work', 'tasks', '02-next'), { recursive: true })
    writeFileSync(
      join(boardDrag, '02-work', 'tasks', '01-urgent', 'the-dragged-one.md'),
      '# The dragged one\n',
    )

    /**
     * **Four boards for §18.5's Change status**, one per case, because three of the four MOVE a
     * file and a shared fixture would make each case depend on the order of the ones before it.
     * The lane folders are numbered so the board draws them as "Next" and "Doing".
     */
    /**
     * **Three, not four.** `-panel` was cut 2026-08-13: that case only opens a menu, so it shares
     * the non-mutating `-same` project. Every scratch project here is seeded **per engine** and the
     * board's filter enumerates all of them, so a fixture that exists for no reason taxes every
     * board test in the suite — which is measured, not theorised: the tree reached 69 projects and
     * two unrelated specs began missing their deadlines.
     */
    for (const purpose of ['', '-same', '-phone']) {
      const status = join(E2E_TREE, '02-projects', `scratch-${project}-change-status${purpose}`)
      rmSync(status, { recursive: true, force: true })
      mkdirSync(join(status, '02-work', 'tasks', '01-next'), { recursive: true })
      mkdirSync(join(status, '02-work', 'tasks', '02-doing'), { recursive: true })
      writeFileSync(
        join(status, '02-work', 'tasks', '01-next', 'the-moved-one.md'),
        '# The moved one\n',
      )
    }

    /**
     * **A file one level down, for the ancestor half of A3.** The annex's promise is that the editor
     * survives a rename *of any ancestor*, not just of the file — and renaming a folder is how a
     * project moves, so it is the case that carries whole trees.
     */
    const ancestor = join(E2E_TREE, '02-projects', `scratch-${project}-ancestor`)
    rmSync(ancestor, { recursive: true, force: true })
    mkdirSync(join(ancestor, 'inner'), { recursive: true })
    writeFileSync(join(ancestor, 'inner', 'note.md'), '# Note\n\nliving under a folder\n')

    /**
     * **A conversation, per engine.** §14's surface: a preamble, two messages from two authors, and
     * the two files that must stay ordinary documents no matter how close their names are.
     */
    const room = join(E2E_TREE, '02-projects', `scratch-${project}-chatroom`)
    rmSync(room, { recursive: true, force: true })
    mkdirSync(room, { recursive: true })
    writeFileSync(join(room, 'chatroom.md'), [
      '# Orchard planning',
      '',
      '## M1 -- Ada',
      '',
      'The first thing, with **bold** in it.',
      '',
      '## M2 -- Ellis',
      '',
      'A reply, and a [draft] that must keep its brackets.',
      '',
    ].join('\n'))
    writeFileSync(join(room, 'chatroom-protocol.md'), '# How a chatroom works\n\n## M1 -- Example\n')

    for (const purpose of ['selection', 'lit', 'toggle', 'csp']) {
      const formatting = join(E2E_TREE, '02-projects', `scratch-${project}-format-${purpose}`)
      rmSync(formatting, { recursive: true, force: true })
      mkdirSync(formatting, { recursive: true })
      writeFileSync(join(formatting, 'sample.md'), SAMPLE_DOCUMENT)
    }
  }
}

/**
 * The browsable area for Settings → Folders, **pointed inside the suite's own sandbox**.
 *
 * Never `$HOME`. The standing rule on this build is that tests run against a mock — the operator: *"we
 * can use real files that are not my actual files… this is why we have a fake soil."* Without this,
 * §11's browse scope defaults to the real home directory and the folder picker would enumerate
 * the operator's actual disk to prove a dialog renders.
 *
 * `candidate/` is what the registration test adds: outside `E2E_TREE`, so it does not overlap the
 * already-registered root, and outside any git repository, so it exercises §11's backup warning and
 * the typed override rather than skipping straight past them.
 */
if (process.env['TEST_WORKER_INDEX'] === undefined) {
  for (const project of ['chromium', 'webkit']) {
    // One candidate per engine: both run against one server, and a folder registered by the first
    // is already registered when the second arrives — which would read as a failure of the screen.
    const candidate = join(E2E_SANDBOX, `candidate-${project}`)
    rmSync(candidate, { recursive: true, force: true })
    mkdirSync(candidate, { recursive: true })
  }
}

/**
 * **Resolved, and this is not incidental.** On macOS `tmpdir()` is `/var/folders/…` and `/var` is a
 * symlink to `/private/var`. §11's scope check compares `realpath`'s answer against the scope root
 * — that is the second of its two checks, the one that catches a planted symlink — so a scope named
 * *through* a symlink refuses everything inside it, including itself.
 *
 * It fails closed, so it is not a hole. It presented as the picker sitting on "Loading…" forever.
 */
export const E2E_BROWSE = E2E_SANDBOX

writeFileSync(
  join(stateDir, 'registry.json'),
  JSON.stringify({ roots: [{ id: E2E_ROOT_ID, absolutePath: E2E_TREE }], deregistered: [] }),
)

export default defineConfig({
  testDir: 'test/e2e',
  // Refuses to run at all unless the server answering is provably this application. See the file.
  globalSetup: './test/e2e/global-setup.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,

  /**
   * ONE WORKER, and this is a workaround for a live defect rather than a tuning choice — so it is
   * written down instead of quietly set.
   *
   * The rate limiter is keyed on `socket.remoteAddress` (`listener.ts:270`) at 20 requests/second.
   * Every browser in this suite connects from `127.0.0.1`, so they all draw on **one shared
   * bucket**. Run in parallel, a page load's shell + module + stylesheet + manifest across two
   * engines exceeds it, requests get refused, and tests fail as "the background is transparent" or
   * "the app did not mount" — which reads as a browser bug and is not one.
   *
   * That is not merely a test-harness annoyance. It is the same defect the security review ruled on: behind
   * `tailscale serve` every client's `remoteAddress` is `127.0.0.1`, so on the tailnet listener the
   * limiter and the connection cap are **global rather than per-client**, and one device can throttle
   * every other. The suite reproduced it by accident.
   *
   * Raise this once the keying is fixed. Until then, parallelism here measures the limiter, not the
   * application.
   */
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    /**
     * THE TAILNET LISTENER, not the local one — and this is a real distinction, not a port choice.
     *
     * `bootstrap.ts` builds the two listeners deliberately asymmetrically: the local listener
     * carries the privileged handlers and is given **no asset map at all**, so it serves no UI. The
     * client is reached only through the tailnet listener, which is the sole `tailscale serve`
     * target. Privilege is decided by which listener accepted the connection.
     *
     * Pointed at the local port, every browser test 405s on `/` — which is the design working, not
     * a fault. A test suite that "fixed" that by serving assets on the local listener would be
     * dissolving the privilege separation to make its own assertions pass.
     *
     * 127.0.0.1 rather than localhost: both are allowlisted, but testing through the name would put
     * DNS in the path of a security assertion.
     */
    baseURL: `http://127.0.0.1:${PORT_TAILNET}`,
    trace: 'on-first-retry',
  },
  webServer: {
    // Builds first. `npm run ci` does not build, so without this the server would start against a
    // stale or absent `dist/` — and `loadDist` hard-fails on an absent one, which would read as a
    // broken test rather than a missing step.
    /**
     * **`build:e2e`, NOT `build` — the suite must not write the product's bundle.**
     *
     * `npm run build` emits to `dist/` and `dist-server/`, which is exactly what the launchd server
     * loads at startup. So every run of this suite replaced the running product, and a restart
     * during one served whatever the suite had last built. On 2026-08-22 that cost the operator a day on
     * a build with two dead controls, fixed by rebuilding from `main`.
     *
     * The sharper version is mutation testing: the source is deliberately broken and rebuilt to
     * prove a test catches it. A restart at that moment serves code broken on purpose.
     *
     * These emit to `dist-e2e/` and `dist-server-e2e/`, and the server is pointed at the first by
     * `SOIL_DIST_DIR` — an environment variable it already had.
     */
    command: 'npm run build:e2e && npm run serve:e2e',
    url: `http://127.0.0.1:${PORT_TAILNET}/`,
    // OFF, unconditionally — not `!process.env.CI`. Reusing whatever already answers on a port is
    // how a suite ends up testing a process it did not start and cannot identify. The local
    // iteration speed it buys is not worth a green run against a stranger.
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      SOIL_PORT_LOCAL: String(PORT_LOCAL),
      SOIL_PORT_TAILNET: String(PORT_TAILNET),
      SOIL_STATE_DIR: stateDir,
      SOIL_BROWSE_HOME: E2E_BROWSE,
      /**
       * **The suite's own rate limit — the shipped app never sees these.** the ruling,
       * 2026-08-14. `test/e2e/limits.ts` holds the numbers, the measurement behind them, and what
       * running the browser tests above the shipped size costs.
       *
       * The same concession this file already makes for `workers: 1`, applied to the sustained rate
       * rather than to concurrency: *"parallelism here measures the limiter, not the application."*
       */
      SOIL_RATE_PER_SECOND: String(E2E_RATE_PER_SECOND),
      SOIL_RATE_BURST: String(E2E_RATE_BURST),
    },
  },
  projects: [
    /**
     * **Chromium keeps `retries: 0`, inherited from above, and that is the load-bearing half of the
     * decision below.** A flake here is not covered by the WebKit finding and must be fixed rather
     * than absorbed. `board-refresh.spec.ts` is currently intermittent on this engine and is
     * undiagnosed — leaving Chromium strict is what keeps that on the list.
     */
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },

    /**
     * WebKit is not optional coverage. The operator's target is an installed web app on iOS — confirmed
     * again 2026-08-14: *"it's going to be ran on safari as a… bookmark to desktop of the phone"* —
     * and the whole §15 recovery design exists because of a Safari-specific suspension behaviour.
     * **This is the production browser, which is exactly why the retry below is uncomfortable and
     * why it is scoped to one engine and written out in full rather than set quietly.**
     *
     * ONE RETRY, FOR A HANG IN THE BROWSER ITSELF. Roughly once per full run — after ~130 pages have
     * been created in a single WebKit process — a fresh page stops issuing requests. Not slowly:
     * **not at all**. The evidence, all of it measured on 2026-08-14 and kept in `open-items.md`:
     *
     * - A watchdog inside the hanging navigation listed outstanding requests ten seconds in and
     *   reported **none — nothing was ever requested**. The server is never asked.
     * - A lag probe in `main.ts` reporting any pause over 400 ms produced **zero** events across a
     *   full run. The server's event loop is not blocked.
     * - `goto` given a **120-second** timeout still never returned, so it is not a queue draining.
     * - Chromium alone: **134 of 134**. Reproduced with every line of P12 reverted to HEAD.
     * - Closing the `EventSource` on `pagehide` — WebKit's known lingering-connection behaviour —
     *   made no difference, and was reverted rather than kept.
     *
     * **What this retry may and may not hide.** It cannot hide a reproducible failure: a real defect
     * fails twice and the suite still goes red. It *can* hide a genuinely intermittent product bug in
     * the production browser, and that is the price. Playwright reports a retried pass as **flaky**
     * rather than silently — so the signal survives as a warning instead of a failure.
     *
     * **What would invalidate this and put it back on the table:** flaky results appearing in more
     * than one test per run, a flake whose failure is an assertion rather than a navigation that
     * never starts, or the same test flaking repeatedly. Any of those is a different animal from the
     * hang described above and must not be absorbed by a line written for that hang.
     *
     * **Remove this when Playwright is next updated** and check whether it is still needed — a
     * browser-process hang is the class of defect a version bump fixes. Pinned at **1.62.0** today;
     * updating is a dependency change and therefore the operator's, under §2.
     */
    { name: 'webkit', retries: 1, use: { ...devices['Desktop Safari'] } },
  ],
})
