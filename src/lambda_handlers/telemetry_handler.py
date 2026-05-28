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
_DEFAULT_LOOKBACK_MINUTES = 5
_MAX_LOOKBACK_MINUTES = 60


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

    qs = event.get("queryStringParameters") or {}
    try:
        lookback = min(int(qs.get("lookbackMinutes", _DEFAULT_LOOKBACK_MINUTES)), _MAX_LOOKBACK_MINUTES)
    except (ValueError, TypeError):
        lookback = _DEFAULT_LOOKBACK_MINUTES

    start_iso = (datetime.now(timezone.utc) - timedelta(minutes=lookback)).isoformat()

    items = _query_telemetry(package_id, start_iso)

    channel_data: dict[str, list[tuple[str, float]]] = defaultdict(list)
    for item in items:
        batch_ts = item.get("timestamp", "")
        channels = item.get("channels", {})
        if isinstance(channels, dict):
            for ch_name, ch_value in channels.items():
                if isinstance(ch_value, list):
                    for sample in ch_value:
                        if isinstance(sample, dict):
                            try:
                                ts = sample.get("timestamp") or batch_ts
                                channel_data[ch_name].append((ts, float(sample["value"])))
                            except (ValueError, TypeError, KeyError):
                                pass
                else:
                    try:
                        channel_data[ch_name].append((batch_ts, float(ch_value)))
                    except (ValueError, TypeError):
                        pass

    result_channels = []
    for name, points in sorted(channel_data.items()):
        points.sort(key=lambda p: p[0])
        recent = points[-_MAX_SPARKLINE_POINTS:]
        result_channels.append({
            "name": name,
            "currentValue": recent[-1][1] if recent else None,
            "sparkline": [p[1] for p in recent],
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
