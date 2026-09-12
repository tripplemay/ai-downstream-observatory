"""The fixed SDK child must terminate even without its parent's timeout loop."""

import os
from pathlib import Path
import signal
import subprocess
import sys
import unittest


class ProviderDeadlineTests(unittest.TestCase):
    def test_kernel_alarm_terminates_a_stalled_native_call(self):
        root = str(Path(__file__).resolve().parents[2])
        script = """import io,json,sys,time
sys.path.insert(0,sys.argv[1])
from worker.market.providers import longport as p
from tests.market.test_longport_provider import RANGE
p.CALL_TIMEOUT_SECONDS=0.15
p._official_call=lambda request,credentials: time.sleep(10)
request=p._request(**RANGE)
body=json.dumps({'request':request,'credentials':{'app_key':'synthetic','app_secret':'synthetic','access_token':'synthetic'}}).encode()
sys.stdin=io.TextIOWrapper(io.BytesIO(body),encoding='utf-8')
raise SystemExit(p._child_main())
"""
        result = subprocess.run([sys.executable, "-I", "-c", script, root], capture_output=True,
                                timeout=5, env={"PATH": os.defpath, "PYTHONDONTWRITEBYTECODE": "1"})
        self.assertEqual(result.returncode, -signal.SIGALRM, result.stderr.decode())
        self.assertEqual(result.stdout, b"")
        self.assertEqual(result.stderr, b"")
