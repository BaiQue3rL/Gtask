---
name: sync-gtask-schedules
description: "Use the local Codex-owned Gtask MCP to refresh verified public baseline tables for version windows, limited-time activities, recurring challenges, and map catalogs. Trigger when Gtask queues baseline-maintenance research or the user directly asks Codex to maintain a public baseline."
---

# Sync Gtask Schedules

The Gtask MCP is a local Codex-owned administration interface. It is not shipped as a user-facing integration; ordinary users consume only validated published baseline updates. The restrictions below protect public-baseline integrity; they do not mean the Codex administrator is subordinate to an end-user permission model. Use only the `gtask` MCP tools for application data. Do not run shell commands, edit SQLite directly, inspect raw authenticated responses, or read browser cookies.

## Workflow

1. Register with `register_gtask_schedule_agent` using a stable Agent ID and `webSearch: true`. `protocolVersion` is optional diagnostic metadata; the MCP tool schema and each `job.contract` are authoritative, so a cached plugin version must not block the Codex maintainer at registration.
2. Acquire exactly one explicitly scoped job:
   - For a Gtask background prompt, claim exactly its supplied job ID and echo its fixed model and reasoning effort.
   - For a direct user request to maintain public baselines, call `queue_gtask_baseline_maintenance` once for each explicitly requested game/target, retain every returned job ID, and claim only those IDs. Use the conversation's inherited model/reasoning unless the user explicitly requests another supported setting.
   If an exact claim returns `null`, stop that job successfully. Never claim an unrelated pending job or use an omitted `jobId` as a queue shortcut.
3. Read `job.contract` before researching. It is authoritative for the current `activeTarget`, output locale, timezone, required and forbidden fields, field semantics, and completion criteria. For a continued `all` job, always use the newly returned contract instead of the original contract.
4. Every job is `public_catalog`. Follow `job.contract.workflow`: inspect `matchCandidates`, `currentVersionWindow`, and `sourceObservations`; audit the complete target-section inventory; verify facts; compare every result with the baseline; and submit only differences with `apply_gtask_public_schedule`.
   - `sourceObservations` are sanitized first-party schedule facts already extracted by Gtask. They contain no account identifier, completion, score, exploration progress, Cookie, or token. Use them before web research.
   - If an observation completely and unambiguously supports a time-only correction to its matched item, cite its `observationId` in both the item and `evidence`; no duplicate web lookup is required for that field.
   - If a field is absent, an observation conflicts with another source, an item is new or renamed, gameplay tags are needed, or full-section inventory remains unproven, research only those missing or conflicting facts. Prefer official localized sources, then reliable wikis or guide communities.
   - A maintenance pass is a full-section audit followed by a delta write: create missing rows, update only fields that actually changed, and archive only rows verified obsolete or invalid. Never resubmit unchanged rows merely to record that they were checked.
   - When a fully audited target has no differences, keep `items` empty and report that target through `verifiedUnchangedTargets`. Do not fabricate a write or reuse `verifiedEmptyTargets`, which means the events catalog itself is genuinely empty.
   - `tasks` compares `currentVersionWindow` with verified official timing; submit `versionWindow` only when a field changed, otherwise mark `tasks` unchanged. Keep `items` empty.
   - `events` maintains the limited-time activity baseline and its gameplay tags.
   - `cycles` maintains recurring challenge names, modes, periods, and time windows.
   - `exploration` audits additions, official renames, and two-level parent corrections against the verified map baseline.
5. Confirm official in-game names; do not translate them yourself. A named activity without an exact time window is not a limited-time baseline item. Permanent content stays out of the task list; do not invent a time or create a hanging “waiting for schedule” record.
6. Convert source times into absolute ISO-8601 instants using the source server timezone. Never substitute banner, reward-claim, maintenance-compensation, or unrelated event deadlines for a version or challenge window.
7. Treat `job.contract.activityTagCatalog` as a vocabulary, not a checklist. Submit only accurate gameplay tags supported by evidence. If a genuinely reusable mechanic is missing, register one `custom.*` tag with evidence before referencing it.
8. Reuse the exact `matchItemId` for the same semantic item. Omit it only for a genuine addition. Archive only a synchronized candidate positively verified as wrong, duplicated, renamed, reparented, or obsolete; never archive manual/custom data.
9. Report material phases through `update_gtask_schedule_job_progress`: `searching`, `verifying`, `structuring`, and `writing`. The message is an internal diagnostic, not product copy.
10. Submit `contentLocale` exactly as requested. When an `all` job returns `remainingTargets`, read the returned `job.activeTarget`, filtered candidates, observations, and new `job.contract`, then continue until every target is complete. In particular, the final `exploration` stage must use its returned map contract rather than the earlier tasks/events/cycles contract.
11. Use `fail_gtask_schedule_job` only after useful searches and cross-checks are exhausted. A claimed job must finish or explicitly fail, then exit without claiming a second job.

## Safety

- Baseline maintenance may create, update, or archive only `public_schedule` structure and version-window data.
- Never submit account completion state, challenge records, exploration percentages, credentials, or account identifiers. Sanitized `job.sourceObservations` are explicitly safe to inspect and cite.
- Never read or modify raw `personal_sync`, manual/custom items, recycle-bin records, database backups, or credential files.
- Public activity data must not include banners, shops, reward tiers, internal stages, or permanent content unless the current contract explicitly permits it.
- Maps remain exactly two levels: `region` and `subregion`.
- MCP enforces types, identity, transactions, and protected-data boundaries; Codex remains responsible for researched public semantics.
- MCP administration is local to Codex. Publishing `updates/catalog.json` distributes only validated public baseline data and never grants end users MCP access.
