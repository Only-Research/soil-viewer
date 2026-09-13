# Soil Viewer — design packet

**Direction 1a, "Left Rail" — specified for build**
Date: 2026-08-15 · From: Claude Design · For: the builder

Companion files: `Soil Viewer — three directions` (the four options as presented) and `Soil Viewer — Left Rail drill-down` (every screen in this packet, at size). This document is the written half; the drill-down is the visual half. They are meant to be read together.

---

## 1. The decision, and what it costs

the operator chose direction 1a. It is the literal read of README §6.1: the shell of their existing Mac app, brought over. Nothing in the palette changes. The work is layout, density, and the two components that carry most of the app's surface area — the row and the card.

**Settings on desktop becomes the gear in the sidebar header.** That is the one placement question the brief left open, and it is the answer 1a implies. The phone keeps its strip at the foot of the Files screen, untouched. Both of the operator's statements on 2026-08-15 remain true, because they were about the phone; the desktop gear is the Mac app's own arrangement, which is what they were pointing at.

**Live moves into the sidebar footer**, beside Settings. That ends the 21×25px overlap with Refresh, because the two are no longer in the same bar.

**The project picker moves into the sidebar** as a "Showing" list. The consequence worth naming: *Tasks before a project is chosen stops being a state.* There is no screen holding one dropdown, because the default is All projects and the sidebar shows what else exists. The same mechanism serves Inbox, where the sidebar lists the inbox folders.

### Removed, with reasons

- **The path on a task card.** Removed, not shortened. Every card in a lane sits in the same folder, so the line was identical down the whole column — no information at the point it was read, and ten lines of cost on a phone. The path stays in the document header, one line, tail-first; Copy path still yields the whole string.
- **Side-scrolling lanes on the phone.** Replaced with lane chips. Three 288px columns on a 390px screen never show one whole, so the gesture costs a swipe before anything can be read.
- **Per-group capture fields in the Inbox.** Replaced with one compose screen. Forty-four rows with a field above each group is why the page reads long and empty, and the field never showed what file it would create.
- **Nothing else.** The bottom tab bar, the Settings strip, the scroll retreat and the Projects side panel all stay exactly as built. No working code is deleted to ship this.

---

## 2. Light and dark

**Dark only. There is no light theme in this packet and none is implied by it.** Every value below is a dark-surface value; the card lift in particular is an inset white-tinted hairline that only reads on a dark ground and would have to be re-derived, not inverted, for a light one. If a light theme is ever wanted, treat it as its own pass.

---

## 3. Tokens

Same shape as `app/src/client/tokens.css`. Everything inherited is unchanged — the palette is preserved exactly, per the annex. Additions are marked **NEW** and exist because the enforcement script rejects an invented hex in a rule.

### Unchanged

```css
/* Backgrounds */
--bg-primary: #1c1b1a;        --bg-secondary: #242322;
--bg-tertiary: #1a1918;       --bg-hover: #2c2b29;
--bg-selected: #2a2926;       --bg-selected-accent: #252320;
--bg-surface: #282826;

/* Text */
--text-primary: #ece9e1;      --text-secondary: #a09d95;
--text-muted: #8a877f;        --text-dim: #5e5c57;

/* Borders */
--border-primary: #2f2e2b;    --border-secondary: #262523;

/* Accent */
--accent-teal: #5b9fa6;       --accent-teal-dim: #4a8389;
--accent-teal-soft: rgba(91, 159, 166, 0.1);

/* Status + lanes */
--status-active: #34d399;     --status-complete: #60a5fa;
--status-paused: #d4a84b;     --status-draft: #9a9893;
--lane-todo: #60a5fa;  --lane-doing: #d4a84b;  --lane-done: #34d399;
```

### NEW — card lift

The entire "alive" treatment is these three values.

```css
--lift-top:         rgba(236, 233, 225, 0.05);  /* inset top hairline, rest  */
--lift-top-hover:   rgba(236, 233, 225, 0.08);  /* inset top hairline, hover */
--lift-top-raised:  rgba(236, 233, 225, 0.07);  /* inset top hairline, drag  */
```

### NEW — monogram tints

Inbox source marks. Colour derived from the folder name by the same hash the chatroom already uses for authors. Four buckets, each an existing hue at 14% over `--bg-primary`.

```css
--mono-bg-1: rgba(91, 159, 166, 0.14);   --mono-fg-1: #5b9fa6;
--mono-bg-2: rgba(212, 168, 75, 0.14);   --mono-fg-2: #d4a84b;
--mono-bg-3: rgba(96, 165, 250, 0.14);   --mono-fg-3: #60a5fa;
--mono-bg-4: rgba(52, 211, 153, 0.14);   --mono-fg-4: #34d399;
```

### Type

Weights and font stacks unchanged. Existing size ladder unchanged.

```css
--weight-base: 300;   --weight-content: 400;
--weight-emphasis: 500;   --weight-strong: 600;
```

**NEW — size ladder additions.** The ladder stopped at 1.00rem and the editor's own sizes were hard-coded; these name them. Values in rem.

```css
--size-list-subject:  0.94   /* 15px — inbox subject, tree row, phone   */
--size-card-title:    1.00   /* 16px — phone task card title            */
--size-screen-title:  1.19   /* 19px — phone screen title               */
--size-prose-body:    1.00   /* 16px — editor body, both widths         */
--size-prose-h2:      1.19   /* 19px                                    */
--size-prose-h1-sm:   1.63   /* 26px — phone                            */
--size-prose-h1:      2.00   /* 32px — desktop                          */
```

Letter-spacing, unchanged:

```css
--ls-prose: -0.008em   --ls-row: -0.01em   --ls-h2: -0.015em
--ls-h1: -0.02em       --ls-wordmark: -0.025em
--ls-section-label: 0.01em    --ls-count: 0.02em
```

### NEW — spacing

A 4px grid. Every gap and pad in this packet is one of these; nothing is off-grid.

```css
--space-1: 4px    --space-2: 8px    --space-3: 12px   --space-4: 16px
--space-5: 20px   --space-6: 24px   --space-8: 32px   --space-10: 40px
--space-11: 44px  --space-14: 56px
```

### NEW — touch floors

Named so they can be asserted, not remembered.

```css
--touch-chip: 40px    /* lane chips — the brief's 40px row floor        */
--touch-row: 44px     /* tree rows, header text buttons                 */
--touch-menu: 52px    /* sheet rows — above the 44px menu floor         */
--fab-size: 56px      /* inbox compose button                           */
```

### Radii, shadows, motion — unchanged

```css
--radius-sm: 8px  --radius-md: 12px  --radius-lg: 16px  --radius-xl: 20px
--radius-full: 9999px

--shadow-sm: 0 1px 3px rgba(0,0,0,.15)   --shadow-md: 0 4px 16px rgba(0,0,0,.2)
--shadow-lg: 0 8px 32px rgba(0,0,0,.3)   --shadow-xl: 0 16px 56px rgba(0,0,0,.4)

--motion-button: .15s  --motion-row-bg: .12s  --motion-chevron: .15s
--motion-sidebar: .2s  --motion-slide-over: .18s  --motion-toast: .2s
```

### Layout — existing unchanged, two added, two changed

```css
--sidebar-width: 272px          --sidebar-width-collapsed: 44px
--nav-bar-height: 36px          --measure: 720px
--lane-width: 288px             /* CHANGED from 280px — 4px grid        */
--board-tail: 24px              /* NEW — padding after the last lane    */
--slide-over-width: min(560px, 45%)    /* CHANGED from min(560px, 70%)  */
--modal-wide: 580px   --modal-medium: 520px
--modal-small: 360px  --modal-narrow: 400px
```

**The two changed values, both deliberate.** `--lane-width` 280→288px puts the lane on the 4px grid and stays inside the annex's 260–320 range. `--slide-over-width` 70%→45% is the desktop half of the operator's number-one complaint; on a phone the panel is not a panel at all (see §4.6).

---

## 4. Screens

### 4.1 The shell

**Desktop.** Sidebar 272px, `--bg-primary`, 1px `--border-primary` right. Header block pad 20/16/14. Wordmark "the soil" at `--size-wordmark`/500/`--ls-wordmark` in `--accent-teal`, with "N registered folders" (**the packet says *workspaces*; spec §21 fixes the term as *registered folder* and wins**) beneath at `--size-micro` `--text-dim`. Right of that row: gear and collapse chevron, 26px each, transparent, 1px `--border-primary`, `--radius-sm`. Below, `+ New` full-width and filled teal with `--bg-primary` text — the only filled button in the app.

Four tabs as text, 16px gap, `--size-row`; active is `--text-primary`/500 with a 1px teal underline 4px below. Order fixed: Files · Tasks · Projects · Inbox. Then a 1px rule and the tab's own second section — tree for Files, "Showing" for Tasks and Projects, "Inboxes" for Inbox. Footer pinned: Settings left, Live right, both `--size-menu-alt` `--text-muted`, above a 1px rule.

**Collapsed** is 44px holding only the expand chevron, centred, 22px down. `width .2s ease`. Nothing else survives; the tabs do not become icons.

**Phone.** No sidebar. Header 96px, or 110px where a chip row sits under the title. Title at `--size-screen-title`/500 with a count beside it. Tab bar 64px plus 22px home-indicator clearance. Settings is a 48px strip above the tab bar, Files screen only. Scroll retreat unchanged. Safe-area insets on every fixed edge.

### 4.2 Files — tree

Rows 32px desktop, 40px phone (**the packet proposed 44; §18 ruled 40 and the code implements 40** — `tokens.css` records the refusal). **One mark per folder, not two:** the disclosure triangle is the folder's mark and the folder glyph is deleted — that is the double-arrow fix, and it removes an icon rather than a control. A file gets no leading glyph; indentation carries it. A non-document shows its type as dim caps after the name (`XLSX`) instead of an icon.

Indent step 14px desktop, 16px phone. Folder names render verbatim, always. File names show hyphens as spaces in the tree and keep the true name in the document header. Every row carries `⋯` at its end, permanently visible at both widths — no hover-to-reveal. Selection is a 2px `--accent-teal` left border plus `--bg-selected-accent`; every other row reserves 2px transparent so nothing shifts.

**Empty pane, first run included:** centred, max 340px. "Nothing open" at `--size-modal-title`/500 `--text-secondary`, then one `--text-dim` line naming the action.

### 4.3 The document header — shared by Files and the card panel

**One line, both widths, both places.** File name at `--size-editor-filename`/500, then the path at `--size-micro` `--text-dim`, **tail-first with a leading ellipsis, truncating from the left**. Implementation: pre-trim server-side to the last two segments, prefix `…/`, then `white-space:nowrap; overflow:hidden`. Never wraps, never two lines, at any width. The front of a path is `02-projects/` on nearly everything, so the tail is what identifies the file.

Phone adds a back control above the name in `--accent-teal`, **naming where you came from**: `‹ 02-work`, `‹ Urgent`, `‹ Inbox`. Swipe-from-left-edge performs the same action wherever that control appears.

**The format toolbar moves to the foot of the surface** at both widths — near the thumb on a phone, clear of the first heading on desktop. 36px desktop, 44px phone, 1px top rule, dim `saved` at its right end. Still one always-editable surface: no read mode, no toggle.

### 4.4 Tasks — board

**Desktop.** Lanes 288px, 16px gap, 20/24px board pad, and `--board-tail` 24px after the last lane so its quick-add is never clipped. Lane header: 6px status dot, name at `--size-row`/500, count right at `--size-micro`/`--ls-count`, 12px pad, 1px bottom rule. Dot: `--lane-doing` urgent, `--lane-todo` next, `--lane-done` done, `--text-dim` for anything unmapped. Lane-name-to-colour is a lookup; an unknown lane takes the dim dot rather than a guess.

Quick-add sits at the lane foot and, while typing, states the file it will create: `Enter creates chase-the-second-quote.md in 01-urgent`. That is where kebab-case becomes visible on desktop.

**Phone.** Lanes become a chip row in the header: `--touch-chip` 40px minimum height, `--radius-full`, 14px side pad, same dot and count. Active chip is `--bg-selected` with a 1px inset border. Below, one column of full-width cards, 10px apart, 16px side pad.

**Empty lane:** no fill, 1px inset `--border-secondary`, `--radius-md`, two centred lines — the state, then what dropping a card here does to the file.

**Loading:** lane headers render at once with names and no counts, each holding three card-shaped blocks at `--bg-primary`, no border, no text. The board's shape is right before its contents arrive, so nothing jumps.

### 4.5 The card

One component, used by Tasks, Projects and the inbox preview. `--bg-secondary`, `--radius-md`, pad 14/16 desktop and 15/16 phone. The lift is three stacked shadows and no assets:

```css
box-shadow:
  inset 0 1px 0 var(--lift-top),           /* the top edge catches light */
  inset 0 0 0 1px var(--border-primary),
  var(--shadow-sm);
transition: box-shadow var(--motion-row-bg) ease;
```

Title at `--size-list-subject`/300/`--ls-row`, or `--size-card-title` on phone. **A second line only when it differs between cards** — the project name on a cross-project board, nothing at all on a single-project one. Never the path.

| State | Treatment |
|---|---|
| Default | as above |
| Hover | lift → `--lift-top-hover`, shadow → `--shadow-md`. Nothing moves, so nothing reflows under the pointer. |
| Open | bg `--bg-selected-accent`, inset border → `--accent-teal`, `--shadow-md` |
| Focus, keyboard | adds outer `0 0 0 2px var(--accent-teal)`; `:focus-visible` only |
| Dragging | bg `--bg-surface`, `--lift-top-raised`, `--shadow-xl`, `rotate(-1.2deg)` |
| Drop target | the lane, not the card — 1px inset `--accent-teal` on the lane's bounds |
| Disabled | does not occur — a card is never disabled, only absent |

### 4.6 Tasks — card open

**Desktop:** side panel at `min(560px, 45%)`, 1px left border, the shared header, body at the 720px measure, toolbar at the foot. Clicking another card replaces the panel's contents. `✕` closes, Escape closes.

**Phone: a full screen.** No overlay, no sliver of board behind it, no dismiss target to hunt for. `‹ Urgent` and the edge swipe are the only exits and both are labelled or learned. This is what removes the exit problem rather than patching it. **Tasks and Inbox go full-screen; Projects keeps its side panel at both widths**, as ruled.

**Selection model — the two-rows-look-selected defect.** Three states, three treatments that cannot collide:

- *Open*: 2px teal left border + `--bg-selected-accent`, and exactly one row in the app is open at a time.
- *Acted on*, meaning the row whose `⋯` menu is up: `--bg-hover` and nothing else, cleared when the menu closes.
- *Focused*: the 2px teal ring, `:focus-visible` only.

Opening a file must clear the previous open row in the same commit that sets the new one.

### 4.7 Inbox

Rebuilt as a mail app, which is what the operator described. **Every per-group capture field is removed** and replaced by one compose surface: a 56px filled-teal `+` floating bottom-right on phone — 20px from the right edge, 106px from the bottom, clearing tab bar and home indicator — and a `+ New item` button in the header on desktop.

**List row.** Phone: 34px monogram, subject at `--size-list-subject`, first line of the file beneath at `--size-editor-filename` `--text-muted` truncated to one line, relative time right, 12px vertical pad, 1px top rule. Desktop: the same parts on one line — 30px monogram, 280px subject column, preview flexing, time, dot. Unread carries weight 400 and a 6px teal dot; read drops the subject to `--text-secondary` and the preview to `--text-dim`. Times inside today are `--accent-teal`.

**Sort is numeric-aware** — the comparator the file tree already uses — so `Dropped item 2` precedes `Dropped item 10`. Groups are headed by folder name in dim caps with a count; **an empty group is not drawn at all**. The `FILE` column is deleted — it was identical on every row.

**Compose.** Full screen. Cancel / "New item" / Save, each side control with a 44px hit area. Subject at `--size-modal-title` weight 400 and, directly beneath it in mono `--text-dim`, `saves as call-the-roofer.md`, live as you type — the kebab-case conversion made visible before commit, which is the gap the brief names. Then a 56px "Into" row showing the destination with its monogram, defaulting to main, opening a sheet. Then the note body, then the toolbar.

**Destination sheet.** 56px rows: monogram, folder name, path beneath. The default row is marked `01-inbox · default` and check-marked. Naming the default is what stops the control reading as dead — it now says what it governs.

**Item open** is the standard full-screen document with `Move…` promoted into the header beside `⋯`: filing is the whole job of this screen, and Move is how a thing leaves.

**Empty:** "Inbox clear", one dim line saying where new items land, compose button still present — an empty inbox is exactly when you want to add to it.

### 4.8 Row menu, dialogs, and system states

**Row menu.** Dropdown on desktop (210px, 32px rows, `--bg-surface`, `--shadow-lg`), bottom sheet on phone (`--touch-menu` 52px rows, `--radius-xl` top corners, grabber, a header naming the target, an explicit Close). **Same items, same order, both widths:**

New Op · New file · New folder · Rename… · Duplicate · Move… · Copy path · Reveal in Finder (desktop only)

**No Delete, no Archive, no separator implying a destructive group, nothing red anywhere in the app.**

**Dialogs** keep their existing widths. Primary action is teal-filled, secondary is bordered, and they sit right-aligned with the primary last. A dialog that renames or moves shows the resulting file name in mono beneath the field, same rule as compose.

**Errors and conflicts** are a banner across the top of the affected pane: `--bg-surface`, 1px `--border-primary`, `--status-paused` dot, one sentence of what happened and one action. Never red, never a modal, never a toast that vanishes before it is read. A write conflict states both sides and offers Keep mine / Keep theirs — it does not choose.

**Disconnected** flips the sidebar's Live dot to `--text-dim` and the label to "Offline". Nothing else changes; the app stays usable and the editor keeps accepting input.

---

## 5. Component inventory

| Component | Status | Notes |
|---|---|---|
| Sidebar | restyle | gear added, Live moved into footer, second section becomes per-tab |
| Tree row | restyle | folder glyph deleted, ⋯ always present, 44px on phone |
| Document header | **new** | one component serving editor and card panel; owns the path rule |
| Card | rebuild | the lift, seven states, conditional second line |
| Lane | restyle | 288px, dot in header, empty and loading states |
| Lane chip row | **new** | phone only; replaces horizontal lane scrolling |
| Mail row | **new** | monogram, subject, preview, time, unread dot |
| Monogram | **new** | reuses the chatroom's name-to-colour hash |
| Compose screen | **new** | subject, live filename, destination row, body, toolbar |
| Bottom sheet | **new** | one shell for row menu and destination picker |
| Format toolbar | move | head → foot; gains the saved indicator |
| Banner | **new** | errors and conflicts; replaces anything that needed red |
| Empty state | **new** | title + one explanatory line; five placements |

---

## 6. Build order

Sequenced so each step is shippable and visible on its own.

1. **Tokens.** Add the new variables. Nothing changes visually. Lets everything after it pass the enforcement script.
2. **Card and lane.** The lift, the states, the conditional second line, 288px, the board tail. Biggest visible return for the least risk, and it answers "looks basic" directly.
3. **Document header.** Build the shared component, adopt it in the editor and the card panel at once. The path rule lands here and stops recurring.
4. **Phone card and inbox full-screen.** Routing change plus the back control. The operator's number-one complaint, closed.
5. **Selection model.** Three states, one open row invariant. Small, and it removes a whole class of report.
6. **Inbox.** Mail row, monogram, compose, destination sheet, numeric sort, empty groups. The largest single piece.
7. **Shell.** Gear, Live in the footer, project picker into the sidebar, lane chips on phone.
8. **Tree, sheet, banner, empty and loading states.** The remainder.

---

## 7. Open questions

Three things this packet decided provisionally and would rather have confirmed.

**The tinted monograms.** Colour from the folder name adds four tinted circles to a screen that had none. It reuses an existing rule rather than inventing one, but it is the single largest visual addition in the packet. If it is a step too far, the monogram can be a flat `--bg-selected` circle with `--text-muted` initials and nothing else changes.

**Relative times.** These read file mtime, which the app has but does not currently surface. Confirm that is acceptable, and confirm mtime is meaningful for files this system writes.

**Read state.** An item read in the inbox staying visually read is new state. The only honest place to keep it is a last-seen timestamp in config, compared against mtime. If that is unwelcome, drop the dot — everything else in the inbox stands without it.
