# wa-agent

A personal WhatsApp agent that runs as a linked device on your own account. It:

1. **Auto-replies** to people while you're away, using an LLM with a persona you define.
2. **Captures your contacts' statuses** as they're posted, describes photos/videos with a vision model, and **recommends which ones to watch** when you ask ("anything about football?").
3. **Chats with you** in WhatsApp's "Message yourself" chat, with slash commands for control.

Node.js + [Baileys](https://github.com/WhiskeySockets/Baileys) (WhatsApp Web multi-device) + SQLite (built into Node) + Claude or Gemini.

> **Read this first.** Baileys is an unofficial library; running a bot on a personal account is against WhatsApp's terms and accounts do get banned, usually for spam-like behaviour. This bot only ever *replies*, rate-limits itself, and goes quiet when you reply manually, which keeps it far from that pattern — but the risk is yours. Use a spare SIM if you can.

## Requirements

- Node.js **20.12 or newer** (`node --version`). On Node 22.13+ the bot uses the built-in `node:sqlite`; on Node 20 it falls back to the `better-sqlite3` package, which `npm install` pulls in automatically (it needs a prebuilt binary or build tools — see Troubleshooting).
- An API key: Anthropic (`ANTHROPIC_API_KEY`) or Google Gemini (`GEMINI_API_KEY`).
- A phone with WhatsApp to link as a device.

## Setup

```bash
npm install
cp .env.example .env     # then edit: API key, OWNER_NAME, OWNER_NUMBER, PERSONA
npm run smoke            # offline test of the whole pipeline with a mock model
npm start
```

On first start a QR code prints in the terminal: on your phone go to **WhatsApp → Linked devices → Link a device** and scan it. Prefer a pairing code? Set `PAIRING_NUMBER=2547XXXXXXXX` in `.env` and the code prints instead. Credentials are saved in `auth/`, so later starts reconnect silently.

When you see `Connected to WhatsApp as …`, open WhatsApp, go to your own chat (search your own name, or the "You" contact) and send `/help`.

## Using it

**Talk to it in your own chat** ("Message yourself"). Anything without a slash is plain chat with the assistant.

| Command | What it does |
|---|---|
| `/statuses` | List statuses captured in the last 24h, newest first |
| `/recommend <mood or topic>` | Rank statuses worth watching, e.g. `/recommend football banter`, `/recommend business promos`, `/recommend anything funny` |
| `/pause` · `/resume` | Turn auto-reply off / on (persists across restarts) |
| `/persona <text>` | Change what the assistant may say about you, without touching `.env`; `/persona` shows it, `/persona clear` resets |
| `/status` | Connection, uptime, host, counts, model, settings |
| `/logs` | Recent warnings and errors |
| `/restart` | Restart the process (needs pm2/systemd/Docker to bring it back) |
| `/clear` | Forget the assistant's chat history with you |
| `/claim` | Pin the current chat as the one the bot answers you in |
| `/help` | The list |

You can also just ask in plain words — "any statuses worth watching about music?" is routed to the recommender.

**Auto-reply** triggers when someone else messages you. It:

- introduces itself as your assistant the first time, then answers from your `PERSONA` notes;
- replies in the language the person wrote in;
- never replies in groups unless `AUTO_REPLY_GROUPS=true` *and* you were @mentioned;
- stays quiet in a chat for `MANUAL_REPLY_COOLDOWN_MIN` minutes after you reply there from your phone;
- enforces a per-chat gap and a global hourly cap;
- honours `AUTO_REPLY_ALLOW` / `AUTO_REPLY_BLOCK` number lists.

**Status capture** happens passively. Every status a contact posts arrives as a message on the `status@broadcast` channel; the bot stores the text, downloads images for a one-line vision description, and uses the embedded thumbnail for videos. Statuses expire from the database after 24h, same as WhatsApp. `STATUS_AUTO_VIEW=false` by default, so posters don't see "viewed by you" for everything.

## How it's put together

```
src/
├── index.js            wires everything together, hourly pruning, shutdown
├── config.js           .env → typed config (no dotenv; Node's loadEnvFile)
├── whatsapp.js         Baileys connection, QR/pairing, reconnect, send/typing/download helpers
├── router.js           decides: status → capture | own chat → owner | manual reply → cooldown | else → auto-reply
├── handlers/
│   ├── autoReply.js    gates + LLM reply with per-chat history
│   ├── ownerChat.js    slash commands, natural-language status requests, plain chat
│   └── status.js       capture + describe, /statuses, /recommend ranking
├── llm/
│   ├── index.js        provider switch + message normalisation
│   ├── anthropic.js    Claude (messages.create, base64 image blocks)
│   ├── gemini.js       Gemini (@google/genai, inlineData parts)
│   └── mock.js         offline stand-in for tests
├── prompts.js          every prompt in one place — tune the bot's voice here
├── db.js               SQLite schema + queries (statuses, messages, contacts, settings)
└── utils.js            message unwrapping, jid helpers, timestamps
scripts/smoke.js        end-to-end test with a fake socket and the mock model
```

Only `whatsapp.js` imports Baileys. Everything else talks to a small `wa` object (`sendText`, `typing`, `markRead`, `downloadMedia`, `isSelfChat`), which is why the smoke test can run the real router and handlers offline.

Two things that matter in `router.js`:

- Only `messages.upsert` events of type `notify` are handled. `append` events are history sync and the bot's own sends, so this (plus the `sentIds` set) is what stops the bot replying to itself in your own chat.
- "Is this my own chat?" compares the number part of the JID with the account's phone number *and* its LID (WhatsApp's newer anonymous identifier). If the bot doesn't react to messages you send yourself, set `OWNER_NUMBER` in `.env`.

## Configuration

Everything is in `.env.example` with comments. The ones you'll actually touch:

| Variable | Meaning |
|---|---|
| `LLM_PROVIDER`, `LLM_MODEL` | `anthropic` (default `claude-sonnet-5-5`; `claude-haiku-5-5` is cheaper; needs API credits) or `gemini` (default `gemini-3.8-flash`; `gemini-3.5-flash-lite` is cheaper; has a free tier) |
| `OWNER_NAME`, `OWNER_NUMBER`, `PERSONA` | Who the assistant speaks for, and what it may say about you |
| `AUTO_REPLY_*` | Gates and rate limits described above |
| `STATUS_DESCRIBE_MEDIA` | Set `false` to skip vision calls (cheaper; text statuses still work) |
| `LOG_LEVEL` / `BAILEYS_LOG_LEVEL` | `debug` on the second one when diagnosing connection issues |

## Running it 24/7

The bot must stay running to auto-reply and to catch statuses, since statuses are only delivered while a device is online. **See [DEPLOY.md](DEPLOY.md)** for the full walkthrough: picking a host (a ~$5 VPS is the sweet spot), Node 22, pm2 (`pm2 start ecosystem.config.cjs`) or Docker, linking from the server, and controlling everything afterwards from WhatsApp with `/status`, `/pause`, `/persona`, `/logs` and `/restart`.

Your phone does not need to stay online; linked devices work independently once paired (WhatsApp requires the phone to check in at least once every 14 days).

## Troubleshooting

- **QR keeps refreshing / "connection closed" loop on first run** — scan faster (QRs rotate every ~20s), or use the pairing-code flow.
- **"Logged out" message** — WhatsApp unlinked the device (you removed it on the phone, or it was flagged). `npm run reset-auth` then `npm start` and link again.
- **Bot ignores my own messages** — every message the bot sees is logged as `"msg":"message"` with its `jid`, `fromMe` and `route`. If your self-chat message shows `route: "manual-reply"`, WhatsApp is identifying your own chat with an id the bot doesn't know (usually a `…@lid`): send `/claim` from your phone in that chat and it's pinned permanently. If no `message` line appears at all, the message never reached the bot — see the next two items.
- **`This API key is not scoped to a workspace`** — personal Anthropic keys (`sk-ant-usr-…`) created without a workspace need `ANTHROPIC_WORKSPACE_ID=wrkspc_…` in `.env` (Console → Workspaces).
- **`401 Invalid bearer token` / `authentication_error`** — the API key is wrong or has no credits. Anthropic keys come from platform.claude.com (format `sk-ant-api03-…`) and need billing set up; a claude.ai subscription is not an API key. Make sure `LLM_API_KEY` is empty unless you mean to override. Gemini keys come from aistudio.google.com and have a free tier.
- **`Bad MAC`, `No matching sessions found`, `Key used already or never filled`** in the first minutes after linking — libsignal re-syncing encryption keys with your phone; harmless once messages start decrypting. If they *keep* failing for every message, check (a) that only one bot process is running (`ps aux | grep '[s]rc/index.js'` — two processes sharing `auth/` corrupt each other's keys) and (b) which device the messages come from: the address `…@lid.0` is your phone, any other number is another linked device such as WhatsApp Web on a laptop. A session with one device can be permanently broken while the phone's is fine; the fix is a clean re-link: stop the bot, `npm run reset-auth`, log the bot out under Linked devices on the phone, `npm start`, scan again. (The `Session error:` / `Closing session: SessionEntry {…}` console spam from libsignal is filtered out unless `LOG_LEVEL=debug`.)
- **`error in handling message`** in the Baileys log right after linking — a message failed to decrypt. Common in the first minute after pairing while keys settle; the bot asks WhatsApp to resend. If it keeps happening for every message, `npm run reset-auth` and link again.
- **`Timed Out` / `error in sending keep alive` / `unexpected error in 'init queries'`** — the machine's connection to WhatsApp's servers is slow or being throttled. The bot keeps running, but if messages arrive late or not at all, try running it from a different network (home laptop vs. cloud box) to compare.
- **No statuses showing up** — they only arrive while the bot is connected; wait for contacts to post. `STATUS_CAPTURE` must be `true`. Run with `LOG_LEVEL=debug` to see them land.
- **`No such built-in module: node:sqlite`** — the code is current but Node is older than 22.13, so the bot needs the `better-sqlite3` fallback. Run `npm install` again (it's an optional dependency and installs on Node 20). If that fails to build, either install build tools (`sudo apt install build-essential python3`) or simply upgrade Node: `nvm install 22 && nvm use 22`.
- **`No SQLite driver available`** — same cause as above; follow the same fix.
- **Baileys breaking changes** — WhatsApp changes its protocol often; if the connection fails after an update, `npm update @whiskeysockets/baileys` and check the library's issues page.

## Ideas for the next version

- Full video understanding: download the status video and send it to Gemini (which accepts video inline) instead of the thumbnail.
- Voice notes: transcribe incoming audio before auto-replying, and transcribe audio statuses.
- Tools for the assistant: your calendar or a "where am I" note so replies are specific.
- A daily digest: schedule `/recommend` every evening and have the bot message you the picks.
- Per-contact personas (formal for lecturers, casual for friends).
