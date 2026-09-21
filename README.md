<img align="right" src="public/logo.png" alt="tinderjev logo" width="160" />

<h1>tinderjev</h1>

<p>
  <strong>Stockfish for texting. An iMessage UI with a live eval bar and AI-ranked next moves.</strong>
</p>
<p>
  Every message gets scored against your goal. When the other person texts, gpt-6-astra drafts three replies and Jev ranks them by how likely they are to move the conversation where you want it.
</p>

> [!WARNING]
> **This is AI-generated code.** The server, the UI, and this README were written by Claude Code in one sitting for a demo video. Nothing here has been reviewed for production use. Read it before you trust it, and don't point it at real people's conversations.

<p>
  <a href="#how-it-works">How it works</a> •
  <a href="#run-it">Run it</a> •
  <a href="#two-screens-one-conversation">Two screens</a> •
  <a href="#webhook">Webhook</a> •
  <a href="#what-jev-is-asked">What Jev is asked</a> •
  <a href="#tuning">Tuning</a>
</p>

tinderjev is a two-device demo: your Mac shows the Messages thread and the analysis panel, a phone plays the other person, and one server keeps them in sync. Two models split the work. **gpt-6-astra** only generates. **Jev** (TypeSafe's System One model) only judges, and answers with calibrated probabilities instead of prose. Every number on screen is a raw Jev answer, except the ranking chip, which blends three of them.

> _The name is what it sounds like. Tinder plus Jev._

## How it works

1. **They text you** from the phone page or the webhook.
2. **Jev scores the message** against the goal. The eval bar and the goal-odds chart move.
3. **Astra drafts three replies** if it's your turn. A burst of texts is bundled: the server waits 1.5 s for it to settle, then drafts once for all of them.
4. **Jev judges each candidate** independently, in parallel, and they're sorted.
5. **You pick one.** Clicking a candidate drops it into the composer. You send it yourself.

Nothing runs until a goal is set. Messages that arrive before that are stored and shown, but not scored.

## Run it

Node 20 or newer. No install step.

```sh
cp .env.example .env     # add your keys
npm start                # http://localhost:3000
```

| Variable | What |
| --- | --- |
| `OPENAI_API_KEY` | OpenAI key with access to `gpt-6-astra` |
| `TYPESAFE_API_KEY` | TypeSafe key for Jev |
| `OPENAI_MODEL` | Default `gpt-6-astra` |
| `JEV_MODEL` | Default `jev-latest` |
| `PORT` | Default `3000` |
| `DATA_FILE` | Optional. Where the conversation persists. Default `data/state.json` |

## Two screens, one conversation

The server holds a single conversation and pushes every change to all open pages over Server-Sent Events.

| URL | What it is |
| --- | --- |
| `http://localhost:3000` | **Your Mac.** Messages on the left, the analysis panel on the right. The composer is always *you*. |
| `http://<lan-ip>:3000/phone` | **The other person's phone.** A plain Messages thread. Anything typed there arrives as *them*. The LAN URL prints on startup. |

Both devices need the same Wi-Fi, or expose port 3000 with `ngrok http 3000` or Tailscale.

The right panel has four things:

- **Eval bar** on the far left edge. Jev's probability that the goal will be achieved, given the whole conversation.
- **Conversation goal.** Free text. Changing it re-scores the entire thread.
- **Top replies.** Astra's three drafts with Jev's numbers for each. Click one to use it.
- **Goal odds over time.** A line through the eval after every message. Blue points are yours, gray are theirs. Hover for Jev's verdict on that message.

## Webhook

Any device or script can inject a message. These are all equivalent:

```sh
curl "http://localhost:3000/hook?from=them&text=hey%20whats%20up"
curl -X POST http://localhost:3000/hook -d '{"from":"them","text":"hey whats up"}'
curl -X POST http://localhost:3000/api/message -d 'from=me&text=not much, you?'
```

`from` is `me` or `them` (default `them`). JSON, form-encoded, and query params all work.

**iOS Shortcut.** One "Get Contents of URL" action, POST to `http://<mac-ip>:3000/hook` with the JSON body `{"from": "them", "text": <Shortcut Input>}`. Share a text to it from Messages and it lands in the demo.

### All endpoints

| Method | Path | Does |
| --- | --- | --- |
| GET | `/api/state` | Full state as JSON |
| GET | `/api/events` | SSE stream of the state |
| GET | `/api/rubric` | The five effect levels Jev scores against |
| POST | `/hook`, `/api/message` | Add a message |
| POST | `/api/goal` | `{goal, contact}`. Re-scores the thread |
| POST | `/api/undo` | Remove the last message |
| POST | `/api/reset` | Clear the conversation, keep goal and contact |

## What Jev is asked

Jev takes structured state and typed questions, and returns probabilities. There is no prompt-and-parse step.

**After every message.** State is the goal, the contact's name, and the conversation up to and including that message. Messages are scored one at a time, in order, so a burst of fast texts still gets one verdict each.

| Question | Type | Meaning |
| --- | --- | --- |
| `effect` | Score, 5 levels | How did this message change the odds of the goal? Levels: Disaster, Hurts, Neutral, Helps, Big win. Returns a probability per level and a confidence. |
| `goal_prob` | Noul | Will *me* ultimately achieve the goal? 0 to 1. **This is the eval bar and the chart.** |

**For each candidate reply.** One request per candidate, run in parallel. State adds the candidate text.

| Question | Type | Meaning |
| --- | --- | --- |
| `effect` | Score, 5 levels | If *me* sends this next, how would it change the odds? |
| `positive_reply` | Noul | Will they respond warmly and keep talking? Shown as "warm reply". |
| `cringe` | Noul | Would this read as cringe, try-hard, or creepy? |

**Ranking chip** = 0.6 × (effect ÷ 4) + 0.3 × positive_reply + 0.1 × (1 − cringe). This blend is the only number on screen that isn't straight from Jev. The weights live in `rankCandidates` in `server.js` and changing them needs no re-inference.

## Tuning

- `BURST_QUIET_MS` in `server.js`. How long to wait after their last text before drafting.
- The Astra system prompt in `draftCandidates`. Sets the reply style (short, lowercase-friendly, one emoji max) and the strategy mix (playful, curious, goal-directed).
- `EFFECT_LEVELS`. The rubric Jev scores every message against.

## Layout

```
server.js          HTTP + SSE server, Jev and Astra calls, state machine
public/index.html  Mac view: Messages pane, goal, top replies, goal-odds chart
public/phone.html  The other person's phone
public/logo.png    App icon, cropped from tinderjev_logo.png
data/state.json    Persisted conversation (gitignored)
```

State survives restarts. Delete `data/state.json` or hit Reset to start over.

## Credits

Built with [TypeSafe](https://typesafe.ai) (Jev) and OpenAI. Send icon from [Ionicons](https://ionic.io/ionicons). Layout inspired by the "Social Stockfish" demo that went around Twitter.

## License

[MIT](LICENSE)
