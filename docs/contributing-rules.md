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
3. Every PR must include a written description, not only a title.
4. PR descriptions should include what changed, why it changed, and how it was validated.
5. If a PR intentionally skips a test or leaves known risk, it must document the reason and follow-up plan.

## Roadmap Governance

1. New implementation work must map to an explicit item in `docs/pr-roadmap.md`.
2. New roadmap items must align with scope and success criteria in `docs/prd.md`.
3. Do not start a new implementation branch unless the roadmap has a queued next item.
4. If scope is split into additional micro-PRs, update the roadmap first and document the reason in the PR description.
5. After merge, update roadmap status and links (`In Progress` -> `Merged`, PR link, and next-item pointer) before starting the next branch.

## Definition of Done

A change is done only when:

1. Implementation is complete.
2. Relevant unit tests exist and pass.
3. Existing test suite still passes.
4. The repository is left in a shippable, stable state.
