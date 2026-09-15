# /// script
# requires-python = ">=3.11"
# dependencies = ["aiortc==1.14.0", "aiohttp==3.12.15", "vosk==0.3.45", "webrtcvad-wheels==2.0.14"]
# ///
"""Per-user voice service. Each stream is newline JSON, start then resume/suspend.

Hello negotiates version/mode before credentials; start acknowledges with started.
Resume replaces microphone ownership, not the client's remote session. Suspended
sessions retain pending delegations and transmit silence. No automatic fallback.
"""

import argparse
import asyncio
import contextlib
import fcntl
import json
import logging
import os
from pathlib import Path
import signal
import socket
import stat
import struct
import sys

sys.dont_write_bytecode = True

import bridge


def peer(sock):
    return (
        struct.unpack("3i", sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))[
            1
        ]
        == os.getuid()
    )


class Endpoint:
    """Pin a private directory and hold an election lock until socket cleanup."""

    def __init__(self, path):
        self.path = Path(path)
        self.dir = None
        self.lock = None
        self.sock = None
        self.inode = None

    def __enter__(self):
        try:
            if not self.path.is_absolute() or ".." in self.path.parts:
                raise ValueError("Socket path must be absolute")
            self.dir = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
            for part in self.path.parent.parts[1:]:
                fd = os.open(
                    part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=self.dir
                )
                os.close(self.dir)
                self.dir = fd
                info = os.fstat(fd)
                if info.st_uid not in (0, os.getuid()) or (
                    info.st_mode & 0o022
                    and not (info.st_uid == 0 and info.st_mode & stat.S_ISVTX)
                ):
                    raise ValueError("Unsafe socket ancestor")
            info = os.fstat(self.dir)
            if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
                raise ValueError(
                    "Socket directory must be owned by user with mode 0700"
                )
            self.lock = os.open(
                self.path.name + ".lock",
                os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK,
                0o600,
                dir_fd=self.dir,
            )
            info = os.fstat(self.lock)
            if (
                not stat.S_ISREG(info.st_mode)
                or info.st_uid != os.getuid()
                or info.st_nlink != 1
                or stat.S_IMODE(info.st_mode) != 0o600
            ):
                raise ValueError("Unsafe voice lock")
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if (
                os.stat(
                    self.path.name + ".lock", dir_fd=self.dir, follow_symlinks=False
                )
                != info
            ):
                raise ValueError("Voice lock changed during election")
            address = f"/proc/self/fd/{self.dir}/{self.path.name}"
            info = self.info()
            if info:
                if (
                    not stat.S_ISSOCK(info.st_mode)
                    or info.st_uid != os.getuid()
                    or stat.S_IMODE(info.st_mode) != 0o600
                ):
                    raise ValueError("Unsafe existing socket")
                with socket.socket(socket.AF_UNIX) as probe:
                    probe.settimeout(0.2)
                    try:
                        probe.connect(address)
                    except ConnectionRefusedError:
                        pass
                    else:
                        raise FileExistsError("Voice service already running")
                if self.info() != info:
                    raise ValueError("Socket changed during election")
                os.unlink(self.path.name, dir_fd=self.dir)
            self.sock = socket.socket(socket.AF_UNIX)
            mask = os.umask(0o177)
            try:
                self.sock.bind(address)
            finally:
                os.umask(mask)
            info = self.info()
            if info is None:
                raise ValueError("Socket disappeared during election")
            self.inode = info.st_ino
            self.sock.listen(32)
            self.sock.setblocking(False)
            return self.sock
        except BaseException:
            self.close()
            raise

    def info(self):
        try:
            return os.stat(self.path.name, dir_fd=self.dir, follow_symlinks=False)
        except FileNotFoundError:
            return None

    def close(self):
        if self.sock:
            self.sock.close()
        if self.inode is not None:
            info = self.info()
            if (
                info
                and info.st_ino == self.inode
                and stat.S_ISSOCK(info.st_mode)
                and info.st_uid == os.getuid()
            ):
                os.unlink(self.path.name, dir_fd=self.dir)
            self.inode = None
        for fd in (self.lock, self.dir):
            if fd is not None:
                os.close(fd)
        self.lock = self.dir = None

    def __exit__(self, *args):
        self.close()


def validate(command, started):
    if not isinstance(command, dict):
        raise ValueError("Invalid command")
    kind = command.get("type")
    if not started:
        auth = command.get("headers")
        if (
            kind != "start"
            or not isinstance(auth, dict)
            or not auth
            or not all(
                isinstance(k, str) and isinstance(v, str) for k, v in auth.items()
            )
            or not isinstance(command.get("cache"), str)
            or not command["cache"]
        ):
            raise ValueError("Invalid start")
        return
    fields = {
        "stop": {"type"},
        "resume": {"type"},
        "suspend": {"type"},
        "wake": {"type"},
        "mute": {"type"},
        "context": {"type", "text"},
        "result": {"type", "text", "id", "final"},
        "tool": {"type", "id", "name"},
    }
    if kind not in fields or set(command) != fields[kind]:
        raise ValueError("Invalid command")
    if kind in ("context", "result") and (
        not isinstance(command["text"], str) or len(command["text"]) > 32768
    ):
        raise ValueError("Invalid text")
    if kind in ("result", "tool") and (
        not isinstance(command["id"], str) or not 0 < len(command["id"]) <= 256
    ):
        raise ValueError("Invalid id")
    if (
        kind == "result"
        and not isinstance(command["final"], bool)
        or kind == "tool"
        and command["name"] != "stop_listening"
    ):
        raise ValueError("Invalid command")


class Capture(bridge.Capture):
    def __init__(self):
        super().__init__()
        self.deadline = None
        self.silent = False

    async def recv(self):
        loop = asyncio.get_running_loop()
        deadline = self.deadline if self.deadline is not None else loop.time() + 0.02
        if self.silent:
            # Keep silence on its clock, including processing time. On resume,
            # finish this silence interval before delivering the first real frame.
            await asyncio.sleep(max(0, deadline - loop.time()))
        if not self.frames.empty():
            data = self.frames.get_nowait()
        elif self.silent or deadline <= loop.time():
            data = None
        else:
            try:
                data = await asyncio.wait_for(self.frames.get(), deadline - loop.time())
            except TimeoutError:
                data = None
        self.silent = data is None
        now = loop.time()
        # Real frames are paced by the producer, never by an extra per-frame sleep.
        # Rebase missed silence deadlines rather than emitting catch-up bursts.
        self.deadline = (
            deadline + 0.02 if self.silent and deadline + 0.02 > now else now + 0.02
        )
        return bytes(1920) if data is None else data


class Audio:
    def __init__(self, record=bridge.record):
        self.record = record
        self.task = None

    def start(self, client):
        self.task = asyncio.create_task(self.run(client))

    async def run(self, client):
        source = None
        task = asyncio.create_task(self.record())
        try:
            try:
                source = await asyncio.shield(task)
            except asyncio.CancelledError:
                source = await task
                raise
            await client.capture.run(source.stdout)
        except asyncio.CancelledError:
            raise
        except Exception as err:
            client.emit(bridge.failure("capture", err))
            client.writer.close()
        finally:
            if source:
                if source.returncode is None:
                    with contextlib.suppress(ProcessLookupError):
                        source.kill()
                await source.communicate()

    async def close(self):
        if self.task:
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)
            self.task = None


class Client:
    def __init__(self, writer):
        self.writer = writer
        self.start = None
        self.hello = False
        self.task = None
        self.control = None
        self.capture = Capture()
        self.closed = False
        self.wake = False
        self.queue = asyncio.Queue(maxsize=128)

    def emit(self, event):
        if self.writer.is_closing():
            return
        data = (json.dumps(event, ensure_ascii=True) + "\n").encode()
        if (
            len(data) > 262144
            or self.writer.transport.get_write_buffer_size() + len(data) > 524288
        ):
            self.writer.transport.abort()
            return
        self.writer.write(data)

    def state(self, state):
        self.emit({"type": "state", "state": state})


class Service:
    def __init__(
        self,
        cache,
        packaged=False,
        idle=60,
        run=bridge.run,
        load=bridge.models,
        audio=None,
    ):
        self.cache = (
            Path("/usr/share/opencode-voice/models") if packaged else Path(cache)
        )
        self.packaged = packaged
        self.idle = idle
        self.run = run
        self.load = load
        self.loaded = None
        self.loading = None
        self.owner = None
        self.audio = audio if audio is not None else Audio()
        self.lock = asyncio.Lock()
        self.clients = set()
        self.tasks = set()
        self.stop = asyncio.Event()
        self.timer = None

    def arm(self):
        if self.timer:
            self.timer.cancel()

        def expire():
            if self.timer is timer and not self.clients and self.owner is None:
                self.stop.set()

        timer = asyncio.get_running_loop().call_later(self.idle, expire)
        self.timer = timer

    async def release(self):
        client = self.owner
        self.owner = None
        if client:
            client.wake = False
            if client.control:
                client.control({"type": "suspend"})
            client.capture.clear()
            client.state("waiting")
        await self.audio.close()
        if client:
            client.capture.clear()

    async def destroy(self, client):
        client.closed = True
        if self.owner is client:
            await self.release()
        if client.control:
            client.control({"type": "suspend"})
            client.control = None
        if client.task:
            client.task.cancel()
            await asyncio.gather(client.task, return_exceptions=True)
            client.task = None

    async def models(self):
        if self.loaded is not None:
            return self.loaded
        if self.loading is None:

            def settled(task):
                if not task.cancelled() and task.exception() is None:
                    self.loaded = task.result()
                if self.loading is task:
                    self.loading = None

            self.loading = asyncio.create_task(
                self.load(self.cache, download=not self.packaged)
            )
            self.loading.add_done_callback(settled)
        task = self.loading
        try:
            # wait() leaves initialization alive when its last client disconnects.
            await asyncio.wait({task})
            self.loaded = task.result()
            return self.loaded
        finally:
            # An older failing waiter must not clear a newer retry's singleflight.
            if task.done() and self.loading is task:
                self.loading = None

    async def active(self, client):
        def output(event):
            if client.closed:
                return
            if event["type"] == "timing" and client.start.get("timing") is not True:
                return
            if event["type"] == "state" and self.owner is not client:
                client.state("waiting")
                return
            client.emit(event)

        def control(fn):
            client.control = fn
            fn({"type": "resume" if self.owner is client else "suspend"})
            if self.owner is client and client.wake:
                fn({"type": "wake"})

        stage = "models"
        try:
            loaded = await self.models()
            stage = "startup"
            await self.run(
                client.start,
                client.queue,
                loaded=loaded,
                output=output,
                capture=client.capture,
                control=control,
            )
        except asyncio.CancelledError:
            raise
        except Exception as err:
            output(bridge.failure(stage, err))
        finally:
            client.control = None
            # The connection cleanup owns destruction, avoiding a session/lock cycle.
            client.writer.close()

    async def command(self, client, command):
        validate(command, client.start is not None)
        kind = command["type"]
        async with self.lock:
            if self.stop.is_set():
                raise ConnectionError("Service shutting down")
            if kind == "start":
                client.start = {**command, "cache": str(self.cache)}
                client.emit({"type": "started"})
                client.state("starting")
                client.state("waiting")
                return
            if kind in ("suspend", "stop"):
                if self.owner is client:
                    await self.release()
                client.state("off" if kind == "stop" else "waiting")
                return
            if kind == "resume":
                if self.owner is client:
                    return
                await self.release()
                self.owner = client
                client.capture.clear()
                if client.control:
                    client.control({"type": "resume"})
                    client.state("waiting")
                if client.task is None:
                    client.state("starting")
                    client.task = asyncio.create_task(self.active(client))
                self.audio.start(client)
                return
            if kind in ("wake", "mute"):
                if self.owner is client:
                    client.wake = kind == "wake"
                if client.control and (kind == "mute" or self.owner is client):
                    client.control(command)
                return
            client.queue.put_nowait(command)

    async def connect(self, reader, writer):
        task = asyncio.current_task()
        self.tasks.add(task)
        client = Client(writer)
        try:
            if (
                self.stop.is_set()
                or not peer(writer.get_extra_info("socket"))
                or len(self.clients) >= 64
            ):
                return
            self.clients.add(client)
            if self.timer:
                self.timer.cancel()
                self.timer = None
            while True:
                line = (
                    await asyncio.wait_for(reader.readline(), 10)
                    if client.start is None
                    else await reader.readline()
                )
                if not line:
                    break
                if len(line) > 262144 or not line.endswith(b"\n"):
                    raise ValueError("Invalid frame")
                command = json.loads(line)
                if not client.hello:
                    hello = {
                        "type": "hello",
                        "version": 1,
                        "mode": "packaged" if self.packaged else "development",
                    }
                    if command != hello or type(command.get("version")) is not int:
                        raise ValueError("Incompatible voice service")
                    client.hello = True
                    client.emit(hello)
                    continue
                await self.command(client, command)
                if command["type"] == "stop":
                    break
        except (ValueError, TypeError, asyncio.QueueFull, TimeoutError):
            client.emit(
                {"type": "error", "message": "Invalid voice command or input overflow"}
            )
        except (ConnectionError, OSError):
            pass
        finally:
            async with self.lock:
                await self.destroy(client)
                self.clients.discard(client)
                if not self.clients:
                    self.arm()
            writer.close()
            with contextlib.suppress(ConnectionError, OSError, TimeoutError):
                await asyncio.wait_for(writer.wait_closed(), 1)
            self.tasks.discard(task)

    async def serve(self, sock):
        server = await asyncio.start_unix_server(self.connect, sock=sock, limit=262144)
        self.arm()
        try:
            await self.stop.wait()
        finally:
            self.stop.set()
            server.close()
            for client in self.clients:
                client.writer.transport.abort()
            await asyncio.gather(*self.tasks, return_exceptions=True)
            await server.wait_closed()
            async with self.lock:
                await self.release()
            if self.loading:
                self.loading.cancel()
                await asyncio.gather(self.loading, return_exceptions=True)
            if self.timer:
                self.timer.cancel()


async def main(args):
    service = Service(args.cache, args.packaged)
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, service.stop.set)
    try:
        with Endpoint(args.socket) as sock:
            await service.serve(sock)
    finally:
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.remove_signal_handler(sig)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--socket", required=True)
    parser.add_argument("--cache", required=True)
    parser.add_argument("--packaged", action="store_true")
    logging.disable(logging.CRITICAL)
    try:
        asyncio.run(main(parser.parse_args()))
    except BlockingIOError:
        pass
    except Exception:
        print(
            "Voice service failed; check socket permissions and dependencies",
            file=sys.stderr,
        )
        sys.exit(1)
