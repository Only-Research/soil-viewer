/**
 * `npm run mock:soil` — build the mock tree.
 *
 * Node 24 runs TypeScript directly, so this is a real typechecked, linted module and also the
 * command. No build step, no runner dependency, and **no `npx`** — that stays banned for this
 * build after it reached out to the registry from a drifted working directory.
 *
 * Usage:
 *   npm run mock:soil                 build at the default location
 *   npm run mock:soil -- <path>       build somewhere else
 *   npm run mock:soil -- --list       print the hazards and what each one is for, build nothing
 *   npm run mock:soil -- --remove     delete the tree
 */

import { homedir } from 'node:os'
import { basename, join } from 'node:path'

import { findRepositoryRoot, makeMockSoil, removeMockSoil } from './generate.ts'
import { HAZARD_FILES, NOTABLE, SPECIAL_ENTRIES } from './tree.ts'

/**
 * **Outside the repository, deliberately.** Four reasons, in the order they matter:
 *
 * 1. A path mistake inside the app has to *leave* this directory before it can reach anything
 *    real. If the mock tree lived under `notes/`, every containment check would be one typo
 *    away from the user's actual files rather than a whole directory away.
 * 2. It can never be committed. Fifteen hundred generated files would bury a real diff, and
 *    `git status` in the soil stays honest.
 * 3. Rebuilding deletes it first. Deleting something inside the repository is a scarier operation
 *    than deleting a folder that exists only to be deleted.
 * 4. The operator can open it in Finder and poke at it without being in the repo at all.
 */
/**
 * **`SOIL_MOCK_DIR` overrides where the fake tree lives, and the override matters more than it
 * looks.** Two checkouts of this repository on one machine share `~/soil-viewer-mock` by default,
 * so regenerating it from either one silently rebuilds the fixture the other measures against — a
 * tree one working copy owns and another one trusts. Naming the directory per checkout is what
 * makes two copies genuinely independent rather than merely separate on disk.
 */
const DEFAULT_TARGET = process.env['SOIL_MOCK_DIR']
  ?? join(homedir(), '.soil-viewer-mock',
          basename(join(import.meta.dirname, '..', '..', '..', '..')))

const args = process.argv.slice(2)
const flags = new Set(args.filter(a => a.startsWith('--')))
const target = args.find(a => !a.startsWith('--')) ?? DEFAULT_TARGET

const mib = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MiB`

if (flags.has('--help')) {
  console.log(`
  npm run mock:soil                build the mock tree at ${DEFAULT_TARGET}
  npm run mock:soil -- <path>      build it somewhere else
  npm run mock:soil -- --list      print the hazards, build nothing
  npm run mock:soil -- --remove    delete the tree
`)
  process.exit(0)
}

if (flags.has('--list')) {
  console.log('\nHAZARDS — each of these is a way a filesystem is allowed to misbehave.\n')
  for (const entry of SPECIAL_ENTRIES) {
    console.log(`  ${entry.path}`)
    console.log(`      ${entry.why}\n`)
  }
  const folders = [...new Set(HAZARD_FILES
    .map(([path]) => path.split('/').slice(0, 2).join('/'))
    .filter(p => p.includes('/')))]
  console.log(`  Plain-text hazards live in: ${folders.join(', ')}\n`)
  console.log(`  ${NOTABLE.length} paths are pinned as notable — tests may rely on those.\n`)
  process.exit(0)
}

const repositoryRoot = await findRepositoryRoot()

if (flags.has('--remove')) {
  const removed = await removeMockSoil(target, { repositoryRoot })
  console.log(removed ? `Removed ${target}` : `Nothing at ${target}`)
  process.exit(0)
}

console.log(`Building the mock soil at ${target} ...`)
const report = await makeMockSoil(target, { repositoryRoot })

console.log(`
  ${report.files} files in ${report.directories} directories, ${mib(report.bytes)}

    ${String(report.spine).padStart(4)}  hand-written documents (the readable part)
    ${String(report.bulk).padStart(4)}  generated documents (the scale)
    ${String(report.hazards + report.special).padStart(4)}  hazards in zz-hazards/

  Nothing in it is real. Rebuild or throw it away at any time:

    npm run mock:soil
    npm run mock:soil -- --remove
`)
