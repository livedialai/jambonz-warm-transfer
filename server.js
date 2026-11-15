/**
 * jambonz warm transfer — reference implementation
 *
 * An AI agent takes the call. When it decides a human is needed it hands the
 * caller over to a warm transfer: the caller hears hold music, the human gets a
 * spoken briefing and answers "yes" or "no" by voice. Yes -> both parties are
 * bridged. No (or no answer, busy, failure) -> the caller comes back to the
 * agent and the conversation continues.
 *
 * Why this repo exists: on jambonz a full warm transfer with a spoken decision
 * is ONE verb. The details that are not in the docs are written down in
 * README.md (moh/mediajam, confirm-session verbs, the return path).
 *
 * No dependencies, plain Node 18+ (global fetch), one HTTP server.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/* ------------------------------------------------------------------ config */

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return {}; }
}

const CFG = Object.assign(readJson(path.join(__dirname, "config.json")), {
  port: parseInt(process.env.PORT || "3021", 10),
});

const PORT = CFG.port;
/* Base URL under which jambonz can reach this app. The feature server calls
   confirmHook and the live-call API from the same machine, so loopback is
   fine for a single-box install; set public_base_url when it is not. */
const BASE = (CFG.public_base_url || `http://127.0.0.1:${PORT}`).replace(/\/$/, "");
/* jambonz feature server (live-call API), used to pull the caller back. */
const FS_URL = (CFG.feature_server?.url || "http://127.0.0.1:3000").replace(/\/$/, "");
const FS_KEY = CFG.feature_server?.key || process.env.JAMBONZ_API_KEY || "";
const HOST = CFG.host || "127.0.0.1";

const SYN = {
  vendor: CFG.voice?.tts_vendor || "inworld",
  label: CFG.voice?.tts_label || "Inworld",
  voice: CFG.voice?.tts_voice || "default",
  language: CFG.voice?.language || "en-US",
};
const STT = Object.assign(
  {
    vendor: CFG.voice?.stt_vendor || "deepgram",
    label: CFG.voice?.stt_label || "Deepgram",
    language: CFG.voice?.stt_language || "en",
  },
  CFG.voice?.stt_model ? { model: CFG.voice.stt_model } : {}
);

const P = Object.assign({
  hold: "One moment please, I am connecting you.",
  back: "No one is available right now. Let me help you myself — what can I do for you?",
  not_understood: "Sorry, I did not catch that.",
  unsure: "I am not sure about that one.",
  approve_question: "A caller is on the line: {brief}. Do you want to take the call?",
  approve_again: "Sorry? Do you want to take the call? Just say yes or no.",
  approve_bye: "Understood, I will let the caller know. Goodbye.",
  approve_unclear_bye: "I cannot hear you properly, I will let the caller know. Goodbye.",
  opener: "Hello! You are through to the service desk. How can I help you?",
}, CFG.phrases || {});

/* ------------------------------------------------------------------ helpers */

function json(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(b) });
  res.end(b);
}

function body(req) {
  return new Promise((ok) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => { try { ok(JSON.parse(d || "{}")); } catch { ok({}); } });
  });
}

const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();

/* jambonz reads "Word:" at the start of a text as a URL scheme and the say verb
   fails with `unknown scheme "word"`. Turn that colon into a dash. */
const saySafe = (t) => {
  const s = String(t || "").replace(/^\s*([\p{L}]{2,}):\s*/u, "$1 – ").trim();
  return s || "One moment please.";
};
const say = (text) => ({ verb: "say", text: saySafe(text), synthesizer: SYN });

const gather = (actionHook, extra) => Object.assign({
  verb: "gather",
  input: ["speech"],
  actionHook,
  timeout: parseInt(CFG.voice?.stt_timeout || 20, 10),
  recognizer: STT,
}, extra || {});

function transcript(ev) {
  return clean(ev?.speech?.alternatives?.[0]?.transcript || "");
}

/* ------------------------------------------------------- warm transfer core */

/* In-memory store for pending approvals: token -> { brief, caller, tries }.
   A restart loses pending approvals; keep it in Redis for production. */
const APPROVALS = new Map();

function newApproval(brief, callerSid) {
  const tok = crypto.randomBytes(6).toString("hex");
  APPROVALS.set(tok, { brief: clean(brief), caller: callerSid || "", tries: 0 });
  setTimeout(() => APPROVALS.delete(tok), 15 * 60 * 1000).unref?.();
  return tok;
}

/**
 * The transfer itself. `mode: "warm"` dials the human, parks the caller and
 * calls confirmHook on the human's leg — the human's answer decides whether the
 * two legs get bridged.
 */
function transferVerbs(brief, callerSid) {
  const t = CFG.transfer || {};
  const num = String(t.number || "").replace(/^\+/, "");
  const tok = newApproval(brief, callerSid);

  const transfer = {
    verb: "transfer",
    mode: "warm",
    /* callerPresent:false -> the caller does NOT hear the briefing */
    callerPresent: false,
    actionHook: "/transfer-return",
    target: [{
      type: "sip",
      sipUri: `sip:${num}@${t.sip_host}`,
      auth: t.sip_user ? { username: t.sip_user, password: t.sip_pass } : undefined,
      confirmHook: { url: `${BASE}/approve?t=${tok}`, method: "POST" },
    }],
    callerId: t.caller_id,
    timeout: parseInt(t.timeout || 35, 10),
    /* Every failure mode sends the caller back into this app. */
    disposition: { onDecline: "return", onNoAnswer: "return", onBusy: "return", onFailure: "return" },
  };

  /* Hold music comes from the config verb, NOT from an onHoldHook.
     See README "Music on hold" — this is the one that costs hours. */
  const cfg = { verb: "config", onHoldMusic: CFG.hold_music_url || `${BASE}/hold.wav` };

  return [cfg, say(P.hold), transfer];
}

/* Question to the human. Speech only — no keypad. */
function approvalQuestion(tok) {
  const a = APPROVALS.get(tok) || { brief: "", tries: 0 };
  const text = a.tries === 0
    ? P.approve_question.replace("{brief}", a.brief || "they need help with something")
    : P.approve_again;
  return [gather(`/approve-answer?t=${tok}`, {
    timeout: 8,
    speechTimeout: 4,
    say: { text, synthesizer: SYN },
  })];
}

const YES = /^(yes|yeah|yep|yup|sure|ok|okay|of course|go ahead|take it|put (them|him|her) through|connect|fine|correct|right)\b/i;
const NO = /^(no|nope|nah|not now|no thanks|no thank you|later|busy|cannot|can't|leave it|don't)\b/i;

function approvalAnswer(tok, ev) {
  const a = APPROVALS.get(tok) || { brief: "", tries: 0, caller: "" };
  const tr = transcript(ev);

  if (YES.test(tr)) {
    APPROVALS.delete(tok);
    /* Empty response: the app ends while the call is up -> jambonz takes that
       as "accept" and bridges the two legs. */
    return { decision: "yes", verbs: [] };
  }

  if (NO.test(tr)) {
    APPROVALS.delete(tok);
    /* A confirm hook may only run config/gather/play(s)/say/tag.
       A hangup gets stripped, the app stays up and jambonz bridges anyway.
       So: say goodbye, keep the app open with a dummy gather (no accept, no
       bridge) and pull the caller back through the live-call API, which kills
       the transfer task and with it the human's leg. */
    callerBack(a.caller, 5200);
    return { decision: "no", verbs: [keepAlive(`/approve-end?t=${tok}`, P.approve_bye)] };
  }

  if (a.tries < 1) {
    a.tries += 1;
    APPROVALS.set(tok, a);
    return { decision: "unclear", verbs: approvalQuestion(tok) };
  }

  APPROVALS.delete(tok);
  callerBack(a.caller, 5200);
  return { decision: "unclear-end", verbs: [keepAlive(`/approve-end?t=${tok}`, P.approve_unclear_bye)] };
}

/* Keeps the confirm session open without accepting: digits input, 20 s. */
function keepAlive(actionHook, text) {
  return { verb: "gather", input: ["digits"], numDigits: 1, timeout: 20, actionHook, say: { text, synthesizer: SYN } };
}

/**
 * Pull the caller out of the running transfer. The new call_hook replaces the
 * running app, which terminates the transfer task — and the human's leg with it.
 * There is no verb for this inside a confirm hook, hence the live-call API.
 */
function callerBack(callSid, delayMs) {
  if (!callSid || !FS_KEY) return;
  setTimeout(() => {
    const payload = JSON.stringify({ call_hook: { url: `${BASE}/action?event=transfer-cancel`, method: "POST" } });
    const rq = http.request({
      host: new URL(FS_URL).hostname,
      port: new URL(FS_URL).port || 80,
      path: `/v1/updateCall/${callSid}`,
      method: "POST",
      headers: {
        Authorization: `Bearer ${FS_KEY}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
    }, (r) => { r.resume(); console.log(`[callerBack] ${callSid} http=${r.statusCode}`); });
    rq.on("error", (e) => console.error(`[callerBack] ${callSid} ${e.message}`));
    rq.write(payload);
    rq.end();
  }, delayMs).unref?.();
}

/* ---------------------------------------------------------------- the agent */

const TRANSFER_TOOL = {
  type: "function",
  function: {
    name: "transfer_to_human",
    description:
      "Hands the running call to a human. The caller hears hold music, the human gets a short briefing and decides by voice whether to take the call. " +
      "If they say yes, both are connected. If they say no, do not answer or are busy, the caller comes back to you and you keep helping. " +
      "Call it when: the caller explicitly asks for a human, supervisor or manager; they want to complain about an order, delivery or invoice; " +
      "or you could not help after two attempts and they are unhappy. Do NOT call it for anything you can answer yourself.",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description:
            "One or two sentences for the human's briefing: what the caller wants, what happened, order number if any. " +
            "No greeting, no filler, no trailing period. Empty string if the caller only asked for a human and said nothing else.",
        },
      },
      required: ["reason"],
    },
  },
};

async function llmReply(messages) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 9000);
  try {
    const r = await fetch(`${String(CFG.llm.base).replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${CFG.llm.key}` },
      body: JSON.stringify({
        model: CFG.llm.model,
        messages,
        temperature: 0.4,
        max_tokens: 250,
        tools: [TRANSFER_TOOL],
        tool_choice: "auto",
        reasoning_effort: CFG.llm.reasoning || "none",
      }),
      signal: ctrl.signal,
    });
    const d = await r.json();
    const m = d?.choices?.[0]?.message || {};
    return { text: clean(m.content || ""), toolCalls: Array.isArray(m.tool_calls) ? m.tool_calls : [] };
  } catch (e) {
    console.error(`[llm] ${e.message}`);
    return { text: "", toolCalls: [] };
  } finally {
    clearTimeout(timer);
  }
}

/* Runs without any API key: keyword demo so the transfer can be tested on a
   bare box. Set llm.base/llm.key/llm.model in config.json to use a real model. */
function demoReply(text) {
  if (/\b(human|person|someone|somebody|manager|supervisor|agent|representative|real person|speak to|talk to)\b/i.test(text)) {
    return { text: "", transfer: clean(text) };
  }
  return { text: "I can help with that. Could you tell me a little more?", transfer: null };
}

async function agentTurn(text, history) {
  if (CFG.llm?.base && CFG.llm?.key && CFG.llm?.model) {
    const sys = `${CFG.agent?.prompt || "You are a friendly phone agent. Answer in one or two short sentences."} ` +
      `Never mention that you are an AI unless asked. Ask at most one question per turn. ` +
      `The only tool you have is transfer_to_human.`;
    const messages = [{ role: "system", content: sys }, ...history.slice(-20), { role: "user", content: text }];
    const r = await llmReply(messages);
    const call = (r.toolCalls || []).find((c) => c?.function?.name === "transfer_to_human");
    if (call) {
      let args = {};
      try { args = JSON.parse(call.function.arguments || "{}"); } catch {}
      return { text: "", transfer: clean(args.reason || "") };
    }
    return { text: r.text || P.unsure, transfer: null };
  }
  return demoReply(text);
}

/* ------------------------------------------------------------------ routes */

const SESSIONS = new Map();   // callSid -> { history: [] }  (in-memory, demo only)

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const p = u.pathname.replace(/\/+$/, "") || "/";

  try {
    if (p === "/health") return json(res, 200, { status: "ok", time: new Date().toISOString() });

    /* Entry point: opener + listen. Use a pre-recorded opener for zero latency. */
    if (p === "/") {
      const wav = path.join(__dirname, "opener.wav");
      if (fs.existsSync(wav)) return json(res, 200, [{ verb: "play", url: `${BASE}/opener.wav` }, gather("/action")]);
      return json(res, 200, [say(P.opener), gather("/action")]);
    }

    for (const name of ["opener.wav", "hold.wav"]) {
      if (p === `/${name}`) {
        try {
          const f = path.join(__dirname, name);
          const st = fs.statSync(f);
          res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": st.size, "Accept-Ranges": "none" });
          return fs.createReadStream(f).pipe(res);
        } catch { return json(res, 404, { error: `${name} not found` }); }
      }
    }

    /* Legacy hook: some builds still call onHoldHook in a loop while parked.
       Harmless to keep, but MOH comes from the config verb (see README). */
    if (p === "/transfer-hold") return json(res, 200, [{ verb: "play", url: `${BASE}/hold.wav` }]);

    /* actionHook of the transfer verb. */
    if (p === "/transfer-return") {
      const b = await body(req);
      const result = String(b.transfer_result || "");
      console.log(`[transfer-return] ${b.call_sid || "?"} result=${result} reason=${b.transfer_reason || ""}`);
      if (result === "bridged") return json(res, 200, []);   // keep the bridge
      return json(res, 200, [say(P.back), gather("/action")]);
    }

    if (p === "/action") {
      const b = await body(req);
      const sid = b.call_sid || b.callSid || "";

      /* Landed here because callerBack() rewired the call: the human said no. */
      if (u.searchParams.get("event") === "transfer-cancel") {
        const st = SESSIONS.get(sid) || { history: [] };
        st.history.push({ role: "assistant", content: "[HUMAN DECLINED]" });
        SESSIONS.set(sid, st);
        return json(res, 200, [say(P.back), gather("/action")]);
      }

      const text = transcript(b);
      const st = SESSIONS.get(sid) || { history: [] };
      if (!text) return json(res, 200, [say(P.not_understood), gather("/action")]);

      const turn = await agentTurn(text, st.history);

      if (turn.transfer !== null) {
        const brief = turn.transfer ? `A caller on the phone: ${turn.transfer}` : "A caller asks to speak to a human";
        st.history.push({ role: "user", content: text }, { role: "assistant", content: "[TRANSFER]" });
        SESSIONS.set(sid, st);
        return json(res, 200, transferVerbs(brief, sid));
      }

      st.history.push({ role: "user", content: text }, { role: "assistant", content: turn.text });
      st.history = st.history.slice(-40);
      SESSIONS.set(sid, st);
      return json(res, 200, [say(turn.text), gather("/action")]);
    }

    /* Human side: briefing question and spoken decision. */
    if (p === "/approve") {
      const b = await body(req);
      const tok = String(u.searchParams.get("t") || b.t || "");
      console.log(`[approve] ${b.call_sid || "?"} token=${tok} known=${APPROVALS.has(tok)}`);
      return json(res, 200, approvalQuestion(tok));
    }

    if (p === "/approve-answer") {
      const b = await body(req);
      const tok = String(u.searchParams.get("t") || b.t || "");
      const r = approvalAnswer(tok, b);
      console.log(`[approve-answer] ${b.call_sid || "?"} "${transcript(b)}" -> ${r.decision}`);
      return json(res, 200, r.verbs);
    }

    if (p === "/approve-end") {
      await body(req).catch(() => ({}));
      return json(res, 200, []);   // leg is being torn down anyway
    }

    return json(res, 404, { error: "unknown path", path: p });
  } catch (e) {
    console.error(`[error] ${e.stack || e.message}`);
    return json(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, HOST, () => console.log(`jambonz warm transfer on http://${HOST}:${PORT}`));
