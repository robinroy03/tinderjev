# tinderjev

> **🤖 AI-generated code.** Everything in this repo (server, UI, this README) was written by
> Claude Code in one sitting for a demo video. It has not been reviewed for production use.
> Read it before you trust it, and don't point it at real people's conversations.

**Stockfish for texting.** An iMessage-style UI where every message gets a live
"goal probability" eval bar, and each time the other person texts you, an AI drafts
three replies and ranks them by how likely they are to move the conversation toward
your goal.

<p align="center"><img src="public/logo.png" width="96" alt="tinderjev logo" /></p>

Two models do the work:

| Model | Role |
|---|---|
| **gpt-6-astra** (OpenAI) | Drafts 3 candidate replies. Generation only. |
| **Jev** (TypeSafe System One) | Judges. Scores every message and ranks the candidates. Returns calibrated probabilities, not prose. |

Every number on screen is a raw Jev answer, except the blue ranking chip, which is a
weighted blend of three Jev answers (see [How scoring works](#how-scoring-works)).

## Run it

Node 20+ and no dependencies.

```sh
cp .env.example .env     # add your keys
npm start                # http://localhost:3000
```

`.env`:

```
OPENAI_API_KEY=sk-...
TYPESAFE_API_KEY=apikey_...
OPENAI_MODEL=gpt-6-astra
JEV_MODEL=jev-latest
PORT=3000
```

Nothing runs until you type a goal into **Conversation goal**. Messages arriving before
that are stored and shown but not scored.

## Two screens, one conversation

The server holds a single shared conversation and pushes every change to all open
pages over Server-Sent Events, so you can drive the demo from two devices.

| URL | What it is |
|---|---|
| `http://localhost:3000` | **Your Mac.** Messages on the left, the analysis panel on the right. The composer is always *you*. |
| `http://<lan-ip>:3000/phone` | **The other person's phone.** A plain Messages thread. Anything typed there arrives as *them*. The LAN URL is printed on startup. |

Both devices must be on the same Wi-Fi, or expose port 3000 with `ngrok http 3000` or Tailscale.

### The loop

1. They text you (from the phone page or the webhook).
2. Jev scores the message against the goal. The eval bar and the chart update.
3. If it's your turn, Astra drafts 3 replies. If they sent a burst of texts, the server
   waits 1.5 s for it to settle, then drafts once for the whole bundle.
4. Jev judges each candidate independently, in parallel, and they're sorted.
5. Click a candidate to drop it into the composer. You send it yourself.

## Webhook

Any device or script can inject a message. All of these are equivalent:

```sh
curl "http://localhost:3000/hook?from=them&text=hey%20whats%20up"
curl -X POST http://localhost:3000/hook -d '{"from":"them","text":"hey whats up"}'
curl -X POST http://localhost:3000/api/message -d 'from=me&text=not much, you?'
```

`from` is `me` or `them` (default `them`). JSON, form-encoded, and query params all work.

**iOS Shortcut:** one "Get Contents of URL" action, POST to `http://<mac-ip>:3000/hook`
with a JSON body `{"from": "them", "text": <Shortcut Input>}`. Share a text to it from
Messages and it lands in the demo.

### Other endpoints

| Method | Path | Does |
|---|---|---|
| GET | `/api/state` | Full state as JSON |
| GET | `/api/events` | SSE stream of the state |
| GET | `/api/rubric` | The five effect levels Jev scores against |
| POST | `/api/goal` | `{goal, contact}`. Changing the goal re-scores the whole thread. |
| POST | `/api/undo` | Remove the last message |
| POST | `/api/reset` | Clear the conversation, keep goal and contact |

## How scoring works

Jev is asked typed questions over structured state and answers with probabilities.
No prompt-and-parse.

**After every message.** State is the goal, the contact's name, and the conversation
up to and including that message.

| Question | Type | Meaning |
|---|---|---|
| `effect` | Score, 5 levels | How did this message change the odds of the goal? Levels: Disaster, Hurts, Neutral, Helps, Big win. Returns a probability per level and a confidence. |
| `goal_prob` | Noul | Will *me* ultimately achieve the goal? 0 to 1. **This is the eval bar and the chart.** |

**For each candidate reply.** One request per candidate, run in parallel. State adds
the candidate text.

| Question | Type | Meaning |
|---|---|---|
| `effect` | Score, 5 levels | If *me* sends this next, how would it change the odds? |
| `positive_reply` | Noul | Will they respond warmly and keep talking? Shown as "warm reply". |
| `cringe` | Noul | Would this read as cringe, try-hard, or creepy? |

**Ranking chip** = 0.6 × (effect ÷ 4) + 0.3 × positive_reply + 0.1 × (1 − cringe).
That blend is the only number that isn't straight from Jev. Change the weights in
`rankCandidates` in `server.js`; no re-inference needed.

Messages are scored one at a time in order, each with only the conversation up to
that point, so a burst of fast texts still gets one verdict per message.

## Layout

```
server.js          HTTP + SSE server, Jev and Astra calls, state machine
public/index.html  Mac view: Messages pane, goal, top replies, goal-odds chart
public/phone.html  The other person's phone
public/logo.png    App icon (cropped from tinderjev_logo.png)
data/state.json    Persisted conversation (gitignored)
```

State survives restarts. Delete `data/state.json` or hit Reset to start over.

## Tuning

- `BURST_QUIET_MS` in `server.js`: how long to wait after their last text before drafting.
- The Astra system prompt in `draftCandidates` sets the reply style (short, lowercase-friendly,
  one emoji max) and the strategy mix (playful, curious, goal-directed).
- `EFFECT_LEVELS` is the rubric Jev scores every message against.

## Credits

Built with [TypeSafe](https://typesafe.ai) (Jev) and OpenAI. Send icon from
[Ionicons](https://ionic.io/ionicons). UI layout inspired by the "Social Stockfish" demo
that went around Twitter.
