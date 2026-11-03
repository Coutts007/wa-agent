# Deploying wa-agent so it runs without your laptop

The bot needs one machine that stays on and online. Your phone can be off; WhatsApp keeps a linked device alive for up to 14 days without the phone checking in, and opening WhatsApp on the phone resets that clock. Everything after setup is controlled from your own WhatsApp chat.

## Pick a host

| Option | Cost | Notes |
|---|---|---|
| **Small VPS** (Hetzner, DigitalOcean, Contabo, Linode…) | ~$4–6/month | Recommended. Always on, good connection to WhatsApp's servers, nothing to maintain at home. Pick Ubuntu 24.04, smallest size, any European region. |
| Oracle Cloud "Always Free" VM | $0 | Same steps as a VPS; signup can be fiddly and capacity is sometimes unavailable. |
| Old laptop / Raspberry Pi at home | $0 + electricity | Works, but power or internet cuts take the bot down with them. |

The steps below assume a fresh Ubuntu VPS you can SSH into as a user with sudo. Adapt paths for a Pi.

## 1. Node 22 on the server

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc
nvm install 22
node --version     # v22.x — built-in sqlite, no native build needed
```

## 2. Get the code there

Either copy from the machine you've been developing on (run this *on that machine*):

```bash
rsync -av --exclude node_modules --exclude auth --exclude data --exclude .env \
  ~/codenv/wa-agent/ user@your-server:~/wa-agent/
```

or push the project to a private GitHub repo and `git clone` it on the server. `.gitignore` already excludes `.env`, `auth/` and `data/`, so none of your secrets or session go into git.

Then on the server:

```bash
cd ~/wa-agent
npm install
nano .env          # paste your .env contents: API key, OWNER_NAME, OWNER_NUMBER, PERSONA…
chmod 600 .env
npm run smoke      # should print "sqlite driver: node:sqlite" and "All smoke checks passed"
```

## 3. Link WhatsApp from the server

Do a **fresh** link on the server rather than copying `auth/` from your laptop: two machines sharing one session corrupt each other's keys.

1. On your phone: WhatsApp → Linked devices → log out the old "WA-Agent" device.
2. On the server: `npm start`, scan the QR in the SSH terminal (or set `PAIRING_NUMBER` in `.env` for a code instead).
3. When you see `Connected to WhatsApp as …`, send `/status` to yourself. Then Ctrl+C.

## 4. Run it under pm2

pm2 keeps the process alive, restarts it on crashes and after reboots, and is what makes the `/restart` command work.

```bash
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup          # prints one sudo command — copy and run it
pm2 install pm2-logrotate
```

Useful afterwards:

```bash
pm2 status            # is it running?
pm2 logs wa-agent     # follow logs (Ctrl+C to stop following)
pm2 restart wa-agent  # after editing .env or the code
```

Log out of SSH. The bot keeps running.

### Docker instead of pm2

```bash
docker build -t wa-agent .
docker run -d --name wa-agent --restart unless-stopped --env-file .env \
  -v $(pwd)/auth:/app/auth -v $(pwd)/data:/app/data wa-agent
docker logs -f wa-agent     # scan the QR here on first run
```

`--restart unless-stopped` provides the same auto-restart as pm2.

## 5. Day-to-day control from WhatsApp

All of this is in your own chat; no terminal needed.

| You send | Effect |
|---|---|
| `/status` | Is it connected, uptime, which host, model, counts |
| `/pause` · `/resume` | Stop/start replying to people (persists across restarts) |
| `/persona Travelling until Friday, slow to reply. Call if urgent.` | Change what the assistant tells people, instantly. `/persona` shows it, `/persona clear` goes back to `.env` |
| `/statuses` · `/recommend football` · "anything funny worth watching?" | Status browsing |
| `/logs` | Last warnings/errors, so you can tell what went wrong without SSH |
| `/restart` | Restart the process (pm2/Docker brings it back in ~3s) |

Things that still need SSH: changing the API key or model (`nano .env` then `pm2 restart wa-agent`), updating the code, and re-linking if WhatsApp logs the device out (`npm run reset-auth`, `pm2 restart wa-agent`, `pm2 logs wa-agent` to scan).

## 6. Keeping it healthy

- **Updates**: `cd ~/wa-agent && git pull` (or rsync again) → `npm install` → `pm2 restart wa-agent`.
- **Back up** `auth/` and `data/` occasionally (`tar czf backup.tgz auth data`). Losing `auth/` only means re-linking; losing `data/` loses chat history and the current day's statuses.
- **If `/status` stops answering**: SSH in, `pm2 logs wa-agent --lines 100`. A `Logged out` line means WhatsApp unlinked the device → re-link. Anything else, `pm2 restart wa-agent` usually clears it.
- **Costs**: with `claude-haiku-5-5` and `STATUS_DESCRIBE_MEDIA=true`, a typical day of a few dozen replies and a few dozen statuses is cents. Watch your API usage page for the first week.
- **Ban risk reminder**: this is still an unofficial client on a personal account. The bot only replies, rate-limits itself and goes quiet when you reply manually, which keeps it well away from spam patterns, but keep `AUTO_REPLY_MAX_PER_HOUR` sane and don't bolt on bulk sending.
