#!/usr/bin/env python3
"""Per-second dBFS of a G.711 RTP stream inside a pcap.

For the question "is there actually audio on the line?" logs are useless —
jambonz says "play started", the caller hears silence. This measures the wire.

    sudo tcpdump -i any -n -s 0 -w /tmp/call.pcap 'udp and portrange 10000-40000'
    python3 rtp_dbfs.py /tmp/call.pcap [--port 16096] [--min-db -60]

Output: one line per second and SSRC, plus a verdict. Reference values:
speech around -20 dBFS, silence/comfort noise below -50, music should sit
between -25 and -12.
"""
import argparse
import math
import struct
import sys

PCAP_MAGIC = {
    b"\xd4\xc3\xb2\xa1": ("<", 1e6),
    b"\xa1\xb2\xc3\xd4": (">", 1e6),
    b"\x4d\x3c\xb2\xa1": ("<", 1e9),
    b"\xa1\xb2\x3c\x4d": (">", 1e9),
}
LINK_ETHERNET, LINK_RAW, LINK_SLL, LINK_SLL2 = 1, 101, 113, 276


def ulaw_table():
    t = []
    for i in range(256):
        u = ~i & 0xFF
        sign = u & 0x80
        exp = (u >> 4) & 0x07
        mant = u & 0x0F
        sample = ((mant << 3) + 0x84) << exp
        sample -= 0x84
        t.append(-sample if sign else sample)
    return t


def alaw_table():
    t = []
    for i in range(256):
        a = i ^ 0x55
        sign = a & 0x80
        exp = (a >> 4) & 0x07
        mant = a & 0x0F
        sample = (mant << 4) + 8
        if exp:
            sample = (sample + 0x100) << (exp - 1)
        t.append(sample if sign else -sample)
    return t


ULAW, ALAW = ulaw_table(), alaw_table()


def read_pcap(path):
    with open(path, "rb") as f:
        head = f.read(24)
        if len(head) < 24 or head[:4] not in PCAP_MAGIC:
            sys.exit("not a pcap file (pcapng is not supported: use tcpdump -w, not -i any -w with pcapng)")
        endian, frac = PCAP_MAGIC[head[:4]]
        linktype = struct.unpack(endian + "I", head[20:24])[0]
        while True:
            rh = f.read(16)
            if len(rh) < 16:
                break
            ts_sec, ts_frac, incl, _orig = struct.unpack(endian + "IIII", rh)
            data = f.read(incl)
            if len(data) < incl:
                break
            yield linktype, ts_sec + ts_frac / frac, data


def ip_udp(data, linktype):
    """Return (src_port, dst_port, payload) or None."""
    if linktype == LINK_ETHERNET:
        if len(data) < 14:
            return None
        etype = struct.unpack(">H", data[12:14])[0]
        off = 14
        while etype in (0x8100, 0x88A8):
            etype = struct.unpack(">H", data[off + 2:off + 4])[0]
            off += 4
        if etype != 0x0800:
            return None
        ip = data[off:]
    elif linktype == LINK_SLL:
        if len(data) < 16 or struct.unpack(">H", data[14:16])[0] != 0x0800:
            return None
        ip = data[16:]
    elif linktype == LINK_SLL2:
        if len(data) < 20 or struct.unpack(">H", data[0:2])[0] != 0x0800:
            return None
        ip = data[20:]
    elif linktype == LINK_RAW:
        ip = data
    else:
        return None

    if len(ip) < 20 or (ip[0] >> 4) != 4:
        return None
    ihl = (ip[0] & 0x0F) * 4
    if ip[9] != 17 or len(ip) < ihl + 8:
        return None
    src, dst = struct.unpack(">HH", ip[ihl:ihl + 4])
    return src, dst, ip[ihl + 8:]


def rtp_streams(path, only_port=None):
    """ssrc -> {second: [rms values]}"""
    out = {}
    for linktype, ts, data in read_pcap(path):
        pkt = ip_udp(data, linktype)
        if not pkt:
            continue
        src, dst, payload = pkt
        if only_port and only_port not in (src, dst):
            continue
        if len(payload) < 12 or (payload[0] >> 6) != 2:
            continue
        pt = payload[1] & 0x7F
        if pt not in (0, 8):
            continue
        ssrc = struct.unpack(">I", payload[8:12])[0]
        rtp_ts = struct.unpack(">I", payload[4:8])[0]
        body = payload[12:]
        if payload[0] & 0x10 and len(body) >= 4:          # header extension
            ext_words = struct.unpack(">H", body[2:4])[0]
            body = body[4 + ext_words * 4:]
        if payload[0] & 0x20 and body:                     # padding
            body = body[:-body[-1]] if body[-1] else body
        if not body:
            continue
        table = ALAW if pt == 8 else ULAW
        samples = [table[b] for b in body]
        rms = math.sqrt(sum(s * s for s in samples) / len(samples)) or 1e-9
        db = 20 * math.log10(rms / 32768.0)
        sec = round(rtp_ts / 8000.0)
        out.setdefault((ssrc, pt), {}).setdefault(sec, []).append(db)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("pcap")
    ap.add_argument("--port", type=int, default=None, help="only packets to/from this UDP port")
    ap.add_argument("--min-db", type=float, default=-70.0, help="hide seconds quieter than this")
    a = ap.parse_args()

    streams = rtp_streams(a.pcap, a.port)
    if not streams:
        print("no G.711 RTP found (payload types 0/8). Wrong pcap, or the media is encrypted/transcoded.")
        return 1

    for (ssrc, pt), seconds in sorted(streams.items()):
        codec = "PCMA" if pt == 8 else "PCMU"
        print(f"\n== ssrc {ssrc:08x} {codec} ==")
        base = min(seconds)
        loud = 0
        for sec in sorted(seconds):
            vals = seconds[sec]
            avg = sum(vals) / len(vals)
            if avg < a.min_db:
                continue
            loud += 1
            print(f"  t+{sec - base:3d}s  {avg:7.1f} dBFS  ({len(vals)} pkt)")
        peak = max((max(v) for v in seconds.values()), default=-99)
        print(f"  seconds above {a.min_db:.0f} dB: {loud}   peak {peak:.1f} dBFS")
        print("  verdict:", "audio present" if peak > -30 else "effectively silent")
    return 0


if __name__ == "__main__":
    sys.exit(main())
