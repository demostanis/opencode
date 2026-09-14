import asyncio
import json
import os
from pathlib import Path
import socket
import stat
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[4] / "src/cli/cmd/tui/voice"
sys.path.insert(0, str(ROOT))
import bridge
from daemon import Audio, Capture, Endpoint, Service, peer
from wake import Gate

HELLO = {"type": "hello", "version": 1, "mode": "development"}


class Quiet:
    def __init__(self):
        self.client = None
        self.starts = 0

    def start(self, client):
        assert self.client is None
        self.client = client
        self.starts += 1

    async def close(self):
        self.client = None


class Vad:
    def is_speech(self, data, rate):
        return False


class Security(unittest.TestCase):
    def test_cross_process_election(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "voice.sock"
            with Endpoint(path):
                inode = path.stat().st_ino
                result = subprocess.run(
                    [
                        sys.executable,
                        "-B",
                        str(ROOT / "daemon.py"),
                        "--socket",
                        str(path),
                        "--cache",
                        temp,
                        "--packaged",
                    ],
                    capture_output=True,
                    timeout=5,
                )
                self.assertEqual(result.returncode, 0)
                self.assertEqual(result.stdout, b"")
                self.assertEqual(path.stat().st_ino, inode)

    def test_live_socket_without_lock_is_not_removed(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "voice.sock"
            with socket.socket(socket.AF_UNIX) as sock:
                sock.bind(str(path))
                sock.listen(1)
                path.chmod(0o600)
                inode = path.stat().st_ino
                with self.assertRaises(FileExistsError):
                    with Endpoint(path):
                        pass
                self.assertEqual(path.stat().st_ino, inode)

    def test_symlink_directory_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "actual").mkdir(mode=0o700)
            (root / "alias").symlink_to(root / "actual", target_is_directory=True)
            with self.assertRaises(OSError):
                with Endpoint(root / "alias" / "voice.sock"):
                    pass
            self.assertEqual(list((root / "actual").iterdir()), [])

    def test_election_and_stale_socket(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "voice.sock"
            with Endpoint(path):
                inode = path.stat().st_ino
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
                with self.assertRaises(BlockingIOError):
                    with Endpoint(path):
                        self.fail("Second daemon elected")
                self.assertEqual(path.stat().st_ino, inode)
            self.assertFalse(path.exists())
            self.assertTrue(Path(str(path) + ".lock").exists())
            with socket.socket(socket.AF_UNIX) as sock:
                sock.bind(str(path))
            path.chmod(0o600)
            with Endpoint(path):
                self.assertTrue(path.exists())
            self.assertFalse(path.exists())

    def test_untrusted_entries_are_not_removed(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "voice.sock"
            target = Path(temp) / "target"
            target.write_text("keep")
            for kind in ("file", "symlink", "socket"):
                if kind == "file":
                    path.write_text("keep")
                if kind == "symlink":
                    path.symlink_to(target)
                if kind == "socket":
                    with socket.socket(socket.AF_UNIX) as sock:
                        sock.bind(str(path))
                    path.chmod(0o666)
                with self.assertRaises(ValueError):
                    with Endpoint(path):
                        self.fail("Unsafe endpoint accepted")
                self.assertTrue(path.lstat())
                self.assertEqual(target.read_text(), "keep")
                path.unlink()

    def test_private_directory_and_lock(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "voice.sock"
            Path(temp).chmod(0o755)
            with self.assertRaises(ValueError):
                with Endpoint(path):
                    pass
            Path(temp).chmod(0o700)
            lock = Path(str(path) + ".lock")
            lock.symlink_to(Path(temp) / "missing")
            with self.assertRaises(OSError):
                with Endpoint(path):
                    pass
            self.assertTrue(lock.is_symlink())

    def test_cleanup_preserves_replacement(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "voice.sock"
            with Endpoint(path):
                path.unlink()
                path.write_text("replacement")
            self.assertEqual(path.read_text(), "replacement")

    def test_peer(self):
        sock, other = socket.socketpair()
        with sock, other:
            self.assertTrue(peer(sock))
            with patch("daemon.os.getuid", return_value=os.getuid() + 1):
                self.assertFalse(peer(sock))


class Models(unittest.IsolatedAsyncioTestCase):
    async def test_installed_models_skip_cache_validation_and_network(self):
        paths = []
        module = types.SimpleNamespace(
            Model=lambda path: paths.append(path) or object(),
            SetLogLevel=lambda level: None,
        )
        with tempfile.TemporaryDirectory() as temp:
            cache = Path(temp) / "installed"
            with (
                patch.dict(sys.modules, {"vosk": module, "aiohttp": None}),
                patch("bridge.valid", side_effect=AssertionError("cache validation")),
            ):
                loaded = await bridge.models(cache, download=False)
            self.assertEqual(len(loaded), 2)
            self.assertEqual(paths, [str(cache / name) for _, name, _ in bridge.MODELS])
            self.assertFalse(cache.exists())


class Sessions(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "voice.sock"
        self.endpoint = Endpoint(self.path)
        self.sock = self.endpoint.__enter__()
        self.log = []
        self.loads = []
        self.models = object()
        self.writers = []
        self.outputs = {}
        self.protocols = {}
        self.sent = []

        async def load(cache, download):
            self.loads.append((cache, download))
            await asyncio.sleep(0.01)
            return self.models

        async def run(start, queue, loaded, output, capture, control):
            self.assertIs(loaded, self.models)
            name = start["headers"]["authorization"]
            self.log.append((name, "start"))
            self.outputs[name] = output
            gate = Gate(vad=Vad(), mute=lambda: self.log.append((name, "muted")))
            gate.suspend()
            protocol = bridge.Protocol(gate, output)
            self.protocols[name] = protocol
            gate.change = protocol.changed
            control(protocol.control)
            gate.ready = True
            protocol.changed()
            try:
                while True:
                    command = await queue.get()
                    self.log.append((name, command))
                    self.sent.append((name, protocol.command(command)))
                    if command["type"] == "context":
                        output(
                            {
                                "type": "transcript",
                                "role": "user",
                                "text": command["text"],
                            }
                        )
            finally:
                await asyncio.sleep(0.01)
                self.log.append((name, "stop"))

        self.service = Service(self.temp.name, run=run, load=load, audio=Quiet())
        self.server = await asyncio.start_unix_server(
            self.service.connect, sock=self.sock, limit=262144
        )

    async def asyncTearDown(self):
        self.server.close()
        for writer in self.writers:
            writer.close()
            await writer.wait_closed()
        await asyncio.wait_for(
            asyncio.gather(*self.service.tasks, return_exceptions=True), 3
        )
        await self.service.release()
        await self.server.wait_closed()
        if self.service.timer:
            self.service.timer.cancel()
        self.endpoint.close()
        self.temp.cleanup()

    async def send(self, writer, command):
        writer.write((json.dumps(command) + "\n").encode())
        await writer.drain()

    async def event(self, reader, state=None):
        event = json.loads(await asyncio.wait_for(reader.readline(), 2))
        if state:
            while (
                event == {"type": "state", "state": "starting"} and state == "waiting"
            ):
                event = json.loads(await asyncio.wait_for(reader.readline(), 2))
            self.assertEqual(event, {"type": "state", "state": state})
        return event

    async def client(self, name):
        reader, writer = await asyncio.open_unix_connection(str(self.path))
        self.writers.append(writer)
        await self.send(writer, HELLO)
        self.assertEqual(await self.event(reader), HELLO)
        await self.send(
            writer,
            {"type": "start", "headers": {"authorization": name}, "cache": "/ignored"},
        )
        self.assertEqual(await self.event(reader), {"type": "started"})
        await self.event(reader, "starting")
        await self.event(reader, "waiting")
        return reader, writer

    async def test_focus_handoff_isolation_and_model_reuse(self):
        a, aw = await self.client("a")
        b, bw = await self.client("b")
        self.assertEqual(self.loads, [])
        self.assertEqual(self.log, [])
        await self.send(aw, {"type": "context", "text": "private a"})
        await self.send(bw, {"type": "context", "text": "private b"})
        await self.send(aw, {"type": "resume"})
        await self.event(a, "starting")
        await self.event(a, "waiting")
        self.assertEqual((await self.event(a))["text"], "private a")
        session = self.protocols["a"]
        await self.send(bw, {"type": "resume"})
        await self.event(a, "waiting")
        await self.event(b, "starting")
        await self.event(b, "waiting")
        self.assertEqual((await self.event(b))["text"], "private b")
        self.assertNotIn(("a", "stop"), self.log)
        self.assertTrue(session.gate.suspended)
        self.assertFalse(self.protocols["b"].gate.suspended)
        await self.send(aw, {"type": "suspend"})
        await self.event(a, "waiting")
        self.assertEqual(self.service.owner.start["headers"]["authorization"], "b")
        await self.send(bw, {"type": "suspend"})
        await self.event(b, "waiting")
        await self.event(b, "waiting")
        self.assertIsNone(self.service.owner)
        await self.send(aw, {"type": "resume"})
        await self.event(a, "waiting")
        self.assertIs(self.protocols["a"], session)
        self.assertEqual(len(self.loads), 1)
        await self.send(aw, {"type": "context", "text": "new session"})
        self.assertEqual((await self.event(a))["text"], "new session")
        self.assertEqual(
            [
                command["text"]
                for name, command in self.log
                if name == "b"
                and isinstance(command, dict)
                and command["type"] == "context"
            ],
            ["private b"],
        )

    async def test_disconnect_releases_owner(self):
        reader, writer = await self.client("a")
        await self.send(writer, {"type": "resume"})
        await self.event(reader, "starting")
        await self.event(reader, "waiting")
        writer.close()
        await writer.wait_closed()
        await asyncio.sleep(0.05)
        self.assertIsNone(self.service.owner)
        self.assertIn(("a", "stop"), self.log)

    async def test_invalid_client_does_not_stop_owner(self):
        a, aw = await self.client("a")
        b, bw = await self.client("b")
        await self.send(aw, {"type": "resume"})
        await self.event(a, "starting")
        await self.event(a, "waiting")
        await self.send(bw, {"type": "result", "id": "x", "text": "secret", "final": 1})
        self.assertEqual((await self.event(b))["type"], "error")
        self.assertEqual(await b.readline(), b"")
        self.assertEqual(self.service.owner.start["headers"]["authorization"], "a")

    async def test_rejected_peer_never_starts(self):
        with patch("daemon.peer", return_value=False):
            reader, writer = await asyncio.open_unix_connection(str(self.path))
            self.writers.append(writer)
            self.assertEqual(await asyncio.wait_for(reader.readline(), 1), b"")
        self.assertEqual(self.loads, [])

    async def test_packaged_and_idle(self):
        service = Service("/ignored", packaged=True, idle=0.01)
        self.assertEqual(service.cache, Path("/usr/share/opencode-voice/models"))
        service.arm()
        await asyncio.wait_for(service.stop.wait(), 1)

    async def test_handoff_during_loading(self):
        ready = asyncio.Event()
        finish = asyncio.Event()

        async def load(cache, download):
            self.loads.append((cache, download))
            ready.set()
            await finish.wait()
            return self.models

        self.service.load = load
        a, aw = await self.client("a")
        b, bw = await self.client("b")
        await self.send(aw, {"type": "resume"})
        await self.event(a, "starting")
        await asyncio.wait_for(ready.wait(), 1)
        await self.send(bw, {"type": "resume"})
        await self.event(a, "waiting")
        await self.event(b, "starting")
        finish.set()
        await self.event(b, "waiting")
        self.assertEqual(len(self.loads), 1)
        self.assertIn(("a", "start"), self.log)
        self.assertTrue(self.protocols["a"].gate.suspended)

    async def test_stop_only_closes_its_client(self):
        a, aw = await self.client("a")
        b, bw = await self.client("b")
        await self.send(aw, {"type": "resume"})
        await self.event(a, "starting")
        await self.event(a, "waiting")
        await self.send(bw, {"type": "stop"})
        await self.event(b, "off")
        self.assertEqual(await b.readline(), b"")
        self.assertEqual(self.service.owner.start["headers"]["authorization"], "a")

    async def test_delegation_completion_survives_blur_and_refocus(self):
        a, aw = await self.client("a")
        b, bw = await self.client("b")
        await self.send(aw, {"type": "resume"})
        await self.event(a, "starting")
        await self.event(a, "waiting")
        await self.send(aw, {"type": "wake"})
        await self.event(a, "listening")
        protocol = self.protocols["a"]
        protocol.event(
            {
                "type": "delegation.created",
                "item": {
                    "type": "delegation",
                    "target": "client",
                    "id": "job",
                    "content": [{"type": "input_text", "text": "implement fix"}],
                },
            }
        )
        self.assertEqual(
            await self.event(a),
            {"type": "delegate", "id": "job", "text": "implement fix"},
        )
        await self.send(bw, {"type": "resume"})
        await self.event(b, "starting")
        await self.event(b, "waiting")
        self.assertTrue(protocol.gate.suspended)
        self.assertFalse(protocol.gate.audible)
        self.assertEqual(protocol.gate.process(b"x" * 1920), bytes(1920))
        self.assertLess(self.log.index(("a", "muted")), self.log.index(("b", "start")))
        await self.send(
            aw,
            {
                "type": "result",
                "id": "job",
                "text": "finished privately",
                "final": True,
            },
        )
        await self.send(aw, {"type": "context", "text": "barrier"})
        while (await self.event(a)).get("text") != "barrier":
            pass
        self.assertEqual(protocol.pending["job"]["text"], "finished privately")
        self.assertEqual(self.protocols["b"].pending, {})
        self.assertEqual(protocol.flush(), [])
        await self.send(aw, {"type": "resume"})
        await self.event(a, "waiting")
        self.assertIs(self.protocols["a"], protocol)
        await self.send(aw, {"type": "wake"})
        await self.event(a, "listening")
        events = protocol.flush()
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["delegation_item_id"], "job")
        self.assertIn("finished privately", events[0]["content"][0]["text"])
        self.assertEqual(protocol.flush(), [])
        self.assertEqual(len(self.loads), 1)
        self.assertEqual(self.log.count(("a", "start")), 1)

    async def test_failed_models_retry_for_new_client(self):
        async def load(cache, download):
            self.loads.append(cache)
            if len(self.loads) == 1:
                raise RuntimeError("private error")
            return self.models

        self.service.load = load
        a, aw = await self.client("a")
        await self.send(aw, {"type": "resume"})
        await self.event(a, "starting")
        error = await self.event(a)
        self.assertEqual(error["type"], "error")
        self.assertNotIn("private error", error["message"])
        await asyncio.wait_for(a.read(), 1)
        b, bw = await self.client("b")
        await self.send(bw, {"type": "resume"})
        await self.event(b, "starting")
        await self.event(b, "waiting")
        self.assertEqual(len(self.loads), 2)

    async def test_handshake_rejects_wrong_version_mode_and_credentials(self):
        for command in (
            {**HELLO, "version": 2},
            {**HELLO, "version": True},
            {**HELLO, "mode": "packaged"},
            {**HELLO, "headers": {}},
            {"type": "start", "headers": {"authorization": "secret"}, "cache": "/tmp"},
        ):
            reader, writer = await asyncio.open_unix_connection(str(self.path))
            self.writers.append(writer)
            await self.send(writer, command)
            self.assertEqual((await self.event(reader))["type"], "error")
            self.assertEqual(await reader.read(), b"")
        self.assertEqual(self.loads, [])
        self.assertEqual(self.service.audio.starts, 0)

    async def test_idle_callback_rechecks_clients_and_generation(self):
        self.service.arm()
        callback = self.service.timer._callback
        await self.client("a")
        callback()
        self.assertFalse(self.service.stop.is_set())
        self.service.arm()
        self.service.timer._callback()
        self.assertFalse(self.service.stop.is_set())


class Sharing(unittest.IsolatedAsyncioTestCase):
    async def test_bridge_injected_capture_and_synchronous_startup_control(self):
        ready = asyncio.Event()
        controls = []
        events = []

        class Track:
            def stop(self):
                pass

        class Peer:
            def on(self, name):
                return lambda fn: fn

            def createDataChannel(self, name):
                return self

            def addTrack(self, track):
                self.track = track

            async def createOffer(self):
                ready.set()
                await asyncio.Event().wait()

            async def setLocalDescription(self, description):
                pass

            async def close(self):
                pass

        def control(fn):
            controls.append(fn)
            self.assertTrue(fn.__self__.gate.suspended)

        modules = {
            "aiohttp": types.SimpleNamespace(),
            "av": types.SimpleNamespace(),
            "aiortc": types.SimpleNamespace(
                AudioStreamTrack=Track,
                RTCPeerConnection=Peer,
                RTCSessionDescription=object,
            ),
            "webrtcvad": types.SimpleNamespace(Vad=lambda mode: Vad()),
        }
        with (
            patch.dict(sys.modules, modules),
            patch("bridge.record", side_effect=AssertionError("per-client recorder")),
            patch(
                "bridge.models", side_effect=AssertionError("duplicate model loading")
            ),
        ):
            task = asyncio.create_task(
                bridge.run(
                    {"headers": {}, "cache": "/unused"},
                    asyncio.Queue(),
                    loaded=(),
                    capture=Capture(),
                    control=control,
                    output=events.append,
                )
            )
            try:
                await asyncio.wait_for(ready.wait(), 1)
                gate = controls[0].__self__.gate
                controls[0]({"type": "resume"})
                controls[0]({"type": "wake"})
                controls[0]({"type": "suspend"})
                self.assertTrue(gate.suspended)
                self.assertFalse(gate.audible)
                self.assertEqual(gate.process(b"x" * 1920), bytes(1920))
                gate.ready = True
                self.assertEqual(gate.process(b"x" * 1920), bytes(1920))
            finally:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

    async def test_cancelled_model_waiter_does_not_poison_retry(self):
        finish = asyncio.Event()
        calls = []

        async def load(cache, download):
            calls.append(cache)
            await finish.wait()
            if len(calls) == 1:
                raise ValueError("failed after disconnect")
            return ()

        service = Service("/unused", load=load)
        waiter = asyncio.create_task(service.models())
        await asyncio.sleep(0)
        loading = service.loading
        waiter.cancel()
        await asyncio.gather(waiter, return_exceptions=True)
        finish.set()
        await asyncio.gather(loading, return_exceptions=True)
        self.assertIsNone(service.loading)
        self.assertEqual(await service.models(), ())
        self.assertEqual(len(calls), 2)

    async def test_gates_share_weights_not_recognizers(self):
        class Recognizer:
            def __init__(self, model, rate, words):
                self.model = model
                self.resets = 0

            def Reset(self):
                self.resets += 1

        loaded = tuple((word, object(), words) for word, _, words in bridge.MODELS)
        with patch.dict(
            sys.modules, {"vosk": types.SimpleNamespace(KaldiRecognizer=Recognizer)}
        ):
            a = Gate(models=loaded, vad=Vad())
            b = Gate(models=loaded, vad=Vad())
        a.suspend()
        for (_, first), (_, second) in zip(a.recognizers, b.recognizers):
            self.assertIs(first.model, second.model)
            self.assertIsNot(first, second)
            self.assertEqual(first.resets, 1)
            self.assertEqual(second.resets, 0)
        self.assertFalse(b.suspended)

    async def test_model_singleflight_failure_and_retry(self):
        ready = asyncio.Event()
        calls = []

        async def load(cache, download):
            calls.append(cache)
            await ready.wait()
            if len(calls) == 1:
                raise ValueError("broken")
            return ()

        service = Service("/unused", load=load)
        tasks = [asyncio.create_task(service.models()) for _ in range(3)]
        await asyncio.sleep(0)
        ready.set()
        results = await asyncio.gather(*tasks, return_exceptions=True)
        self.assertTrue(all(isinstance(result, ValueError) for result in results))
        self.assertEqual(len(calls), 1)
        self.assertEqual(await service.models(), ())
        self.assertEqual(len(calls), 2)
        self.assertEqual(await service.models(), ())
        self.assertEqual(len(calls), 2)

    async def test_shared_audio_process_and_silence(self):
        processes = []

        async def record():
            process = await asyncio.create_subprocess_exec(
                sys.executable,
                "-c",
                "import os,time; os.write(1,b'x'*1920); time.sleep(60)",
                stdout=asyncio.subprocess.PIPE,
            )
            processes.append(process)
            return process

        audio = Audio(record=record)
        client = types.SimpleNamespace(capture=Capture())
        background = Capture()
        try:
            audio.start(client)
            for _ in range(50):
                data = await client.capture.recv()
                if data != bytes(1920):
                    break
            self.assertEqual(data, b"x" * 1920)
            self.assertEqual(await background.recv(), bytes(1920))
        finally:
            await audio.close()
        self.assertEqual(len(processes), 1)
        self.assertIsNotNone(processes[0].returncode)
        self.assertIsNone(audio.task)

    async def test_audio_cancel_during_spawn_reaps_process(self):
        ready = asyncio.Event()
        finish = asyncio.Event()
        processes = []

        async def record():
            ready.set()
            await finish.wait()
            process = await asyncio.create_subprocess_exec(
                sys.executable,
                "-c",
                "import time; time.sleep(60)",
                stdout=asyncio.subprocess.PIPE,
            )
            processes.append(process)
            return process

        audio = Audio(record=record)
        audio.start(types.SimpleNamespace(capture=Capture()))
        await ready.wait()
        closing = asyncio.create_task(audio.close())
        await asyncio.sleep(0)
        finish.set()
        await asyncio.wait_for(closing, 2)
        self.assertIsNotNone(processes[0].returncode)


async def sampling(capture, process=lambda data: None, count=101, overhead=0.004):
    reader = asyncio.StreamReader()
    pump = asyncio.create_task(capture.run(reader))
    loop = asyncio.get_running_loop()
    start = loop.time()
    received = []
    backlog = []

    async def produce():
        for index in range(1, count + 1):
            await asyncio.sleep(max(0, start + (index - 1) * 0.02 - loop.time()))
            reader.feed_data(index.to_bytes(4, "little") + bytes(1916))
            await asyncio.sleep(0)
            backlog.append(capture.frames.qsize())

    async def consume():
        while len(received) < count:
            try:
                data = await asyncio.wait_for(capture.recv(), 0.3)
            except TimeoutError:
                return
            if data == bytes(1920):
                if loop.time() > start + count * 0.02 + 0.3:
                    return
                continue
            received.append(int.from_bytes(data[:4], "little"))
            process(data)
            if overhead:
                await asyncio.sleep(overhead)

    try:
        await asyncio.wait_for(asyncio.gather(produce(), consume()), count * 0.02 + 2)
        return {
            "produced": count,
            "consumed": len(received),
            "queued": capture.frames.qsize(),
            "backlog": max(backlog),
            "dropped": count - len(received),
            "ordered": received == list(range(1, count + 1)),
        }
    finally:
        pump.cancel()
        await asyncio.gather(pump, return_exceptions=True)


class Pacing(unittest.IsolatedAsyncioTestCase):
    async def test_sustained_frames_match_bridge_with_processing_overhead(self):
        baseline, shared = await asyncio.gather(
            sampling(bridge.Capture()), sampling(Capture())
        )
        for result in (baseline, shared):
            self.assertEqual(result["consumed"], 101, result)
            self.assertEqual(result["dropped"], 0, result)
            self.assertEqual(result["queued"], 0, result)
            self.assertTrue(result["ordered"], result)
            self.assertLessEqual(result["backlog"], 4, result)

    async def test_silence_uses_absolute_deadlines(self):
        capture = Capture()
        loop = asyncio.get_running_loop()
        start = loop.time()
        for _ in range(30):
            self.assertEqual(await capture.recv(), bytes(1920))
            await asyncio.sleep(0.008)
        elapsed = loop.time() - start
        self.assertGreaterEqual(elapsed, 0.59)
        self.assertLess(elapsed, 0.72)

    async def test_resume_and_clear_do_not_replay_silence_deadlines(self):
        capture = Capture()
        loop = asyncio.get_running_loop()
        self.assertEqual(await capture.recv(), bytes(1920))
        start = loop.time()
        capture.frames.put_nowait(b"x" * 1920)
        self.assertEqual(await capture.recv(), b"x" * 1920)
        self.assertGreaterEqual(loop.time() - start, 0.015)
        # Once real audio resumes, queued pipe bursts have bridge semantics.
        capture.frames.put_nowait(b"y" * 1920)
        capture.frames.put_nowait(b"z" * 1920)
        self.assertEqual(await capture.recv(), b"y" * 1920)
        self.assertEqual(await capture.recv(), b"z" * 1920)
        capture.frames.put_nowait(b"stale")
        capture.clear()
        self.assertEqual(await capture.recv(), bytes(1920))
        await asyncio.sleep(0.07)
        self.assertEqual(await capture.recv(), bytes(1920))
        start = loop.time()
        self.assertEqual(await capture.recv(), bytes(1920))
        self.assertGreaterEqual(loop.time() - start, 0.015)

    @unittest.skipUnless(
        os.environ.get("OPENCODE_VOICE_MODELS"),
        "Set OPENCODE_VOICE_MODELS for native pacing comparison",
    )
    async def test_native_model_processing_matches_bridge(self):
        loaded = await bridge.models(
            Path(os.environ["OPENCODE_VOICE_MODELS"]), download=False
        )
        results = []
        for factory in (bridge.Capture, Capture):
            gate = Gate(loaded)
            for _, recognizer in gate.recognizers:
                recognizer.AcceptWaveform(bytes(96000))
                recognizer.Reset()
            gate.ready = True
            results.append(
                await sampling(factory(), gate.process, count=201, overhead=0)
            )
        print("Native capture pacing:", results)
        for result in results:
            self.assertEqual(result["consumed"], 201, result)
            self.assertEqual(result["dropped"], 0, result)
            self.assertEqual(result["queued"], 0, result)
            self.assertTrue(result["ordered"], result)
            self.assertLessEqual(result["backlog"], 4, result)


class Shutdown(unittest.IsolatedAsyncioTestCase):
    async def test_serve_stops_with_connected_client(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "voice.sock"
            with Endpoint(path) as sock:
                service = Service(temp)
                task = asyncio.create_task(service.serve(sock))
                reader, writer = await asyncio.open_unix_connection(str(path))
                writer.write((json.dumps(HELLO) + "\n").encode())
                await writer.drain()
                self.assertEqual(json.loads(await reader.readline()), HELLO)
                writer.write(
                    b'{"type":"start","headers":{"authorization":"secret"},"cache":"ignored"}\n'
                )
                await writer.drain()
                await asyncio.wait_for(reader.readline(), 1)
                await asyncio.wait_for(reader.readline(), 1)
                await asyncio.wait_for(reader.readline(), 1)
                service.stop.set()
                await asyncio.wait_for(task, 2)
                self.assertEqual(await reader.read(), b"")
                writer.close()
                await writer.wait_closed()
                self.assertFalse(service.tasks)

    async def test_serve_idle_shutdown(self):
        with tempfile.TemporaryDirectory() as temp:
            with Endpoint(Path(temp) / "voice.sock") as sock:
                service = Service(temp, idle=0.01)
                await asyncio.wait_for(service.serve(sock), 1)
                self.assertTrue(service.stop.is_set())


if __name__ == "__main__":
    unittest.main()
