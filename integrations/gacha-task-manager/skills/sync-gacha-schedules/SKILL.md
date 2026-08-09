---
name: sync-gacha-schedules
description: "Use the local Gtask MCP to refresh verified public baseline tables for version windows, limited-time activities, recurring challenges, and map catalogs. Trigger when Gtask queues baseline-maintenance research."
---

# Sync Gacha Schedules

Use only the `gacha_task_manager` MCP tools for application data. Do not run shell commands, edit SQLite directly, inspect authenticated personal data, or read browser cookies.

## Workflow

1. Register with `register_gacha_schedule_agent` using a stable Agent ID, `webSearch: true`, and `protocolVersion: "2026-08-09.1"`. Stop on a protocol mismatch.
2. Claim exactly the job ID from the background prompt with `claim_gacha_schedule_job`, echoing its fixed model and reasoning effort. If the result is `null`, stop successfully. Never claim another job.
3. Read `job.contract` before searching. It is authoritative for target scope, output locale, timezone, required and forbidden fields, field semantics, and completion criteria.
4. Every job is `public_catalog`. Follow `job.contract.workflow`: inspect the supplied `matchCandidates`, research required fields, verify facts, match existing identities, and submit with `apply_gacha_public_schedule`.
   - `tasks` calibrates the version window through `versionWindow`; keep `items` empty.
   - `events` maintains the limited-time activity baseline and its gameplay tags.
   - `cycles` maintains recurring challenge names, modes, periods, and time windows.
   - `exploration` audits additions, official renames, and two-level parent corrections against the verified map baseline.
5. Use Codex web search autonomously. Prefer official localized sources, then cross-check with reliable wikis or guide communities when official material is incomplete. Confirm official in-game names; do not translate them yourself.
6. Convert source times into absolute ISO-8601 instants using the source server timezone. Never substitute banner, reward-claim, maintenance-compensation, or unrelated event deadlines for a version or challenge window.
7. Treat `job.contract.activityTagCatalog` as a vocabulary, not a checklist. Submit only accurate gameplay tags supported by evidence. If a genuinely reusable mechanic is missing, register one `custom.*` tag with evidence before referencing it.
8. Reuse the exact `matchItemId` for the same semantic item. Omit it only for a genuine addition. Archive only a synchronized candidate positively verified as wrong, duplicated, renamed, reparented, or obsolete; never archive manual/custom data.
9. Report material phases through `update_gacha_schedule_job_progress`: `searching`, `verifying`, `structuring`, and `writing`. The message is an internal diagnostic, not product copy.
10. Submit `contentLocale` exactly as requested. When an `all` job returns `remainingTargets`, continue until every target is complete.
11. Use `fail_gacha_schedule_job` only after useful searches and cross-checks are exhausted. A claimed job must finish or explicitly fail, then exit without claiming a second job.

## Safety

- Baseline maintenance may create, update, or archive only `public_schedule` structure and version-window data.
- Never submit account completion state, challenge records, exploration percentages, credentials, or account identifiers.
- Never read or modify `personal_sync`, manual/custom items, recycle-bin records, database backups, or credential files.
- Public activity data must not include banners, shops, reward tiers, internal stages, or permanent content unless the current contract explicitly permits it.
- Maps remain exactly two levels: `region` and `subregion`.
- MCP enforces types, identity, transactions, and protected-data boundaries; Codex remains responsible for researched public semantics.
