"""fn-telemetry: Query channel telemetry data for a Launch Package.

GET /packages/{packageId}/telemetry?lookbackMinutes=5

Returns per-channel current values and sparkline arrays for the UI.
"""

from __future__ import annotations

import json
import logging
import os
from collections import defaultdict
from datetime import datetime, timezone, timedelta
from decimal import Decimal
from typing import Any

import boto3
from boto3.dynamodb.conditions import Key
from sfc_cp_utils import ddb as ddb_util, auth as auth_util

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

TELEMETRY_TABLE_NAME = os.environ["TELEMETRY_TABLE_NAME"]
LAUNCH_PKG_TABLE = os.environ["LAUNCH_PKG_TABLE_NAME"]

_dynamodb = boto3.resource("dynamodb")
_telemetry_table = _dynamodb.Table(TELEMETRY_TABLE_NAME)
_pkg_table = _dynamodb.Table(LAUNCH_PKG_TABLE)

_MAX_SPARKLINE_POINTS = 1000
_MAX_TOTAL_POINTS = 10000
_DEFAULT_LOOKBACK_SECONDS = 30
_MAX_LOOKBACK_SECONDS = 120


def _to_json_value(val: Any) -> Any:
    """Convert DynamoDB Decimal to float; pass strings, bools, lists as-is."""
    if isinstance(val, Decimal):
        return float(val)
    if isinstance(val, list):
        return [_to_json_value(v) for v in val]
    if isinstance(val, dict):
        return {k: _to_json_value(v) for k, v in val.items()}
    return val


def handler(event: dict, _context) -> dict:
    path_params = event.get("pathParameters") or {}
    package_id = path_params.get("packageId")
    if not package_id:
        return _error(400, "BAD_REQUEST", "packageId is required")

    caller_sub, caller_groups = auth_util.caller(event)

    pkg = ddb_util.get_package(_pkg_table, package_id)
    if not pkg:
        return _error(404, "NOT_FOUND", f"Package {package_id} not found")
    if not auth_util.can_read(pkg.get("owner"), caller_sub, caller_groups):
        return _error(403, "FORBIDDEN", "You do not have permission to read this package")

    body = json.loads(event.get("body") or "{}")
    try:
        lookback_s = min(int(body.get("lookbackSeconds", _DEFAULT_LOOKBACK_SECONDS)), _MAX_LOOKBACK_SECONDS)
    except (ValueError, TypeError):
        lookback_s = _DEFAULT_LOOKBACK_SECONDS

    start_iso = (datetime.now(timezone.utc) - timedelta(seconds=lookback_s)).isoformat()

    items = _query_telemetry(package_id, start_iso)

    channel_data: dict[str, list] = defaultdict(list)
    for item in items:
        batch_ts = item.get("timestamp", "")
        channels = item.get("channels", {})
        if isinstance(channels, dict):
            for ch_name, ch_value in channels.items():
                if isinstance(ch_value, list):
                    for sample in ch_value:
                        if isinstance(sample, dict):
                            ts = sample.get("timestamp") or batch_ts
                            val = sample.get("value")
                            if val is not None:
                                channel_data[ch_name].append((ts, val))
                elif ch_value is not None:
                    channel_data[ch_name].append((batch_ts, ch_value))

    result_channels = []
    total_points = 0
    for name, points in sorted(channel_data.items()):
        points.sort(key=lambda p: p[0])
        remaining_budget = _MAX_TOTAL_POINTS - total_points
        if remaining_budget <= 0:
            break
        per_channel_cap = min(_MAX_SPARKLINE_POINTS, remaining_budget)
        recent = points[-per_channel_cap:]
        total_points += len(recent)
        values = [_to_json_value(p[1]) for p in recent]
        result_channels.append({
            "name": name,
            "currentValue": values[-1] if values else None,
            "sparkline": values,
            "timestamps": [p[0] for p in recent],
        })

    last_updated = items[-1]["timestamp"] if items else None

    return _ok({
        "packageId": package_id,
        "channels": result_channels,
        "lastUpdated": last_updated,
    })


def _query_telemetry(package_id: str, start_iso: str) -> list[dict]:
    """Query telemetry items from start_iso onwards."""
    items = []
    kwargs = {
        "KeyConditionExpression": Key("packageId").eq(package_id) & Key("timestamp").gte(start_iso),
        "ScanIndexForward": True,
    }
    while True:
        resp = _telemetry_table.query(**kwargs)
        items.extend(resp.get("Items", []))
        last_key = resp.get("LastEvaluatedKey")
        if not last_key:
            break
        kwargs["ExclusiveStartKey"] = last_key
    return items


def _ok(body):
    return {"statusCode": 200, "headers": {"Content-Type": "application/json"}, "body": json.dumps(body, default=str)}


def _error(s, e, m):
    return {"statusCode": s, "headers": {"Content-Type": "application/json"}, "body": json.dumps({"error": e, "message": m})}
