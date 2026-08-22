---
name: sync-gtask-schedules
description: "Use the local Codex-owned Gtask MCP to refresh verified public baseline tables for version windows, limited-time activities, recurring challenges, and map catalogs. Trigger when Gtask queues baseline-maintenance research or the user directly asks Codex to maintain a public baseline."
---

# Sync Gtask Schedules

The Gtask MCP is a local Codex maintenance interface. It is not shipped as a user-facing integration; ordinary users consume only validated published baseline updates. Use only the `gtask` MCP tools for application data. Do not run shell commands, edit SQLite directly, inspect authenticated personal data, or read browser cookies.

## Workflow

1. Register with `register_gtask_schedule_agent` using a stable Agent ID and `webSearch: true`. `protocolVersion` is optional diagnostic metadata; the MCP tool schema and each `job.contract` are authoritative, so a cached plugin version must not block the Codex maintainer at registration.
2. Acquire exactly one explicitly scoped job:
   - For a Gtask background prompt, claim exactly its supplied job ID and echo its fixed model and reasoning effort.
   - For a direct user request to maintain public baselines, call `queue_gtask_baseline_maintenance` once for each explicitly requested game/target, retain every returned job ID, and claim only those IDs. Use the conversation's inherited model/reasoning unless the user explicitly requests another supported setting.
   If an exact claim returns `null`, stop that job successfully. Never claim an unrelated pending job or use an omitted `jobId` as a queue shortcut.
3. Read `job.contract` before searching. It is authoritative for target scope, output locale, timezone, required and forbidden fields, field semantics, and completion criteria.
4. Every job is `public_catalog`. Follow `job.contract.workflow`: inspect the supplied `matchCandidates` and current version window, research the complete target-section inventory, verify facts, compare every result with the baseline, and submit only the differences with `apply_gtask_public_schedule`.
   - A maintenance pass is a full-section audit followed by a delta write: create missing rows, update only fields that actually changed, and archive only rows verified obsolete or invalid. Never resubmit unchanged rows merely to record that they were checked.
   - When a fully audited target has no differences, keep `items` empty and report that target through `verifiedUnchangedTargets`. Do not fabricate a write or reuse `verifiedEmptyTargets`, which means the events catalog itself is genuinely empty.
   - `tasks` compares `currentVersionWindow` with verified official timing; submit `versionWindow` only when a field changed, otherwise mark `tasks` unchanged. Keep `items` empty.
   - `events` maintains the limited-time activity baseline and its gameplay tags.
   - `cycles` maintains recurring challenge names, modes, periods, and time windows.
   - `exploration` audits additions, official renames, and two-level parent corrections against the verified map baseline.
5. Use Codex web search autonomously. Prefer official localized sources, then cross-check with reliable wikis or guide communities when official material is incomplete. Confirm official in-game names; do not translate them yourself.
6. Convert source times into absolute ISO-8601 instants using the source server timezone. Never substitute banner, reward-claim, maintenance-compensation, or unrelated event deadlines for a version or challenge window.
7. Treat `job.contract.activityTagCatalog` as a vocabulary, not a checklist. Submit only accurate gameplay tags supported by evidence. If a genuinely reusable mechanic is missing, register one `custom.*` tag with evidence before referencing it.
8. Reuse the exact `matchItemId` for the same semantic item. Omit it only for a genuine addition. Archive only a synchronized candidate positively verified as wrong, duplicated, renamed, reparented, or obsolete; never archive manual/custom data.
9. Report material phases through `update_gtask_schedule_job_progress`: `searching`, `verifying`, `structuring`, and `writing`. The message is an internal diagnostic, not product copy.
10. Submit `contentLocale` exactly as requested. When an `all` job returns `remainingTargets`, continue until every target is complete.
11. Use `fail_gtask_schedule_job` only after useful searches and cross-checks are exhausted. A claimed job must finish or explicitly fail, then exit without claiming a second job.

## Safety

- Baseline maintenance may create, update, or archive only `public_schedule` structure and version-window data.
- Never submit account completion state, challenge records, exploration percentages, credentials, or account identifiers.
- Never read or modify `personal_sync`, manual/custom items, recycle-bin records, database backups, or credential files.
- Public activity data must not include banners, shops, reward tiers, internal stages, or permanent content unless the current contract explicitly permits it.
- Maps remain exactly two levels: `region` and `subregion`.
- MCP enforces types, identity, transactions, and protected-data boundaries; Codex remains responsible for researched public semantics.
- MCP administration is local to Codex. Publishing `updates/catalog.json` distributes only validated public baseline data and never grants end users MCP access.
