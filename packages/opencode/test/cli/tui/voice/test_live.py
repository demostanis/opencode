import asyncio
import base64
from collections import deque
import contextlib
import fractions
import json
import logging
import os
from pathlib import Path
import subprocess
import sys
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[4] / "src/cli/cmd/tui/voice"))
from bridge import ENDPOINT, INSTRUCTIONS, Protocol, Speaker, frames, headers
from wake import Gate, MODELS


def speech(text):
    voice = subprocess.run(
        ["espeak-ng", "--stdout", "-v", "fr", "-s", "140", text],
        check=True,
        capture_output=True,
    ).stdout
    data = subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-i",
            "pipe:0",
            "-f",
            "s16le",
            "-ar",
            "48000",
            "-ac",
            "1",
            "pipe:1",
        ],
        input=voice,
        check=True,
        capture_output=True,
    ).stdout
    data += bytes(144000)
    return data + bytes(-len(data) % 1920)


@unittest.skipUnless(
    os.environ.get("OPENCODE_VOICE_LIVE") == "1",
    "Explicit OAuth live-test opt-in required; no microphone capture",
)
class Live(unittest.IsolatedAsyncioTestCase):
    async def test_synthetic_delegation_result_stop(self):
        import aiohttp
        import av
        from aiortc import AudioStreamTrack, RTCPeerConnection, RTCSessionDescription
        from vosk import Model, SetLogLevel

        logging.disable(logging.CRITICAL)
        SetLogLevel(-1)
        # Test-only credential access, never imported by the runtime helper.
        auth = json.loads(
            (Path.home() / ".local/share/opencode/auth.json").read_text()
        )["openai"]
        self.assertGreater(
            auth["expires"],
            time.time() * 1000,
            "Refresh OAuth through OpenCode before this test",
        )
        credentials = headers(
            {
                "Authorization": "Bearer " + auth["access"],
                "ChatGPT-Account-ID": auth["accountId"],
            }
        )
        del auth
        models = [
            (
                word,
                Model(
                    str(Path(os.environ.get("OPENCODE_VOICE_MODELS", "/tmp")) / name)
                ),
                words,
            )
            for word, name, words in MODELS
        ]
        wake = speech("esclave")
        request = speech(
            "Demande à l'agent de code de répondre avec test vocal réussi pour un test sans modifier de fichier"
        )
        stop = speech("Arrête de m'écouter maintenant")
        speaker = Speaker()
        gate = Gate(models, mute=speaker.stop)
        output = []
        protocol = Protocol(gate, output.append)
        gate.change = protocol.changed
        events = asyncio.Queue()
        peer = RTCPeerConnection()
        tasks = []
        stats = {
            "audio": 0,
            "delegates": 0,
            "result": False,
            "stop": False,
            "duplicates": 0,
        }
        done = asyncio.Event()

        class Replay(AudioStreamTrack):
            def __init__(self):
                super().__init__()
                self.samples = 0
                self.start = None
                self.chunks = deque()

            def append(self, data):
                self.chunks.extend(
                    data[offset : offset + 1920] for offset in range(0, len(data), 1920)
                )

            async def recv(self):
                if self.start is None:
                    self.start = time.monotonic()
                await asyncio.sleep(
                    max(0, self.start + self.samples / 48000 - time.monotonic())
                )
                data = self.chunks.popleft() if self.chunks else bytes(1920)
                frame = av.AudioFrame(format="s16", layout="mono", samples=960)
                frame.planes[0].update(gate.process(data))
                frame.sample_rate = 48000
                frame.pts = self.samples
                frame.time_base = fractions.Fraction(1, 48000)
                self.samples += 960
                return frame

        track = Replay()
        peer.addTrack(track)

        @peer.createDataChannel("oai-events").on("message")
        def event(data):
            if isinstance(data, str):
                item = json.loads(data)
                if item.get("type") != "session.output_audio.delta":
                    events.put_nowait(item)

        try:
            await peer.setLocalDescription(await peer.createOffer())
            async with aiohttp.ClientSession(
                headers=credentials, timeout=aiohttp.ClientTimeout(total=45)
            ) as client:
                async with client.post(
                    ENDPOINT,
                    json={
                        "sdp": peer.localDescription.sdp,
                        "session": {
                            "model": "gpt-live-1-codex",
                            "instructions": INSTRUCTIONS,
                            "audio": {"output": {"voice": "cove"}},
                            "delegation": {"type": "client", "ack_filler": False},
                        },
                    },
                ) as response:
                    self.assertIn(
                        response.status,
                        (200, 201),
                        "OAuth call rejected; response intentionally withheld",
                    )
                    print("LIVE call HTTP", response.status, flush=True)
                    answer = await response.text()
                    call = (
                        response.headers["Location"]
                        .split("?")[0]
                        .rstrip("/")
                        .split("/")[-1]
                    )
                await peer.setRemoteDescription(
                    RTCSessionDescription(sdp=answer, type="answer")
                )
                async with client.ws_connect(
                    "wss://api.openai.com/v1/live/" + call,
                    heartbeat=20,
                    timeout=aiohttp.ClientWSTimeout(ws_close=2),
                ) as socket:

                    async def send(event):
                        for frame in frames(event):
                            await socket.send_json(frame)

                    async def incoming():
                        async for message in socket:
                            if message.type == aiohttp.WSMsgType.TEXT:
                                await events.put(json.loads(message.data))
                        raise AssertionError("Live socket closed before verification")

                    async def consume():
                        while True:
                            event = await events.get()
                            kind = event.get("type")
                            self.assertNotIn(
                                kind,
                                ("error", "session.closed", "session.expired"),
                                "Remote error; payload intentionally withheld",
                            )
                            if kind == "session.output_audio.delta":
                                if gate.audible:
                                    data = base64.b64decode(
                                        event["delta"], validate=True
                                    )
                                    for offset in range(0, len(data), 9600):
                                        chunk = data[offset : offset + 9600]
                                        if gate.audio(chunk):
                                            if stats["delegates"]:
                                                stats["audio"] += len(chunk)
                                            await speaker.play(chunk)
                                continue
                            before = len(output)
                            await send(protocol.event(event))
                            if (
                                kind == "turn.done"
                                and event.get("turn", {}).get("id")
                                and before == len(output)
                            ):
                                stats["duplicates"] += 1
                            for item in output[before:]:
                                if (
                                    item["type"] == "transcript"
                                    and item["role"] == "user"
                                ):
                                    print(
                                        "LIVE synthetic user transcript:",
                                        item["text"][:300],
                                        flush=True,
                                    )
                                if item["type"] == "delegate":
                                    stats["delegates"] += 1
                                    self.assertEqual(
                                        stats["delegates"],
                                        1,
                                        "Unexpected additional work delegation",
                                    )
                                    self.assertIn("test vocal", item["text"].lower())
                                    print(
                                        "LIVE actual user request delegated once",
                                        flush=True,
                                    )
                                    await send(
                                        protocol.command(
                                            {
                                                "type": "result",
                                                "id": item["id"],
                                                "final": True,
                                                "text": "TEST UNIQUEMENT. "
                                                + "Résultat simulé, aucun travail réel ni changement de fichier. "
                                                * 9
                                                + "test vocal réussi.",
                                            }
                                        )
                                    )
                                if (
                                    item["type"] == "transcript"
                                    and item["role"] == "assistant"
                                    and stats["delegates"]
                                    and "test vocal" in item["text"].lower()
                                ):
                                    stats["result"] = True
                                    print(
                                        "LIVE French result transcript:",
                                        item["text"][:300],
                                        flush=True,
                                    )
                            if gate.blocked:
                                stats["stop"] = True
                                done.set()

                    async def scenario():
                        gate.ready = True
                        await send(
                            protocol.command(
                                {
                                    "type": "context",
                                    "text": "Test synthétique sans microphone, aucune action réelle. "
                                    * 20,
                                }
                            )
                        )
                        await asyncio.sleep(3)
                        self.assertFalse(gate.active)
                        self.assertIsNone(
                            speaker.player, "Waiting context must not play audio"
                        )
                        self.assertFalse(
                            any(item["type"] == "delegate" for item in output)
                        )
                        track.append(wake + request)
                        while not stats["result"] or gate.speaking:
                            await asyncio.sleep(0.05)
                            gate.tick()
                        self.assertGreater(
                            stats["audio"], 0, "Result must include real PCM audio"
                        )
                        while gate.active:
                            await asyncio.sleep(0.05)
                            gate.tick()
                        self.assertFalse(gate.speaking)
                        self.assertEqual(gate.process(bytes(1920)), bytes(1920))
                        print(
                            "LIVE recurring output silence returned automatic wake-only waiting",
                            flush=True,
                        )
                        await asyncio.sleep(2.1)
                        track.append(wake + stop)
                        print("LIVE synthetic stop queued", flush=True)
                        await done.wait()
                        self.assertFalse(gate.active)
                        self.assertFalse(gate.audible)
                        self.assertEqual(gate.process(bytes(1920)), bytes(1920))
                        await asyncio.sleep(2)
                        print(
                            "LIVE semantic stop returned waiting; PCM bytes",
                            stats["audio"],
                            "duplicate turns",
                            stats["duplicates"],
                            flush=True,
                        )

                    tasks = [
                        asyncio.create_task(fn())
                        for fn in (incoming, consume, scenario)
                    ]
                    try:
                        completed, _ = await asyncio.wait(
                            tasks, timeout=90, return_when=asyncio.FIRST_COMPLETED
                        )
                        if not completed:
                            print(
                                "LIVE timeout status",
                                {
                                    key: stats[key]
                                    for key in ("delegates", "result", "stop", "audio")
                                },
                                flush=True,
                            )
                            for item in output:
                                if (
                                    item["type"] == "transcript"
                                    and item["role"] == "assistant"
                                ):
                                    print(
                                        "LIVE diagnostic assistant transcript:",
                                        item["text"][:300],
                                        flush=True,
                                    )
                        self.assertTrue(completed, "Live synthetic scenario timed out")
                        for task in completed:
                            task.result()
                        self.assertTrue(stats["result"] and stats["stop"])
                    finally:
                        for task in tasks:
                            task.cancel()
                        await asyncio.gather(*tasks, return_exceptions=True)
                        with contextlib.suppress(Exception):
                            await asyncio.wait_for(
                                socket.send_json({"type": "session.close"}), 1
                            )
        finally:
            track.stop()
            await asyncio.gather(peer.close(), speaker.close(), return_exceptions=True)


if __name__ == "__main__":
    unittest.main()
