# Gtask repository instructions for AI agents

This file is an AI entry point. It is intentionally concise; users are not expected to read or maintain it.

## Project orientation

- Product: **Gtask**, a Windows Electron + Vue 3 + TypeScript + SQLite desktop application for game task, event, recurring-challenge, and map-exploration checklists.
- Current built-in games: Genshin Impact (`genshin`), Honkai: Star Rail (`star-rail`), Zenless Zone Zero (`zenless`), and Wuthering Waves (`wuthering-waves`). The architecture must remain extensible and user-facing copy must not imply the product can never support more games.
- Built-in activities, recurring challenges, maps, and version windows come from persistent verified baselines. Authenticated personal adapters may update only completion/progress on uniquely matched baseline rows; they never own or replace catalog structure. Never reintroduce source switching or personal-owned catalogs.
- Map regions are checklist groups: show completed/open-catalog unit counts (`x/x`), derive visible completion from those units, and keep the parent whenever any unit is incomplete or unknown. Personal region percentages are reference data only; never label a local child average as an official total. Regions without catalog children render a same-name second-level row sharing the original item's verified progress and manual action, with a separate presentation key; never persist a duplicate catalog row or personal binding. Real published children replace that self row. Do not expose bulk completion on a region group.
- This ownership boundary is strict: Codex/Agent maintenance decides whether public baseline items or times need additions, updates, deletions, or calibration; the application runtime must never derive those catalog decisions from personal progress.
- Agent work has two explicit modes: baseline maintenance and software maintenance. Baseline maintenance follows the `sync-gtask-schedules` Skill and may only maintain the public baseline. When the user explicitly requests software maintenance, the Codex administrator may use the broader local MCP command surface and repository tools to repair code, data, deployment, or UI within that request. Never switch modes silently or use software-maintenance authority as a shortcut inside a baseline job.
- The only runtime lifecycle exceptions are deterministic application of an already-published rule: recurring challenges and version windows may roll/reset at their published boundary, and limited-time activities may be permanently removed after their published end. Runtime code must not infer a missing rule or time, calibrate a window from personal data, or delete an expired recurring challenge when it cannot roll it safely.
- Recurring challenges are stable mode definitions driven by automatic rollover rules. Do not publish routine per-period cycle rows; update cycle baselines only when an official schedule rule/anchor changes or a mode is added, removed, or renamed.
- Version countdowns also roll from each game's configured cadence. Do not publish a routine `versionWindow` when the cadence is unchanged; use it only for verified delays, shortened/extended versions, or other exceptions that the automatic rule cannot represent.
- Published hot catalog updates use `updates/catalog.json` and may mutate only `public_schedule` structure through the validated atomic remote-catalog path. They must never contain completion/progress, credentials, or `custom` items; GitHub is authoritative when a mirror diverges.
- Public baseline research is a background MCP maintenance concern, not a product dependency or user-facing workflow. Do not expose Codex/plugin/Agent controls, public-data sync, or onboarding in the renderer.
- Read `docs/sync-architecture-redesign.md` before changing synchronization architecture. Read `docs/next-session.md` for the latest handoff state.
- Current public maintenance and publication follow `docs/catalog-maintenance.md`. New facts are compiled into `updates/catalog.json`, which is also embedded in the application. Historical TypeScript seeds are compatibility inputs, not a second place to repeat each catalog edit. Protocol v2 adds verified missing-deadline exceptions and typed published schedule rules/windows; verify client capability before publishing them.
- Never change the product version, create a version tag, or publish a release unless the user explicitly approves that specific version release. Ordinary fixes and release-pipeline tests do not justify a version bump.
- Preserve unrelated user changes and untracked research directories. Never reset or delete the database, credentials, backups, release artifacts, or test references unless the user explicitly requests it.
- Local software updates must not create backups by default (user preference, 2026-09-24). Create a program/data/settings/credential backup only when the user explicitly requests one; do not create rollback copies or holding directories as a substitute. Verify the built program and preserve the existing data, credentials, and settings in place. This overrides older deployment checklists that automatically back up before every update; it does not authorize deleting existing backups or disabling the application's own data-backup features.

## Public baseline conflict resolution

- For the same item, version, and server/timezone, later official corrections and current detailed official rules supersede earlier announcements and stale calendar/cache values for the fields they revise. Apply the correction under the same stable identity. A conflict whose source precedence is established must not cause an eligible item to be omitted, remain indefinitely pending, or require redundant user confirmation.
- Compare the official publication/update order and the actual statements, not just retrieval times or repost dates. Retain the old value, adopted value, source links, and reason in the research record. A newer unrelated page or a page for another server/period does not supersede the applicable rule. Source selection and catalog decisions remain Agent responsibilities, never runtime inference from personal progress.
- Resolve source precedence separately from time precision. Preserve the official wording and distinguish a published schedule baseline from a measured opening time. For an event confirmed open that starts after a version update, when the official maintenance start and expected duration are explicit, the Agent may normalize its start to the announced expected maintenance-completion time; document that basis as nominal, not as an observed actual opening. Do not invent an unsupported time or retain a superseded date merely because the announcement uses conditional wording.

## Maintenance throughput

- The live job's `maintenancePolicy` is the shared maintenance procedure for foreground and background Agents; its implementation is `src/main/ai/baseline-maintenance-policy.ts`. Keep the repository Skill aligned. Source decisions remain Agent-owned; programs validate ownership, decision records, coverage and transactions only.
- Direct application-data maintenance passes `agentId` when queuing to create and claim atomically. Only a claimed/resumed owner may write. Query another owner's job through the read-only status tool; never use repeated claims as polling or silently start substitute jobs.
- Save and reuse conflict decisions. Reopen only for new evidence or an explicit correctionReason identifying an interpretation/structuring error or user correction; never lock a proven error in place. Report pending facts separately, never as verified unchanged. Finalize the batch before checks and reuse unchanged validation; retain the workspace through all delivery steps.

## Canonical map catalog maintenance

When the user asks to add, correct, audit, calibrate, or update a built-in map baseline, read **all of** `docs/ai-map-catalog-maintenance.md` before editing anything. That document defines:

- the authoritative source file and data shape;
- the two-level hierarchy and game ID mapping;
- stable-key preservation rules for renames;
- verification-time updates;
- required tests and boundaries.

Do not rebuild the map catalog from personal progress and do not invent a third level or an “independent map” node type.

## Routine verification

- Default delivery order (user preference, 2026-09-28): after changes, first synchronize the installed local client and verify the result, then push to the remote. Deploy program changes locally; apply baseline-only changes through the supported catalog maintenance/update path. Preserve data, settings, and credentials in place and follow the no-backup preference above.

- Targeted map checks: `pnpm exec vitest run tests/map-catalog.test.ts tests/map-catalog-freshness.test.ts`
- Full tests: `pnpm test`
- Types: `pnpm typecheck`
- Production build: `pnpm build`

If `node` is unavailable in the shell, use the configured workspace dependency runtime rather than installing dependencies into a new drive-root directory.
