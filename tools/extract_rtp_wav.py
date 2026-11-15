#!/usr/bin/env python3
"""Cut one direction of a G.711 RTP stream out of a pcap and save it as WAV.

    python3 extract_rtp_wav.py call.pcap hold.wav --port 16096 --from 1794724053 --to 1794724060

--from/--to are unix timestamps. Without them the whole capture is used.
Handy to listen to (or spectrogram) exactly what the caller heard:

    ffmpeg -i hold.wav -filter_complex "showspectrumpic=s=900x420" spec.png
"""
import argparse
import struct
import sys
import wave

from rtp_dbfs import ULAW, ALAW, read_pcap, ip_udp


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("pcap")
    ap.add_argument("out")
    ap.add_argument("--port", type=int, required=True, help="RTP UDP port of the direction you want")
    ap.add_argument("--from", dest="t0", type=float, default=0.0, help="unix timestamp")
    ap.add_argument("--to", dest="t1", type=float, default=1e18, help="unix timestamp")
    a = ap.parse_args()

    packets = []
    for linktype, ts, data in read_pcap(a.pcap):
        if not (a.t0 <= ts <= a.t1):
            continue
        pkt = ip_udp(data, linktype)
        if not pkt:
            continue
        src, _dst, payload = pkt
        if src != a.port:
            continue
        if len(payload) < 12 or (payload[0] >> 6) != 2:
            continue
        pt = payload[1] & 0x7F
        if pt not in (0, 8):
            continue
        body = payload[12:]
        if payload[0] & 0x10 and len(body) >= 4:
            body = body[4 + struct.unpack(">H", body[2:4])[0] * 4:]
        packets.append((struct.unpack(">H", payload[2:4])[0], struct.unpack(">I", payload[4:8])[0], pt, body))

    if not packets:
        print("no matching packets")
        return 1

    packets.sort(key=lambda p: p[1])            # by RTP timestamp
    table = ALAW if packets[0][2] == 8 else ULAW

    pcm = bytearray()
    prev_ts = packets[0][1]
    for _seq, rtp_ts, _pt, body in packets:
        gap = (rtp_ts - prev_ts) & 0xFFFFFFFF
        if 0 < gap < 16000:                     # fill small gaps with silence
            pcm += b"\x00\x00" * gap
        for b in body:
            pcm += struct.pack("<h", table[b])
        prev_ts = rtp_ts

    with wave.open(a.out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(8000)
        w.writeframes(bytes(pcm))

    print(f"wrote {a.out}: {len(pcm) / 2 / 8000:.2f}s, {len(packets)} packets")
    return 0


if __name__ == "__main__":
    sys.exit(main())
