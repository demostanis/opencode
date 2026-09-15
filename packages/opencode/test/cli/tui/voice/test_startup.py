import asyncio
import json
import logging
import os
from pathlib import Path
import sys
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[4] / "src/cli/cmd/tui/voice"))
import bridge
from daemon import Capture


@unittest.skipUnless(
    os.environ.get("OPENCODE_VOICE_LIVE") == "1",
    "Explicit OAuth live-test opt-in required",
)
class Startup(unittest.IsolatedAsyncioTestCase):
    async def test_silent_connection(self):
        logging.disable(logging.CRITICAL)
        auth = json.loads(
            (Path.home() / ".local/share/opencode/auth.json").read_text()
        )["openai"]
        self.assertGreater(
            auth["expires"], time.time() * 1000, "Refresh OAuth through OpenCode first"
        )
        start = {
            "headers": {
                "Authorization": "Bearer " + auth["access"],
                "ChatGPT-Account-ID": auth["accountId"],
            }
        }
        del auth
        loaded = await bridge.models(
            Path(
                os.environ.get(
                    "OPENCODE_VOICE_MODELS", "/usr/share/opencode-voice/models"
                )
            ),
            download=False,
        )
        for attempt in range(3):
            with self.subTest(attempt=attempt + 1):
                ready = asyncio.Event()
                errors = []

                def output(event):
                    if event["type"] == "error":
                        errors.append(event["message"])
                    if event == {"type": "state", "state": "waiting"}:
                        ready.set()

                # Shared silence source, suspended gate: no microphone or playback.
                task = asyncio.create_task(
                    bridge.run(
                        start,
                        asyncio.Queue(),
                        loaded=loaded,
                        output=output,
                        capture=Capture(),
                        control=lambda fn: fn({"type": "suspend"}),
                    )
                )
                waiter = asyncio.create_task(ready.wait())
                try:
                    await asyncio.wait(
                        [task, waiter], timeout=70, return_when=asyncio.FIRST_COMPLETED
                    )
                    if task.done():
                        try:
                            task.result()
                        except Exception as err:
                            errors.append(bridge.failure("startup", err)["message"])
                    self.assertFalse(errors, "; ".join(errors))
                    self.assertTrue(ready.is_set(), "Voice startup exceeded 70 seconds")
                    print(
                        f"Voice startup attempt {attempt + 1}: connected (silence only)",
                        flush=True,
                    )
                finally:
                    task.cancel()
                    waiter.cancel()
                    await asyncio.gather(task, waiter, return_exceptions=True)
