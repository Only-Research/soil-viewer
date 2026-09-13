# Soil Viewer

A local-first workspace over a real folder tree of markdown files. Five views over one truth: **Files**, **Tasks**, **Projects**, **Inbox**, **Boards**.

No database, no metadata layer, no hidden state — **the folder tree is the entire truth.** A task's status is the folder it sits in. Moving a card moves the file. Everything the app knows, it knows by looking.

It runs as a small server on your own machine and is used from any browser, desktop or phone.

## What it is not

Not a notes app that imports your files. Not a sync service. Not an editor that reformats what you wrote. It reads and writes the files that are already there, and gives them back byte for byte.

## How it reads a tree

The app has no configuration screen for any of this. It recognises shapes, and the shapes are the interface:

| Shape | What it means |
|---|---|
| a folder called `projects` | everything directly inside it is a project — **anywhere in the tree** |
| a folder called `tasks` inside a project | its immediate subfolders are the statuses |
| `inbox` | an inbox |
| `archive`, or `_archive` | archived, and shown as such rather than hidden |
| `board-<anything>` | a board |

**A leading number is not part of the name.** `02-projects`, `01-inbox` and `05-archive` are matched as `projects`, `inbox` and `archive`, so you can number folders to control their order on disk without changing what they mean. Names are compared whole, case- and accent-normalised, never by prefix.

**The statuses are whatever folders are actually there.** There is no fixed set of four and no list to keep in step — if you want a status called `waiting-on-legal`, make the folder. The same is true of projects: the rule is the folder's *name*, not its depth or its parents, so an arrangement nobody anticipated still renders.

This is the load-bearing idea. The tree is not the product. The product is the thing that holds a tree of any shape, and a version that only understood one particular layout would have encoded somebody's filing habits into software.

## The commitments, and why they are commitments

- **Files come back exactly as they went in.** The editor holds the real text and paints formatting over it rather than parsing to a document model and serialising back — because the serialising kind is how an editor silently rewrites a file it merely opened. Checked on every commit, byte for byte, in both browser engines.
- **There is no delete.** No menu item, no keystroke, no route removes a file or folder. Removing a
  folder from the app removes it from a list. A file is removed in exactly one place — resolving an
  edit conflict — and only after its bytes are archived, fsynced and read back with matching hashes;
  a mismatch leaves the original where it was. Deleting text in the editor is still your own edit and
  is still saved, with a dialog naming the byte count when a save would remove most of a file.
  *This read "nothing is ever deleted" until 2026-09-01. That was stronger than the code, and an
  overstated safety claim is how the next reader stops checking — the same correction this codebase
  had already made to itself, one layer down, in `resolve-conflict.ts`.*
- **Privilege is decided by which listener a request arrived on**, never by anything in the request. A route that is not privileged for a listener is absent from it rather than refused by it.
- **It sees only what you register.** Paths are validated against the registered root and a path that escapes is refused rather than clamped.

## How this repository is laid out

| Folder | What's in it |
|---|---|
| `00-context/` | This file, plus `spec.md` (the architecture and security specification the source cites) and `design.md` (screens, tokens, type). |
| `app/` | The application — source, tests, and its own configuration. Nothing else. |

## Where to start

- Running it, and the tests → the README at the repository root
- Why a control is shaped as it is → the comment above it, which is generally long and generally the point
- Whether a control still works → the test that fails when it stops

## Status

In use. The file engine, the typed contract and two-listener server, the client, the editor, Files, templates, the Tasks / Projects / Inbox boards, quick-open and first run are built and running, behind roughly 2,600 unit tests, 500 browser tests across both engines, and a byte-fidelity gate over a corpus of more than 1,600 documents.

*(This section read "Pre-build — the environment exists; the application does not" long after the application existed and was in daily use. It is noted rather than quietly corrected, because a stale status line in the file a stranger opens first is a failure worth remembering: the comment said one thing while the code did another, which is the single most common defect this codebase has had to fix in itself.)*
