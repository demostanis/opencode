import asyncio
from pathlib import Path
import sys
import unittest
import weakref
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[4] / "src/cli/cmd/tui/voice"
sys.path.insert(0, str(ROOT))
from bridge import discard


class ReceiveTests(unittest.IsolatedAsyncioTestCase):
    async def test_run_registers_and_cleans_up_remote_consumer(self):
        import aiortc
        from aiortc.rtcrtpreceiver import RemoteStreamTrack
        from bridge import Capture, run

        remote = RemoteStreamTrack(kind="audio")
        peer = aiortc.RTCPeerConnection(aiortc.RTCConfiguration(iceServers=[]))

        class Finished(Exception):
            pass

        async def description(offer):
            remote._queue.put_nowait(object())
            peer.emit("track", remote)
            await asyncio.sleep(0)
            self.assertEqual(remote._queue.qsize(), 0)
            raise Finished()

        with (
            patch("aiortc.RTCPeerConnection", return_value=peer),
            patch.object(peer, "setLocalDescription", side_effect=description),
        ):
            with self.assertRaises(Finished):
                await run({}, asyncio.Queue(), loaded=[], capture=Capture())
        self.assertEqual(peer.connectionState, "closed")
        self.assertFalse(remote._queue._getters)

    async def test_discard_releases_frames_and_finishes_at_track_end(self):
        from aiortc.rtcrtpreceiver import RemoteStreamTrack

        class Frame:
            pass

        track = RemoteStreamTrack(kind="audio")
        task = asyncio.create_task(discard(track))
        references = []
        for _ in range(100):
            frame = Frame()
            references.append(weakref.ref(frame))
            track._queue.put_nowait(frame)
            del frame
            await asyncio.sleep(0)
            self.assertEqual(track._queue.qsize(), 0)
        self.assertTrue(all(ref() is None for ref in references))
        track._queue.put_nowait(None)
        await asyncio.wait_for(task, 1)

    async def test_discard_cancels_when_receiver_is_idle(self):
        from aiortc.rtcrtpreceiver import RemoteStreamTrack

        task = asyncio.create_task(discard(RemoteStreamTrack(kind="audio")))
        await asyncio.sleep(0)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task


if __name__ == "__main__":
    unittest.main()
