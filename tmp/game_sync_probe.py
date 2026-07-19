from __future__ import annotations

import asyncio
import dataclasses
import datetime as dt
import enum
import json
import os
from pathlib import Path
from typing import Any, Awaitable, Callable

import genshin


ROOT = Path(__file__).resolve().parent
STATE_PATH = ROOT / "game-sync-state.json"
RESULT_PATH = ROOT / "game-sync-result.json"

BLOCKED_KEY_PARTS = (
    "cookie",
    "token",
    "auth",
    "password",
    "phone",
    "email",
    "device",
    "secret",
)
SKIP_KEY_PARTS = ("icon", "image", "avatar", "url")


def write_json(path: Path, value: Any) -> None:
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temp, path)


def set_state(status: str, message: str) -> None:
    write_json(
        STATE_PATH,
        {
            "status": status,
            "message": message,
            "updated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        },
    )


def safe(value: Any, *, depth: int = 0) -> Any:
    if depth > 8:
        return "<省略>"
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, (dt.datetime, dt.date, dt.time, dt.timedelta)):
        return str(value)
    if isinstance(value, enum.Enum):
        return safe(value.value, depth=depth + 1)
    if hasattr(value, "model_dump"):
        return safe(value.model_dump(mode="json"), depth=depth + 1)
    if dataclasses.is_dataclass(value):
        return safe(dataclasses.asdict(value), depth=depth + 1)
    if isinstance(value, dict):
        cleaned: dict[str, Any] = {}
        for key, item in value.items():
            name = str(key)
            lowered = name.lower()
            if any(part in lowered for part in BLOCKED_KEY_PARTS):
                continue
            if any(part in lowered for part in SKIP_KEY_PARTS):
                continue
            cleaned[name] = safe(item, depth=depth + 1)
        return cleaned
    if isinstance(value, (list, tuple, set)):
        items = list(value)
        cleaned = [safe(item, depth=depth + 1) for item in items[:50]]
        if len(items) > 50:
            cleaned.append(f"<另有 {len(items) - 50} 项省略>")
        return cleaned
    return str(value)


async def collect(
    name: str,
    operation: Callable[[], Awaitable[Any]],
    bucket: dict[str, Any],
) -> None:
    try:
        bucket[name] = {
            "ok": True,
            "data": safe(await asyncio.wait_for(operation(), timeout=35)),
        }
    except Exception as exc:  # The probe must continue to test other endpoints.
        bucket[name] = {
            "ok": False,
            "error_type": type(exc).__name__,
            "error": str(exc)[:500],
        }


async def main() -> None:
    for path in (STATE_PATH, RESULT_PATH):
        if path.exists():
            path.unlink()

    set_state("waiting_for_qr", "请使用米游社扫描二维码并在手机上确认登录")
    client = genshin.Client(region=genshin.Region.CHINESE, lang="zh-cn")

    # login_with_qrcode opens the QR in the user's default image viewer. The
    # returned cookies remain only inside this process and are never serialized.
    await client.login_with_qrcode()
    set_state("querying", "登录成功，正在只读查询已绑定角色与战绩")

    accounts = list(await asyncio.wait_for(client.get_game_accounts(), timeout=35))
    selected = [
        account
        for account in accounts
        if account.game in (genshin.Game.GENSHIN, genshin.Game.STARRAIL, genshin.Game.ZZZ)
    ]

    result: dict[str, Any] = {
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "accounts": [],
    }

    for account in selected:
        entry: dict[str, Any] = {
            "game": account.game.value,
            "uid": account.uid,
            "nickname": account.nickname,
            "level": account.level,
            "server": account.server,
            "server_name": account.server_name,
            "queries": {},
        }
        result["accounts"].append(entry)
        queries: dict[str, Any] = entry["queries"]
        uid = account.uid

        if account.game is genshin.Game.GENSHIN:
            await collect("profile_and_exploration", lambda uid=uid: client.get_genshin_user(uid), queries)
            await collect("spiral_abyss_current", lambda uid=uid: client.get_genshin_spiral_abyss(uid), queries)
            await collect("imaginarium_theater_current", lambda uid=uid: client.get_imaginarium_theater(uid), queries)
            await collect("real_time_notes", lambda uid=uid: client.get_genshin_notes(uid), queries)
        elif account.game is genshin.Game.STARRAIL:
            await collect("profile", lambda uid=uid: client.get_starrail_user(uid), queries)
            await collect("memory_of_chaos", lambda uid=uid: client.get_starrail_challenge(uid), queries)
            await collect("pure_fiction", lambda uid=uid: client.get_starrail_pure_fiction(uid), queries)
            await collect("apocalyptic_shadow", lambda uid=uid: client.get_starrail_apc_shadow(uid), queries)
            await collect("real_time_notes", lambda uid=uid: client.get_starrail_notes(uid), queries)
        elif account.game is genshin.Game.ZZZ:
            await collect("profile", lambda uid=uid: client.get_zzz_user(uid), queries)
            await collect("shiyu_defense", lambda uid=uid: client.get_shiyu_defense(uid), queries)
            await collect("deadly_assault", lambda uid=uid: client.get_deadly_assault(uid), queries)
            await collect("annihilation_simulacrum", lambda uid=uid: client.get_annihilation_simulacrum(uid), queries)
            await collect("threshold_simulation", lambda uid=uid: client.get_threshold_simulation_brief(uid), queries)
            await collect("real_time_notes", lambda uid=uid: client.get_zzz_notes(uid), queries)

    write_json(RESULT_PATH, result)
    set_state("complete", f"查询完成，共发现 {len(selected)} 个目标游戏角色")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as exc:
        set_state("error", f"{type(exc).__name__}: {str(exc)[:500]}")
