# jambonz warm transfer — with a spoken yes/no by the human

A working reference for the transfer pattern that voice platforms keep getting
half-right: an AI agent takes the call, decides a human is needed, parks the
caller, briefs the human **by voice**, waits for a **spoken yes or no**, and — if
the answer is no — gives the caller back to the agent without dropping them.

On jambonz this is one verb:

```js
{
  verb: "transfer",
  mode: "warm",
  callerPresent: false,                       // caller does not hear the briefing
  target: [{
    type: "sip",
    sipUri: "sip:+15551234567@sip.carrier.example:5060",
    confirmHook: { url: "https://your-host/approve?t=<token>", method: "POST" }
  }],
  actionHook: "/transfer-return",
  disposition: { onDecline: "return", onNoAnswer: "return", onBusy: "return", onFailure: "return" }
}
```

Everything else in this repo is the part that is *not* in the docs.

## Flow

```
caller ──say/gather──► agent (LLM, tool: transfer_to_human)
                          │
                          ├─ config(onHoldMusic) + say("one moment") + transfer(mode:"warm")
                          │        caller is parked and hears hold music
                          │        human hears: "A caller is on the line: <brief>.
                          │                      Do you want to take the call?"
                          │
                  ┌───────┴────────────────────────┐
               "yes"                    "no" / unclear / no answer / busy
                  │                                │
        app ends → accept                 disposition: return
                  │                    (+ live-call API while parked)
        both legs bridged                caller is back with the agent,
                                         conversation continues
```

## The three things that cost the evening

**1. Hold music comes from the `config` verb, not from an `onHoldHook`.**
A `play` inside the hold hook runs and completes in the logs, and the caller
hears nothing. On this build (mediajam) the parked caller gets audio only from
the endpoint option `holdMusic`, which jambonz sets from
`{verb:"config", onHoldMusic:"..."}`. See [Music on hold](#music-on-hold).

**2. A confirm hook may only run `config`, `gather`, `play(s)`, `say`, `tag`.**
`hangup` is silently stripped (`removing verbs that are not allowed for
confirmSession call`), the app stays up, jambonz reads the still-connected leg as
*accept* and bridges the caller to a human who just said no. The way out:
answer with an empty verb list for *yes* (that is the accept), and for *no* say
goodbye inside a dummy `gather`, then pull the caller back through the live-call
API — see [Pull the caller back](#pull-the-caller-back).

**3. `callerPresent:false` is what makes it a briefing.**
With `callerPresent:true` the caller hears the human before the decision. Warm
transfer without it is a conference with extra steps.

## Requirements

- jambonz (self-hosted or cloud) with an application whose `call_hook` points at
  this worker, and `transfer` enabled on the account
- Node.js 18+ (no dependencies — plain `http` + global `fetch`)
- a SIP target for the human (number + trunk credentials)
- hold music reachable over **public http(s)** — mediajam fetches, loops and
  transcodes it
- optionally an OpenAI-compatible LLM endpoint (without one the worker runs a
  keyword demo so the transfer can be tested immediately)

## Setup

```bash
git clone <this repo> && cd jambonz-warm-transfer
cp config.example.json config.json     # fill in your trunk, keys, names
node --check server.js && node server.js
```

Point the jambonz application at `http://<host>:3021/` (the `/` route answers the
opening). For systemd, copy `deploy/jambonz-warm-transfer.service` to
`/etc/systemd/system/`, adjust `WorkingDirectory`, then
`systemctl enable --now jambonz-warm-transfer`.

`config.json` is git-ignored on purpose. No secret ever belongs in this repo.

### Routes

| Route | Called by | Purpose |
|---|---|---|
| `/` | app `call_hook` | opener (`opener.wav` if present) + `gather` |
| `/action` | `gather` / `actionHook` | agent turn; on tool call → transfer verbs |
| `/transfer-return` | `transfer.actionHook` | `bridged` → empty answer; otherwise back to the agent |
| `/approve` | `target.confirmHook` | the briefing question (`gather`, speech) |
| `/approve-answer` | `gather` on the human's leg | spoken yes/no → accept or decline |
| `/approve-end` | keep-alive gather | keep the confirm session open while the caller is pulled back |
| `/hold.wav`, `/opener.wav` | jambonz | audio files, if you keep them next to `server.js` |

### Config

| Key | Meaning |
|---|---|
| `public_base_url` | how jambonz reaches this worker (used for `confirmHook`) |
| `transfer.number`, `transfer.sip_host`, `transfer.sip_user`, `transfer.sip_pass`, `transfer.caller_id` | the human's leg |
| `transfer.timeout` | ring time in seconds before `disposition` fires (35 is sane) |
| `hold_music_url` | **public** http(s) URL of the hold track |
| `feature_server.url`, `feature_server.key` | for `/v1/updateCall` — required for the decline path |
| `voice.*` | STT/TTS vendor, language, voice |
| `llm.base`, `llm.key`, `llm.model` | optional OpenAI-compatible endpoint |
| `agent.prompt` | the agent's system prompt |
| `phrases.*` | spoken texts (English defaults) |

## Music on hold

Three separate traps, all of them silent failures:

1. **`shout://` vs mediajam.** FreeSWITCH wants `shout://host/path`, and jambonz
   hard-codes that rewrite for `onHoldMusic`. mediajam — the Go media engine used
   by newer installs — only knows `http`/`https` and rejects everything else:

   ```
   {"cmd":"play.start","callSid":"…","code":"bad_request",
    "err":"unknown scheme \"shout\""}
   ```

   The play task reports success, the caller hears silence.
   `tools/patch_holdmusic.py` keeps the URL as configured in
   `lib/tasks/transfer/warm-parked.js` and `lib/utils/media-endpoint.js`
   (backups + `node --check` included), then restart the feature server:

   ```bash
   sudo python3 tools/patch_holdmusic.py --root /opt/jambonz/feature-server
   sudo systemctl restart jambonz-feature-server
   ```

2. **The URL must be publicly reachable.** `http://127.0.0.1:3021/hold.wav` is
   fine for the worker's own `play` verbs, but hold music is fetched by the media
   engine — put the file behind a real host:

   ```bash
   curl -sI https://your-host/moh/hold.wav   # expect 200 + audio/wav
   ```

3. **Level.** A track that measures −55 dBFS on the wire is silence with extra
   steps. Aim for a mean around −16 dBFS, peak −3 … −1 dBFS, 8 kHz mono PCM:

   ```bash
   ffmpeg -i track.wav -af "volume=8dB,alimiter=limit=0.85" -ac 1 -ar 8000 -c:a pcm_s16le hold.wav
   ```

Do not ship a stock track you did not license. `tools/make_hold_music.py` writes a
royalty-free loop that ends on a zero crossing, so looping is seamless:

```bash
python3 tools/make_hold_music.py hold.wav --seconds 9.6 --peak-db -3
```

## Pull the caller back

There is no verb for "abort this transfer" inside a confirm hook. What works:

```js
POST http://<feature-server>:3000/v1/updateCall/<caller_sid>
Authorization: Bearer <api key>
{"call_hook": {"url": "https://your-host/action?event=transfer-cancel", "method": "POST"}}
```

The new `call_hook` replaces the running app, which terminates the transfer task —
and with it the human's leg. Delay it ~5 s so the human's goodbye is not cut off.
```js
callerBack(callerSid, 5200);
```

## Verify it on the wire, not in the logs

Logs lie about hold music. Capture and measure:

```bash
sudo tcpdump -i any -n -s 0 -w /tmp/call.pcap 'udp and portrange 10000-40000'
python3 tools/rtp_dbfs.py /tmp/call.pcap --min-db -60
python3 tools/extract_rtp_wav.py /tmp/call.pcap hold.wav --port 16096 \
        --from 1794724053 --to 1794724060
ffmpeg -i hold.wav -filter_complex showspectrumpic=s=900x420 spec.png
```

Reference values from a working call (G.711, caller side):

| Phase | dBFS |
|---|---|
| agent speaking | −20 … −16 |
| hold music | −20 … −12 |
| silence / comfort noise | below −50 |
| broken MOH | −55 (a faint tone, inaudible) |

`rtp_dbfs.py` handles Ethernet, Linux SLL and SLL2 captures (`tcpdump -i any`
writes SLL2 — a parser that only knows Ethernet finds "no packets" and you chase
the wrong bug).

## Why the human decides by voice

DTMF gates ("press 1 to accept") are the reason warm transfers feel like IVR.
The briefing already told the human what the call is about; asking "do you want
to take the call?" in the same breath is one turn, not a menu. The code asks
once, re-asks once, and treats anything unclear as *no* — never as *yes*, because
a wrong *yes* connects a caller to someone who did not agree.

## Scope

Reference implementation, not a product: pending approvals and conversation
history live in `Map` objects (restart = lost), one human per transfer, no queue,
no recording, no auth on the webhook. For production put the state in Redis and
verify the jambonz signature/JWT on every hook.

## License

MIT — see [LICENSE](LICENSE).
