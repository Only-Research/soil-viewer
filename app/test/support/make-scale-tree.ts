/**
 * Builds the synthetic scale tree. Build plan §9: P1 owns "the 10,000-file synthetic tree for
 * scale gates".
 *
 * **Generated, never committed.** 10,000 files in git would bloat every clone for data that is
 * fully described by this function. The generator is the fixture; the tree is its output.
 *
 * The shape mirrors the real soil rather than a flat directory, because the thing being
 * measured is a walk over nested projects with lanes and inboxes — a flat tree of 10,000 files
 * would measure something the app never does.
 */

import { promises as fsp } from 'node:fs'
import { join } from 'node:path'

export interface ScaleTreeShape {
  /** Number of top-level projects. */
  readonly projects: number
  /** Task cards per lane, per project. */
  readonly cardsPerLane: number
  /** Documents in each project's context folder. */
  readonly docsPerProject: number
  /** Nested sub-projects per project. */
  readonly subProjects: number
}

/** Yields ~10,600 files — comfortably over the 10,000 the P1 gate names, without being so far
 *  over that the suite pays for it. Measured, not estimated: 40 projects produced 9,290. */
export const DEFAULT_SHAPE: ScaleTreeShape = {
  projects: 46,
  cardsPerLane: 25,
  docsPerProject: 20,
  subProjects: 2,
}

const LANES = ['01-urgent', '02-next', '03-back-burner', '04-done']

function document(title: string, index: number): string {
  // Frontmatter on roughly half, matching the real tree (985 of 2,054 open with `---`), so
  // the walk exercises the frontmatter path rather than only the fast one.
  const frontmatter = index % 2 === 0
    ? `---\ntitle: ${title}\ntype: note\ntags: [scale, fixture]\n---\n\n`
    : ''
  return `${frontmatter}# ${title}\n\nGenerated fixture body for scale measurement.\n\n` +
    `Some filler so the file is not trivially small and the read is representative.\n`
}

async function writeDoc(dir: string, name: string, title: string, index: number): Promise<void> {
  await fsp.writeFile(join(dir, name), document(title, index))
}

/** Creates the tree under `root` and returns how many files it wrote. */
export async function makeScaleTree(root: string, shape: ScaleTreeShape = DEFAULT_SHAPE): Promise<number> {
  let files = 0

  const projectsRoot = join(root, '02-projects')
  await fsp.mkdir(projectsRoot, { recursive: true })

  const inbox = join(root, '99-inbox-main')
  await fsp.mkdir(inbox, { recursive: true })
  for (let i = 0; i < 50; i++) {
    await writeDoc(inbox, `inbox-item-${i}.md`, `Inbox Item ${i}`, i)
    files++
  }

  for (let p = 0; p < shape.projects; p++) {
    const project = join(projectsRoot, `project-${String(p).padStart(3, '0')}`)
    files += await buildProject(project, shape, p, shape.subProjects)
  }

  return files
}

async function buildProject(
  project: string,
  shape: ScaleTreeShape,
  seed: number,
  remainingDepth: number,
): Promise<number> {
  let files = 0

  const context = join(project, '00-context')
  await fsp.mkdir(context, { recursive: true })
  for (let d = 0; d < shape.docsPerProject; d++) {
    await writeDoc(context, `doc-${d}.md`, `Doc ${d} of project ${seed}`, d)
    files++
  }

  const tasks = join(project, '02-work', 'tasks')
  await fsp.mkdir(tasks, { recursive: true })
  // A lane-less card, so the Uncategorized derivation has something to find at scale.
  await writeDoc(tasks, 'unsorted.md', `Unsorted card ${seed}`, seed)
  files++

  for (const lane of LANES) {
    const laneDir = join(tasks, lane)
    await fsp.mkdir(laneDir, { recursive: true })
    for (let c = 0; c < shape.cardsPerLane; c++) {
      await writeDoc(laneDir, `card-${c}.md`, `Card ${c} in ${lane}`, c)
      files++
    }
  }

  // Ignored content, so the walk is measured with the skip path exercised — the real tree
  // carries 527 .DS_Store and 823 .gitkeep.
  await fsp.writeFile(join(project, '.DS_Store'), 'x')
  await fsp.mkdir(join(project, 'node_modules', 'pkg'), { recursive: true })
  await fsp.writeFile(join(project, 'node_modules', 'pkg', 'readme.md'), '# never indexed\n')

  if (remainingDepth > 0) {
    const nested = join(project, '02-work', 'projects')
    await fsp.mkdir(nested, { recursive: true })
    for (let s = 0; s < shape.subProjects; s++) {
      files += await buildProject(
        join(nested, `sub-${s}`),
        { ...shape, cardsPerLane: Math.max(2, Math.floor(shape.cardsPerLane / 4)), docsPerProject: 4 },
        seed * 10 + s,
        remainingDepth - 1,
      )
    }
  }

  return files
}
