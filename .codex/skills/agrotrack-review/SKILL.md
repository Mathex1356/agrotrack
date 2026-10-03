---
name: agrotrack-review
description: Review an AgroTrack implementation or diff for correctness, scope, architecture, tenant isolation, database safety, security regressions, tests, and documentation consistency. Use after a meaningful implementation or when explicitly asked to review AgroTrack changes.
---

# AgroTrack review workflow

Review the implementation independently from the intent of the author.

## Review priorities

Check, in this order:

1. Correctness: does the implementation satisfy the requested behavior?
2. Scope: did it add unrelated or premature work?
3. Tenant isolation: can IDs or relationships cross organizations/farms incorrectly?
4. Database integrity: were migrations, constraints, triggers, indexes, PostGIS behavior or concurrency assumptions weakened?
5. Security: are secrets, sensitive errors, authorization assumptions or unsafe input handling introduced?
6. Regression risk: could existing behavior or data be broken?
7. Tests: do tests exercise the important behavior and failure paths?
8. Documentation: if an architectural contract changed, are the relevant docs consistent?

When reviewing a database change, also use the `database-change` skill.

## Evidence

Prefer concrete evidence from the diff, schema, migrations and tests. Do not report a theoretical issue as a confirmed bug without showing the path that makes it possible.

Distinguish:
- confirmed defect;
- meaningful risk;
- optional improvement.

## Validation

Run focused tests or static checks when they can confirm or reject a finding. Do not change implementation merely to make the review look clean.

## Output

Report important findings first, with file/location when available. Explain the consequence and a concrete correction.

If no material problems are found, say so and list the validations performed plus any residual area that was not exercised.
