#!/usr/bin/env python3
"""Generate a royalty-free hold-music loop as an 8 kHz mono WAV.

Why: many "stock" MOH tracks are not licensed for redistribution, and hold
music you cannot ship is worse than none. This writes a soft four-chord loop
that is safe to reuse, loops seamlessly (every oscillator is enveloped to zero
at the loop point) and lands at telephone level.

    python3 make_hold_music.py out.wav [--seconds 9.6] [--peak-db -3]

Chord progression: C - G - Am - F, 100 bpm, pad + soft bells, no lyrics.
"""
import argparse
import math
import struct
import wave

SR = 8000
PROG = [
    (130.81, 164.81, 196.00),   # C  (C3 E3 G3)
    (196.00, 246.94, 293.66),   # G  (G3 B3 D4)
    (220.00, 261.63, 329.63),   # Am (A3 C4 E4)
    (174.61, 220.00, 261.63),   # F  (F3 A3 C4)
]
BELL = [1.0, 1.25, 1.5]          # ratios over the chord root, played as arpeggio


def env(i, n, attack, release):
    """Cosine attack/release envelope, exactly 0 at both ends."""
    a = max(1, int(attack * SR))
    r = max(1, int(release * SR))
    if i < a:
        return 0.5 - 0.5 * math.cos(math.pi * i / a)
    if i > n - r:
        return 0.5 - 0.5 * math.cos(math.pi * (n - i) / r)
    return 1.0


def render(seconds: float, peak_db: float) -> bytes:
    n = int(seconds * SR)
    bar = n // len(PROG)
    buf = [0.0] * n

    # Pads: one chord per bar, each tone enveloped to zero at bar edges.
    for bar_i, chord in enumerate(PROG):
        start = bar_i * bar
        for tone_i, f in enumerate(chord):
            amp = 0.16 / (tone_i + 1)
            for i in range(bar):
                t = i / SR
                # two detuned sines -> soft chorus, no beating at the loop seam
                s = math.sin(2 * math.pi * f * t) + 0.5 * math.sin(2 * math.pi * (f * 1.002) * t)
                buf[start + i] += amp * s * env(i, bar, 0.45, 0.55)

    # Bells: one short note per beat, decaying to silence.
    beat = int(0.6 * SR)
    total_beats = n // beat
    for b in range(total_beats):
        chord = PROG[(b // (total_beats // len(PROG) or 1)) % len(PROG)]
        f = chord[b % len(chord)] * BELL[b % len(BELL)] * 2
        start = b * beat
        length = min(int(0.55 * SR), n - start)
        for i in range(length):
            t = i / SR
            a = math.exp(-6.0 * t)
            buf[start + i] += 0.20 * a * math.sin(2 * math.pi * f * t) * env(i, length, 0.01, 0.08)

    peak = max(1e-9, max(abs(v) for v in buf))
    target = 10 ** (peak_db / 20.0)
    scale = target / peak
    return b"".join(struct.pack("<h", int(max(-1.0, min(1.0, v * scale)) * 32767)) for v in buf)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("out", nargs="?", default="hold.wav")
    ap.add_argument("--seconds", type=float, default=9.6)
    ap.add_argument("--peak-db", type=float, default=-3.0)
    a = ap.parse_args()

    data = render(a.seconds, a.peak_db)
    with wave.open(a.out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(data)
    print(f"wrote {a.out}: {a.seconds:.2f}s, {SR} Hz mono, peak {a.peak_db} dBFS")


if __name__ == "__main__":
    main()
