"""Isolated test transport; the production child protocol and SDK wrapper stay real."""

import sys
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from worker.market.providers import longport as provider
from tests.market.test_longport_provider import candle, fake_sdk


sdk, client = fake_sdk([])


def history(symbol, period, adjust, start, end, sessions):
    return [candle((start + timedelta(days=offset)).isoformat(),
                   timestamp=datetime.combine(start + timedelta(days=offset), datetime.min.time()).replace(hour=14))
            for offset in range((end - start).days + 1)]


client.history_candlesticks_by_date = history
provider._load_sdk = lambda: sdk
raise SystemExit(provider._child_main())
