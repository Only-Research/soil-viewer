# Contributing

Thank you for looking. A few things about this repository are unusual, and knowing them first will
save you an afternoon.

## Read the comments before the code

Roughly half of the source is comment. That is deliberate and it is the most useful thing here. Most
of them record *why* a control is shaped the way it is, and a great many record a specific way an
earlier version was wrong — with the date, the symptom, and what it cost. Where a comment claims a
control works, there is generally a test that fails if it stops working.

The corollary matters more than the comments themselves: **a comment that no longer matches its code
is treated as a defect here, not as untidiness.** It is the failure this codebase has had to fix in
itself more often than any other. If you change behaviour, change the paragraph above it in the same
commit.

## The specification is real

`00-context/spec.md` is the document the source cites. A `§7` or `§13.5` in a comment means a section
of it; `design.md` carries the `§4.x` references. **MUST / MUST NOT in that document is binding**, and
a test named after each one exists. A test enforces that every `§` cited anywhere in the code
resolves to a section that exists, so a citation cannot rot quietly.

If you believe a rule in the spec is wrong, change the spec in the same pull request and say why. Do
not leave the two disagreeing.

## Tests

```
cd app
npm ci --ignore-scripts --no-offline
npx playwright install --with-deps chromium webkit    # once
npm run ci
```

`npm run ci` runs everything CI runs, including the byte-fidelity gate. It takes about ten minutes.

Everything runs against a **generated fake tree**, never against real files. It is built outside the
repository, one per checkout.

### A test that cannot fail is worse than no test

This is the standard applied to new tests here, and it is applied to old ones too — several were
deleted or rewritten because they could not fail.

Before you submit a test, **break the thing it tests and watch it go red.** If it stays green, the
test is decorative. Findings from doing exactly that are recorded throughout the suite; a guard that
ran before the thing it was watching, a snapshot compared against itself, an environment variable
that was never set. All three passed for weeks.

## What will be refused

- **A delete.** There is no verb that removes a file or folder, and there will not be one. Everything
  destructive is a move, a copy, or an archive-then-verify.
- **Widening a path check.** Path handling is the security model. If a path is refused and you think
  it should not be, that is a conversation before it is a patch.
- **An `eslint-disable`.** Disable comments are ignored for `src/` and an unused one is an error. The
  rules there are security controls rather than style.
- **A new runtime dependency in the server.** It runs on Node's standard library and nothing else,
  and that is a property worth more than any convenience.

## Scope

This is a Mac application today. Ports to other platforms are welcome in principle; see the platform
note in the README for what would actually have to change.
