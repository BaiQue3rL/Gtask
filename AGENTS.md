# Gtask repository instructions for AI agents

This file is an AI entry point. It is intentionally concise; users are not expected to read or maintain it.

## Project orientation

- Product: **Gtask**, a Windows Electron + Vue 3 + TypeScript + SQLite desktop application for game task, event, recurring-challenge, and map-exploration checklists.
- Current built-in games: Genshin Impact (`genshin`), Honkai: Star Rail (`star-rail`), Zenless Zone Zero (`zenless`), and Wuthering Waves (`wuthering-waves`). The architecture must remain extensible and user-facing copy must not imply the product can never support more games.
- Built-in activities, recurring challenges, maps, and version windows come from persistent verified baselines. Authenticated personal adapters may update only completion/progress on uniquely matched baseline rows; they never own or replace catalog structure. Never reintroduce source switching or personal-owned catalogs.
- Recurring challenges are stable mode definitions driven by automatic rollover rules. Do not publish routine per-period cycle rows; update cycle baselines only when an official schedule rule/anchor changes or a mode is added, removed, or renamed.
- Version countdowns also roll from each game's configured cadence. Do not publish a routine `versionWindow` when the cadence is unchanged; use it only for verified delays, shortened/extended versions, or other exceptions that the automatic rule cannot represent.
- Published hot catalog updates use `updates/catalog.json` and may mutate only `public_schedule` structure through the validated atomic remote-catalog path. They must never contain completion/progress, credentials, or `custom` items; GitHub is authoritative when a mirror diverges.
- Public baseline research is a background MCP maintenance concern, not a product dependency or user-facing workflow. Do not expose Codex/plugin/Agent controls, public-data sync, or onboarding in the renderer.
- Read `docs/sync-architecture-redesign.md` before changing synchronization architecture. Read `docs/next-session.md` for the latest handoff state.
- Never change the product version, create a version tag, or publish a release unless the user explicitly approves that specific version release. Ordinary fixes and release-pipeline tests do not justify a version bump.
- Preserve unrelated user changes and untracked research directories. Never reset or delete the database, credentials, backups, release artifacts, or test references unless the user explicitly requests it.

## Canonical map catalog maintenance

When the user asks to add, correct, audit, calibrate, or update a built-in map baseline, read **all of** `docs/ai-map-catalog-maintenance.md` before editing anything. That document defines:

- the authoritative source file and data shape;
- the two-level hierarchy and game ID mapping;
- stable-key preservation rules for renames;
- verification-time updates;
- required tests and boundaries.

Do not rebuild the map catalog from personal progress and do not invent a third level or an “independent map” node type.

## Routine verification

- Targeted map checks: `pnpm exec vitest run tests/map-catalog.test.ts tests/map-catalog-freshness.test.ts`
- Full tests: `pnpm test`
- Types: `pnpm typecheck`
- Production build: `pnpm build`

If `node` is unavailable in the shell, use the configured workspace dependency runtime rather than installing dependencies into a new drive-root directory.
