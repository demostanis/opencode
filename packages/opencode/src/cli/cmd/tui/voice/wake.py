import json
from collections import deque
import re
import struct
import time
import unicodedata


MODELS = (
    (
        "slave",
        "vosk-model-small-en-us-0.15",
        ["slave", "save", "slaves", "slay", "sleep", "[unk]"],
    ),
    ("esclave", "vosk-model-small-fr-0.22", ["esclave", "escalade", "espace", "[unk]"]),
)


def stopping(text):
    text = (
        unicodedata.normalize("NFKD", text.casefold())
        .encode("ascii", "ignore")
        .decode()
    )
    text = " ".join(re.findall(r"[a-z]+", text))
    commands = (
        "stop listening",
        "shut up",
        "stop talking",
        "be quiet",
        "that s all",
        "tais toi",
        "ta gueule",
        "arrete de m ecouter",
        "arrete d ecouter",
        "arrete de parler",
        "laisse moi tranquille",
        "c est tout",
        "j ai termine",
        "coupe le micro",
        "coupe ton micro",
        "desactive le micro",
        "arrete",
        "stop",
    )
    # Consume only complete voice commands and politeness, never arbitrary suffixes
    # such as "stop server" or "tais-toi et modifie le fichier".
    pattern = "(?:" + "|".join(re.escape(value) for value in commands) + ")"
    filler = r"(?:maintenant|s il te plait|s il vous plait|please|merci|ok|okay)"
    return bool(
        re.fullmatch(rf"(?:{filler} )?{pattern}(?: (?:{pattern}|{filler}))*", text)
    )


class Gate:
    def __init__(
        self,
        models=(),
        clock=time.monotonic,
        timeout=20,
        change=lambda: None,
        mute=lambda: None,
        vad=None,
    ):
        if vad is None:
            import webrtcvad

            vad = webrtcvad.Vad(2)
        self.vad = vad
        self.load(models)

        self.clock = clock
        self.timeout = timeout
        self.change = change
        self.mute = mute
        self.ready = False
        self.suspended = False
        self.active = False
        self.grace = 0
        self.blocked = False
        self.notification = False
        self.lease = 0
        self.reply = False
        self.until = 0
        self.queued = 0
        self.cooldown = 0
        self.idle = 0
        self.last = clock()
        # Keep 200 ms locally to avoid clipping words immediately after the wake word.
        self.history = deque(maxlen=10)
        self.replay = deque()

    def load(self, models):
        self.recognizers = []
        if models:
            from vosk import KaldiRecognizer

            self.recognizers = [
                (word, KaldiRecognizer(model, 48000, json.dumps(words)))
                for word, model, words in models
            ]
            for _, recognizer in self.recognizers:
                recognizer.SetWords(True)

    @property
    def authorized(self):
        return (
            not self.suspended
            and not self.blocked
            and (self.active or self.clock() < self.grace)
        )

    @property
    def speaking(self):
        return self.audible and self.clock() < self.until

    @property
    def audible(self):
        return (
            not self.suspended
            and not self.blocked
            and (self.active or self.notification)
        )

    @property
    def state(self):
        if self.suspended:
            return "waiting"
        return (
            "speaking" if self.speaking else "listening" if self.active else "waiting"
        )

    def wake(self):
        if self.suspended:
            return
        self.active = True
        self.grace = 0
        self.blocked = False
        self.notification = False
        self.idle = 0
        self.last = self.clock()
        self.history.clear()
        self.replay.clear()
        for _, recognizer in self.recognizers:
            recognizer.Reset()
        self.change()

    def suspend(self):
        self.suspended = True
        self.reset()

    def resume(self):
        self.reset()
        self.cooldown = 0
        self.suspended = False
        self.change()

    def reset(self, explicit=True):
        self.grace = self.clock() + 30 if self.active and not explicit else 0
        self.active = False
        self.blocked = explicit
        self.notification = False
        self.lease = 0
        self.reply = False
        self.until = 0
        self.queued = 0
        self.idle = 0
        self.last = self.clock()
        self.cooldown = self.clock() + 2
        self.history.clear()
        self.replay.clear()
        for _, recognizer in self.recognizers:
            recognizer.Reset()
        self.mute()
        self.change()

    def tick(self, speech=False):
        now = self.clock()
        if self.active:
            self.idle = (
                0
                if speech and not self.speaking
                else self.idle + max(0, now - max(self.last, self.until))
            )
        self.last = now
        if self.notification and now >= max(self.until, self.lease):
            self.notification = False
            if not self.active:
                self.mute()
                self.cooldown = now + 0.5
        if self.active and self.idle >= self.timeout:
            self.reset(explicit=False)
        self.change()

    def event(self, event):
        if event.get("turn", {}).get("role") != "assistant":
            return
        self.tick()
        if event.get("type") == "turn.created" and self.audible:
            self.reply = True
        if event.get("type") == "turn.done":
            self.reply = False
            # A DC turn.done can beat the final sideband PCM to the client.
            self.lease = min(self.lease, self.clock() + 2)
        self.change()

    def audio(self, data):
        if len(data) % 2:
            raise ValueError("Invalid PCM frame")
        self.tick()
        if not self.audible or not data:
            return False
        end = 0
        for offset in range(0, len(data), 960):
            block = data[offset : offset + 960]
            samples = struct.unpack("<" + "h" * (len(block) // 2), block)
            # AC RMS above ~-48 dBFS in a 20 ms window. Ignore digital silence,
            # dither and DC offset without depending on remote turn completion.
            mean = sum(samples) / len(samples)
            if sum((sample - mean) ** 2 for sample in samples) / len(samples) >= 128**2:
                end = offset + len(samples) * 2
        now = self.clock()
        if not end and now >= self.until:
            return False
        start = max(now, self.queued)
        self.queued = min(start + len(data) / 48000, now + 2)
        if end:
            self.until = min(start + end / 48000, now + 2)
        self.change()
        return True

    def notify(self):
        if self.suspended or self.blocked:
            return False
        self.notification = True
        # Bound a result lease even if the server never produces a turn.
        self.lease = self.clock() + 60
        return True

    def process(self, data):
        if not self.ready or self.suspended:
            return bytes(len(data))
        self.tick(self.vad.is_speech(data, 48000) if self.active else False)
        if self.active:
            self.replay.append(data)
            return self.replay.popleft()
        if self.speaking or self.clock() < self.cooldown:
            return bytes(len(data))
        self.history.append(data)
        for word, recognizer in self.recognizers:
            if not recognizer.AcceptWaveform(data):
                continue
            result = json.loads(recognizer.Result())
            words = result.get("result", [])
            # Require a completed, isolated word, not a mention inside a sentence
            # or the same provisional guess repeated over successive audio frames.
            if (
                result.get("text") == word
                and len(words) == 1
                and words[0].get("word") == word
                and words[0].get("conf", 0) >= 0.9
                and words[0].get("end", 0) - words[0].get("start", 0) >= 0.15
            ):
                replay = tuple(self.history)
                self.wake()
                self.replay.extend(replay)
                break
        return bytes(len(data))
