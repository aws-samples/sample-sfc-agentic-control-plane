"""fn-telemetry-ingestion: IoT Rule Lambda action for channel telemetry.

Receives batched SFC channel telemetry from IoT Core and writes each batch
as a single item to the TelemetryTable (PK=packageId, SK=timestamp).

IoT SQL: SELECT *, topic(2) AS packageId FROM 'sfc/+/telemetry'

Payload shape (published by runner.py telemetry thread):
{
    "packageId": "uuid",
    "timestamp": "2026-05-28T12:00:05.000Z",
    "channels": {
        "SimSource/counter": [{"value": 7.2, "timestamp": "..."}, ...],
        "SimSource/sinus": [{"value": 3.14, "timestamp": "..."}, ...]
    }
}
"""

from __future__ import annotations

import json
import logging
import os
import time
from decimal import Decimal

import boto3

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

TELEMETRY_TABLE_NAME = os.environ["TELEMETRY_TABLE_NAME"]

_dynamodb = boto3.resource("dynamodb")
_telemetry_table = _dynamodb.Table(TELEMETRY_TABLE_NAME)

_TTL_SECONDS = 86400  # 24 hours


def _convert_floats(obj):
    """Recursively convert float values to Decimal for DynamoDB."""
    if isinstance(obj, float):
        return Decimal(str(obj))
    if isinstance(obj, dict):
        return {k: _convert_floats(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_convert_floats(i) for i in obj]
    return obj


def handler(event: dict, _context) -> None:
    """IoT Rule Lambda action entry point."""
    logger.info("Telemetry event: %s", json.dumps(event, default=str)[:2000])

    package_id: str | None = event.get("packageId")
    if not package_id:
        logger.error("packageId missing from telemetry payload — dropping")
        return

    timestamp: str | None = event.get("timestamp")
    if not timestamp:
        logger.error("timestamp missing from telemetry payload — dropping")
        return

    channels = event.get("channels")
    if not channels or not isinstance(channels, dict):
        logger.warning("No channels in telemetry payload for %s — dropping", package_id)
        return

    item = {
        "packageId": package_id,
        "timestamp": timestamp,
        "channels": _convert_floats(channels),
        "ttl": int(time.time()) + _TTL_SECONDS,
    }

    try:
        _telemetry_table.put_item(Item=item)
        logger.info(
            "Telemetry persisted: packageId=%s timestamp=%s channels=%d",
            package_id, timestamp, len(channels),
        )
    except Exception:
        logger.exception("Failed to write telemetry for packageId=%s", package_id)
        raise
