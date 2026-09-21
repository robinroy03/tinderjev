// tinderjev — iMessage demo UI. Astra drafts, Jev judges. Every number shown comes straight from Jev.
// Astra (gpt-6-astra) drafts candidate replies, Jev (TypeSafe System One) scores
// every message and ranks the candidates. Zero dependencies; Node 20+.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TYPESAFE_API_KEY = process.env.TYPESAFE_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-6-astra";
const JEV_MODEL = process.env.JEV_MODEL || "jev-latest";
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data", "state.json");

if (!OPENAI_API_KEY || !TYPESAFE_API_KEY) {
  console.error("Missing OPENAI_API_KEY or TYPESAFE_API_KEY. Run with: npm start (loads .env)");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

function freshState() {
  return {
    contact: { name: "Sara", initials: "S" },
    goal: "", // nothing runs until the user sets one
    messages: [], // { id, from: "me"|"them", text, ts, effect, goalProbAfter }
    goalProb: 0.5, // Jev noul: will the goal be achieved?
    goalProbHistory: [], // one entry per scored message
    lastVerdict: null, // Jev's raw answer for the last message
    suggestions: [], // ranked candidates
    status: { phase: "idle", detail: "" }, // idle | scoring | drafting | ranking | error
    updatedAt: Date.now(),
  };
}

let state = loadState();

function loadState() {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    return { ...freshState(), ...JSON.parse(raw) };
  } catch {
    return freshState();
  }
}

function saveState() {
  state.updatedAt = Date.now();
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
}

// ---------------------------------------------------------------------------
// SSE broadcast
// ---------------------------------------------------------------------------

const clients = new Set();

function broadcast() {
  saveState();
  const payload = `data: ${JSON.stringify(state)}\n\n`;
  for (const res of clients) res.write(payload);
}

function setStatus(phase, detail = "") {
  state.status = { phase, detail };
  broadcast();
}

function isOurTurn() {
  const last = state.messages[state.messages.length - 1];
  return !!last && last.from === "them";
}

// ---------------------------------------------------------------------------
// Jev (TypeSafe System One)
// ---------------------------------------------------------------------------

const EFFECT_LEVELS = [
  "Disaster: cringe, creepy, rude, or clearly ends the conversation",
  "Hurts: awkward, needy, boring, or slightly pushes them away",
  "Neutral: keeps things going but does not move toward the goal",
  "Helps: builds rapport, momentum, or a step toward the goal",
  "Big win: strongly advances or effectively secures the goal",
];

async function jev(stateObj, questions) {
  const res = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TYPESAFE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: JEV_MODEL, state: stateObj, questions }),
  });
  if (!res.ok) throw new Error(`Jev ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.answers;
}

function convoForJev(upTo = state.messages.length) {
  return state.messages.slice(0, upTo).map((m) => ({
    from: m.from === "me" ? "me" : state.contact.name,
    text: m.text,
  }));
}

// Score the latest message: how did it change the odds of the goal?
async function scoreMessage(last) {
  const idx = state.messages.findIndex((m) => m.id === last.id);
  if (idx < 0) return; // undone before we got to it
  const answers = await jev(
    {
      goal: state.goal,
      other_person: state.contact.name,
      conversation: convoForJev(idx + 1),
      last_message: { from: last.from === "me" ? "me" : state.contact.name, text: last.text },
    },
    {
      effect: {
        type: "score",
        instructions:
          "`me` is texting `other_person` and wants to achieve `goal`. Considering the whole `conversation`, how did `last_message` change the odds that `me` achieves `goal`? If `last_message` is from `other_person`, judge what their reply reveals about how it is going for `me`.",
        criteria: EFFECT_LEVELS,
      },
      goal_prob: {
        type: "noul",
        instructions:
          "Based on `conversation` so far, will `me` ultimately achieve `goal` with `other_person`?",
        criteria: {
          true: "The conversation is on track; the goal is likely to happen",
          false: "The goal is unlikely; they are disengaged, put off, or it has been declined",
        },
      },
    }
  );
  const effect = answers.effect; // score 0..4 with per-level probabilities
  last.goalProbAfter = answers.goal_prob.noul;
  last.effect = { score: effect.score, confidence: effect.confidence, probabilities: effect.probabilities };
  if (idx === state.messages.length - 1) {
    state.goalProb = last.goalProbAfter;
    state.lastVerdict = { messageId: last.id, from: last.from, text: last.text, effect: last.effect, goalProb: state.goalProb };
  }
  state.goalProbHistory = state.messages.filter((m) => typeof m.goalProbAfter === "number").map((m) => m.goalProbAfter);
}

// Rank a candidate reply from `me`: one Jev request per candidate, in parallel.
async function rankCandidates(candidates) {
  const ranked = await Promise.all(
    candidates.map(async (text) => {
      const answers = await jev(
        {
          goal: state.goal,
          other_person: state.contact.name,
          conversation: convoForJev(),
          candidate_reply: text,
        },
        {
          effect: {
            type: "score",
            instructions:
              "`me` is texting `other_person` and wants to achieve `goal`. If `me` sends `candidate_reply` as the next message in `conversation`, how would it change the odds of achieving `goal`?",
            criteria: EFFECT_LEVELS,
          },
          positive_reply: {
            type: "noul",
            instructions:
              "If `me` sends `candidate_reply`, will `other_person` respond warmly and keep the conversation going?",
          },
          cringe: {
            type: "noul",
            instructions: "Would `candidate_reply` come across as cringe, try-hard, or creepy to `other_person`?",
          },
        }
      );
      const effect = answers.effect;
      const composite =
        0.6 * (effect.score / 4) + 0.3 * answers.positive_reply.noul + 0.1 * (1 - answers.cringe.noul);
      return {
        id: randomUUID(),
        text,
        effectScore: effect.score,
        confidence: effect.confidence,
        positiveReply: answers.positive_reply.noul,
        cringe: answers.cringe.noul,
        probabilities: effect.probabilities,
        composite,
      };
    })
  );
  ranked.sort((a, b) => b.composite - a.composite);
  return ranked;
}

// ---------------------------------------------------------------------------
// Astra (OpenAI gpt-6-astra)
// ---------------------------------------------------------------------------

async function draftCandidates() {
  const transcript = state.messages
    .map((m) => `${m.from === "me" ? "Me" : state.contact.name}: ${m.text}`)
    .join("\n");
  // everything they sent since Me last spoke: one reply must cover all of it
  let pending = [];
  for (let i = state.messages.length - 1; i >= 0 && state.messages[i].from === "them"; i--) pending.unshift(state.messages[i].text);
  const bundleNote = pending.length > 1
    ? `\n\n${state.contact.name} sent ${pending.length} messages in a row since Me last replied:\n${pending.map((t) => "- " + t).join("\n")}\nEach candidate must be ONE text that responds to all of them together (address what matters, skip filler).`
    : "";
  const body = {
    model: OPENAI_MODEL,
    input: [
      {
        role: "system",
        content:
          `You write text-message replies on behalf of "Me" in an iMessage conversation with ${state.contact.name}. ` +
          `Me's goal for this conversation: ${state.goal}\n` +
          `Write exactly 3 distinct candidate replies Me could send next. Each must sound like a real person texting: short (under 25 words), lowercase-friendly, natural, no hashtags, at most one emoji. ` +
          `Vary the strategies: one playful/teasing, one curious about them, one that makes a move toward the goal. Not every reply should push the goal in the same message; pacing matters. Never be creepy, needy, or pushy. ` +
          `Return JSON only: {"replies": ["...", "...", "..."]}`,
      },
      { role: "user", content: `Conversation so far:\n${transcript}${bundleNote}\n\nWrite the 3 candidate replies for Me.` },
    ],
    reasoning: { effort: "low" },
    text: { format: { type: "json_object" } },
  };
  console.log(`[astra] drafting 3 replies (${pending.length} unanswered from ${state.contact.name})`);
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data.output?.flatMap((o) => o.content || []).find((c) => c.type === "output_text")?.text;
  const parsed = JSON.parse(text || "{}");
  const replies = (parsed.replies || []).map((s) => String(s).trim()).filter(Boolean).slice(0, 3);
  if (replies.length === 0) throw new Error("Astra returned no replies");
  return replies;
}

// ---------------------------------------------------------------------------
// Pipeline (serialised so rapid messages don't race)
// ---------------------------------------------------------------------------

let chain = Promise.resolve();
let runId = 0;

function enqueue(fn) {
  chain = chain.then(fn).catch((err) => {
    console.error(err);
    setStatus("error", String(err.message || err).slice(0, 200));
  });
  return chain;
}

const BURST_QUIET_MS = 1500; // wait this long after their last text before drafting once for the whole burst
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const NO_GOAL = "Set a goal to start.";

async function afterMessage(msg) {
  const myRun = ++runId;
  state.suggestions = [];
  if (!state.goal) return setStatus("idle", NO_GOAL);
  setStatus("scoring", "Jev is scoring the last message…");
  await scoreMessage(msg);
  broadcast();
  if (myRun !== runId) return; // newer message already queued; its run takes over
  if (!isOurTurn()) return setStatus("idle", "Waiting for their reply…");
  // Let a burst of their texts finish before spending an Astra call.
  setStatus("scoring", "Waiting for the burst to settle…");
  const seen = state.messages.length;
  await sleep(BURST_QUIET_MS);
  if (state.messages.length !== seen || myRun !== runId) return; // more arrived; the last one will draft
  await generateSuggestions(myRun);
}

// Re-score everything in order (used when the goal changes).
async function rescoreAll() {
  const myRun = ++runId;
  state.suggestions = [];
  if (!state.goal) { state.lastVerdict = null; return setStatus("idle", NO_GOAL); }
  setStatus("scoring", "Jev is re-scoring the conversation…");
  for (const m of [...state.messages]) { await scoreMessage(m); broadcast(); if (myRun !== runId) return; }
  if (isOurTurn()) await generateSuggestions(myRun);
  else setStatus("idle", state.messages.length ? "Waiting for their reply…" : "");
}

async function generateSuggestions(myRun = ++runId) {
  if (!isOurTurn()) {
    setStatus("idle", "Not our turn — Astra only drafts when they've just texted.");
    return;
  }
  setStatus("drafting", "Astra is drafting 3 replies…");
  const candidates = await draftCandidates();
  if (myRun !== runId) return;
  state.suggestions = candidates.map((text) => ({ id: randomUUID(), text, pending: true }));
  setStatus("ranking", "Jev is ranking the candidates…");
  const ranked = await rankCandidates(candidates);
  if (myRun !== runId) return;
  state.suggestions = ranked;
  setStatus("idle", "Ranked. Pick a reply.");
}

function addMessage(from, text) {
  const msg = { id: randomUUID(), from, text: String(text).trim(), ts: Date.now() };
  if (!msg.text) return null;
  state.messages.push(msg);
  broadcast();
  enqueue(() => afterMessage(msg));
  return msg;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml" };

function send(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  const ct = req.headers["content-type"] || "";
  if (!raw) return {};
  if (ct.includes("application/json")) return JSON.parse(raw);
  if (ct.includes("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(raw));
  try { return JSON.parse(raw); } catch { return { text: raw }; }
}

function normaliseFrom(v) {
  const s = String(v || "them").toLowerCase();
  if (["me", "self", "user", "mine"].includes(s)) return "me";
  return "them";
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" });
    return res.end();
  }

  try {
    // --- live stream -------------------------------------------------------
    if (p === "/api/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "Access-Control-Allow-Origin": "*" });
      res.write(`data: ${JSON.stringify(state)}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(": ping\n\n"), 25000);
      req.on("close", () => { clearInterval(ping); clients.delete(res); });
      return;
    }

    if (p === "/api/state" && req.method === "GET") return send(res, 200, state);
    if (p === "/api/rubric" && req.method === "GET") return send(res, 200, { levels: EFFECT_LEVELS });

    // --- webhook: works with GET query params, JSON, or form bodies -------
    // e.g. curl "http://host:3000/hook?from=them&text=hey%20whats%20up"
    //      curl -X POST http://host:3000/hook -d '{"from":"me","text":"hi"}'
    if (p === "/hook" || p === "/api/webhook" || p === "/api/message") {
      const body = req.method === "GET" ? {} : await readBody(req);
      const from = normaliseFrom(body.from ?? url.searchParams.get("from"));
      const text = body.text ?? body.message ?? url.searchParams.get("text") ?? url.searchParams.get("message");
      const msg = addMessage(from, text ?? "");
      if (!msg) return send(res, 400, { ok: false, error: "text required" });
      return send(res, 200, { ok: true, message: msg, ourTurn: isOurTurn() });
    }

    if (p === "/api/goal" && (req.method === "POST" || req.method === "PUT")) {
      const body = await readBody(req);
      if (typeof body.goal === "string") state.goal = body.goal.trim();
      if (body.contact && typeof body.contact === "string") {
        const name = body.contact.trim() || "Sara";
        state.contact = { name, initials: name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase() };
      }
      broadcast();
      if (state.messages.length) enqueue(rescoreAll); // rescore with new goal
      else setStatus("idle", state.goal ? "" : NO_GOAL);
      return send(res, 200, { ok: true });
    }

    if (p === "/api/suggest" && req.method === "POST") {
      enqueue(() => generateSuggestions());
      return send(res, 200, { ok: true, ourTurn: isOurTurn() });
    }

    if (p === "/api/undo" && req.method === "POST") {
      runId++;
      state.messages.pop();
      state.goalProbHistory = state.goalProbHistory.slice(0, state.messages.length);
      const prev = state.messages[state.messages.length - 1];
      state.goalProb = prev && typeof prev.goalProbAfter === 'number' ? prev.goalProbAfter : 0.5;
      state.suggestions = [];
      state.lastVerdict = prev && prev.effect ? { messageId: prev.id, from: prev.from, text: prev.text, effect: prev.effect, goalProb: state.goalProb } : null;
      setStatus("idle", "Undid last message.");
      if (isOurTurn()) enqueue(() => generateSuggestions());
      return send(res, 200, { ok: true });
    }

    if (p === "/api/reset" && req.method === "POST") {
      runId++;
      const { goal, contact } = state;
      state = { ...freshState(), goal, contact };
      setStatus("idle", goal ? "Fresh conversation." : NO_GOAL);
      return send(res, 200, { ok: true });
    }

    // --- static ----------------------------------------------------------
    let file = p === "/" ? "/index.html" : p === "/phone" ? "/phone.html" : p;
    const full = path.join(__dirname, "public", path.normalize(file));
    if (!full.startsWith(path.join(__dirname, "public"))) return send(res, 403, { error: "nope" });
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      res.writeHead(200, { "Content-Type": MIME[path.extname(full)] || "application/octet-stream" });
      return fs.createReadStream(full).pipe(res);
    }
    send(res, 404, { error: "not found" });
  } catch (err) {
    console.error(err);
    send(res, 500, { ok: false, error: String(err.message || err) });
  }
});

function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === "IPv4" && !i.internal).map((i) => i.address);
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`\n  tinderjev running`);
  console.log(`  Mac:    http://localhost:${PORT}`);
  for (const ip of lanAddresses()) console.log(`  Phone:  http://${ip}:${PORT}/phone   (same Wi-Fi)`);
  console.log(`  Hook:   curl "http://localhost:${PORT}/hook?from=them&text=hey"\n`);
});
