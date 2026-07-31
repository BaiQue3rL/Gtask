# Gtask repository instructions for AI agents

This file is an AI entry point. It is intentionally concise; users are not expected to read or maintain it.

## Project orientation

- Product: **Gtask**, a Windows Electron + Vue 3 + TypeScript + SQLite desktop application for game task, event, recurring-challenge, and map-exploration checklists.
- Current built-in games: Genshin Impact (`genshin`), Honkai: Star Rail (`star-rail`), Zenless Zone Zero (`zenless`), and Wuthering Waves (`wuthering-waves`). The architecture must remain extensible and user-facing copy must not imply the product can never support more games.
- Codex is the business-semantic authority for public-data research. Authenticated personal data uses complete adapter-owned snapshots; application code performs deterministic collection, official-ID binding, validation, atomic source switching, and protected-data enforcement. Never reintroduce automatic public/personal fusion.
- Read `docs/sync-architecture-redesign.md` before changing synchronization architecture. Read `docs/next-session.md` for the latest handoff state.
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

If `node` is unavailable in the shell, use the Codex workspace dependency runtime rather than installing dependencies into a new drive-root directory.
