---
name: sync-gacha-schedules
description: "Use the local Gacha Task Manager MCP to read checklists and safely refresh verified public schedules or map-region catalogs for Genshin Impact, Honkai: Star Rail, Zenless Zone Zero, or Wuthering Waves. Trigger when the user asks to refresh, research, verify, or synchronize events, recurring modes, exploration regions, or public data in 幻游清单."
---

# Sync Gacha Schedules

Use the `gacha_task_manager` MCP tools. Do not run shell commands or edit the SQLite database directly.

## Public schedule workflow

1. Call `register_gacha_schedule_agent` with a stable Agent ID, a descriptive name, and `webSearch: true`.
2. Call `claim_gacha_schedule_job` once. If it returns `null`, report that no refresh task is pending and stop.
3. Read the claimed job's `target`. Search only that target: `events` for limited-time events, `cycles` for weeklies/endgame calibration, `exploration` for the currently released map-region catalog, or `all` for the full supported set. Never broaden a section job into other sections.
4. Search official Simplified Chinese sources for the current version and active/upcoming windows. Reuse fresh trustworthy URLs from the existing checklist when they still cover the current period. Run independent source queries in parallel when supported.
5. Prefer the Chinese official game site, publisher/community account, or verified Chinese Bilibili account. Use other-language official pages only for date cross-checking. If an item is first found in another language, find a Chinese source for its official Chinese name; never translate the name yourself.
6. Keep the fast path bounded: normally no more than 6 targeted searches and a 90-second soft deadline. Escalate to broader community search only when official sources are missing or materially conflict.
7. Submit only exact, supported records through `apply_gacha_public_schedule`. If evidence is insufficient or conflicting at the deadline, call `fail_gacha_schedule_job` with a precise reason and retain the previous checklist.
8. Report the job ID, target, elapsed time, sources, and merge counts or failure reason. Never leave a claimed job unfinished.

## Submission rules

- Allow only `limited_event`, `weekly`, `endgame`, and `exploration`. Permanent events remain user-maintained.
- For `exploration`, submit the released region catalog only. Use a stable `modeKey` and `parentTitle` when known. Do not submit progress or completion; new regions start at 0% and personal data fills progress later.
- Public map refreshes are append/update only. Missing regions must never be deleted or archived.
- For recurring `endgame` modes, include a verified `recurrenceRule`: `interval-days:N` or `monthly-days:D1,D2@HH:mm[Asia/Shanghai]`. Keep the readable cadence in `resetRule`; omit the machine rule if it cannot be verified.
- A full initial Genshin sync must keep 深境螺旋 (`spiral-abyss`), 幻想真境剧诗 (`imaginarium-theater`), and 幽境危战 (`stygian-onslaught`) as separate modes.
- Use stable `remoteKey` values across refreshes.
- Every `title` must be an official Simplified Chinese name confirmed by a Chinese source. Pure English titles and AI-authored translations are forbidden.
- Set `titleSourceUrl` to the matching Chinese page and include it in `evidence` with `language: zh-CN`.
- Use ISO-8601 timestamps with an explicit offset or `Z`.
- Treat `userTimeZone` as the display timezone, not the source timezone. Identify the source server timezone and DST rules, then submit an absolute instant. If the source timezone cannot be established, fail instead of guessing.
- Include a direct HTTP(S) `sourceUrl`, confidence, and 1–20 evidence entries for every item.
- Do not submit completion status, exploration progress, credentials, deletes, or unknown fields.
- Do not use generic checklist write tools for public schedules.
- Never read browser cookies or request game-login credentials for public schedule work.

## Safety

MCP writes may require user approval in Codex. Preserve that approval boundary. Failed searches must retain existing checklist data.
