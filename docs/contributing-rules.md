# Contribution Rules

These are the baseline engineering rules for Codemap.

## Delivery and Commit Discipline

1. Create a dedicated branch for each PR. Do not open PRs directly from `main`.
1. Keep each feature in a single commit whenever practical.
2. Keep commits focused: avoid mixing unrelated refactors with feature work.
3. If a feature is too large for one commit, split it into logical, reviewable commits that each build and pass tests.

## Branch Naming Convention

1. Use one of these branch prefixes: `feat/`, `chore/`, `fix/`, `docs/`.
2. Keep branch names short and descriptive after the prefix (example: `feat/index-impact-command`).

## Testing Requirements

1. Every feature must include unit tests.
2. New behavior must be covered by tests in the same change.
3. Bug fixes should include a regression test when feasible.
4. Do not merge code that reduces test reliability or determinism.

## Pull Request Quality Bar

1. Every PR must leave the system in a stable state.
2. Every PR must pass all automated tests before merge.
3. PRs should include a short summary of what changed, why, and how it was validated.
4. If a PR intentionally skips a test or leaves known risk, it must document the reason and follow-up plan.

## Definition of Done

A change is done only when:

1. Implementation is complete.
2. Relevant unit tests exist and pass.
3. Existing test suite still passes.
4. The repository is left in a shippable, stable state.
