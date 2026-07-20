# Ascension Bot & Owlbear Extension

A Discord bot for the "Ascension" tabletop system (a d20 roll-under game with a Momentum/Threat economy and a Genesys-style "Challenge Dice" mechanic), paired with an Owlbear Rodeo extension that acts as a remote control for it — roll dice or nudge Momentum/Threat from inside Owlbear, and the result posts to Discord automatically.

**Just want to use it?** Invite the live bot to your Discord server: **[Add to Discord](https://discord.com/oauth2/authorize?client_id=1303062746362810389)** — then run `!h` in any channel for the command list, or `!link` to pair the Owlbear extension.

## Contents

- [Architecture at a glance](#architecture-at-a-glance)
- [The Discord bot](#the-discord-bot)
- [The Owlbear extension](#the-owlbear-extension)
- [How this deployment is hosted](#how-this-deployment-is-hosted)
- [Setting it up yourself](#setting-it-up-yourself)
- [Repo layout](#repo-layout)
- [Known limitations](#known-limitations)

---

## Architecture at a glance

```
Owlbear extension (docs/, static files)
        |  HTTPS fetch()
        v
Discord bot process (game logic + Discord commands + a small web API)
        |  channel.send(...)
        v
     Discord channel
```

Two front ends — Discord chat commands and the Owlbear extension — both call into the *same* underlying game logic (`game_logic.py`), so Momentum/Threat state and roll rules stay identical no matter which one triggered them. The bot process itself hosts both the Discord connection and a small HTTP API in the same asyncio event loop, so the web API can post to Discord directly (`channel.send(...)`) without a separate webhook or second bot token.

---

## The Discord bot

### Commands

| Command | Who | What it does |
|---|---|---|
| `!d20 <target_number> <crit_range> [num_dice=2]` | anyone | Rolls `num_dice` d20s. A roll counts as a success if it's ≤ `target_number`, and as an *extra* success if it's ≤ `crit_range` (so low rolls in the crit range count double). A natural 20 is a "complication." Rolls in the crit range are bolded in the summary. Dice are capped at 20 per roll (spam/abuse guard). |
| `!cd <num_dice>` | anyone | Rolls Challenge Dice (d6s reskinned with symbols): `1` = success, `2` = double success, `3`–`4` = blank, `5`–`6` = effect. Total successes = successes + effects. Capped at 50 dice per roll (spam/abuse guard). |
| `!m` / `!m set <n>` / `!m <±n>` | anyone | Check, set, or adjust the Momentum pool. Capped at 0–6 (a hard game rule). Accepts `!m +3`, `!m + 3` (space allowed), or `!m -2`. |
| `!t` / `!t set <n>` / `!t <±n>` | anyone | Same as Momentum, but for Threat. Threat has no true in-game cap (that's an intentional difference between the two currencies), but is safety-capped at 50 to guard against typos/spam. |
| `!h` | anyone | Prints the command list. |
| `!link` | Manage Server permission | Generates a pairing code that links the current channel to the Owlbear extension (see below). |

Dice results are always sent as **emoji-only messages** with no accompanying text — Discord renders a message as large emoji only when it contains nothing else, which is why roll results are split into an emoji message followed by a separate text summary message, rather than combined into one.

### Game logic module (`game_logic.py`)

All dice math and pool validation lives here, with zero Discord or web-framework dependency, so both front ends (`ascension_bot_dev.py` for Discord, `web_api.py` for the extension) call the exact same functions instead of each re-implementing the rules. Key pieces:

- `perform_d20_roll` / `perform_challenge_roll` — validate input (dice count 1–20 for d20, 1–50 for Challenge Dice) and roll, raising `AscensionError` with a human-readable message on bad input.
- `format_d20_discord` / `format_challenge_discord` — turn a raw roll result into the emoji string + markdown text Discord messages are built from.
- `get_/set_/adjust_momentum` and `get_/set_/adjust_threat` — pool state (plain in-memory dicts keyed by Discord guild ID) with bounds checking.

### Live activity log (`event_bus.py`)

A small in-memory, per-guild log of recent rolls and pool changes, each with an incrementing sequence number. Every roll or pool change — whether it came from a Discord command or the Owlbear extension — gets published here. The Owlbear extension polls this (see below) so it can show rolls and pool updates that happened in Discord, not just ones it triggered itself.

This started out as a real-time push mechanism (Server-Sent Events), but that had to be abandoned: Cloudflare's free tunnels turned out to silently buffer long-lived streaming responses indefinitely rather than relaying them live, so the extension polls a bounded endpoint every ~2.5 seconds instead. See `event_bus.py`'s docstring for the full story.

---

## The Owlbear extension

A static site (`docs/`) — plain HTML/CSS/JS, no build step, imports the `@owlbear-rodeo/sdk` straight from a CDN. It's a popover in Owlbear's toolbar with:

- **d20 / Challenge Dice rollers** — same parameters as the Discord commands, posting the result to the linked Discord channel with the roller's Owlbear display name as attribution (no Discord mention, since there's no Discord identity available from inside Owlbear).
- **Momentum / Threat controls** — `-1`/`+1` buttons only *stage* a pending delta locally; an **Apply** button sends the accumulated change as a single request (and a single Discord message), instead of spamming one message per click. A "Set to" input remains for setting an absolute value directly.
- **Roll History** — a scrolling log of recent rolls (from either platform), fed by polling `/api/<code>/updates`.
- **GM-gated Threat** — Threat's controls are hidden unless `OBR.player.getRole() === "GM"` (Owlbear's own native GM/Player distinction, no Discord permission mapping involved). The server additionally checks a `caller_role` field the extension sends along — this is a **soft gate against UI tampering**, not real security: there's no cryptographic identity behind it, since Owlbear and Discord are different platforms with no shared login.

### Pairing

Since the extension has no way to know which Discord channel should receive its rolls, a **pairing code** links the two:

1. A GM runs `!link` in the target Discord channel; the bot replies with a short code (mapping `code → (guild, channel)`, kept in memory).
2. Whoever's running the game pastes that code into the extension's Settings once.
3. The extension stores it in `OBR.room.metadata` — Owlbear automatically replicates room metadata to every client connected to that Owlbear room, so **only one person ever has to enter the code**; everyone else's extension picks it up automatically.

Pairing codes (and the Momentum/Threat pools) live only in the bot process's memory — they reset if the bot restarts. In practice this rarely matters, since the bot runs as an always-on service (see below), but a `!link` re-run is the fix if it ever does.

### Why not client-side dice rolling?

Unlike some Owlbear dice extensions, rolls aren't computed in the browser — the extension sends the *parameters* (target number, crit range, dice count) to the bot, and the bot (server-side, in Python) does the actual `random` roll, validates it, formats it, and posts it. This keeps one single implementation of the dice rules (reused by both Discord and Owlbear) instead of maintaining the same logic in two languages, and means a browser client can't just fabricate a favorable roll.

---

## How this deployment is hosted

This section documents the actual setup for this instance of the bot — useful background, but see [Setting it up yourself](#setting-it-up-yourself) below if you're deploying your own copy.

- **Bot process**: an Oracle Cloud "Always Free" VM (`VM.Standard.E2.1.Micro`, Ubuntu 24.04 — the free Ampere/ARM shape is more generous but is frequently out of capacity; the tiny AMD shape is more than enough for this workload). Runs as a `systemd` service (`ascension-bot.service`) so it survives reboots and restarts automatically if it crashes.
- **Public access to the bot's web API**: a **named Cloudflare Tunnel** (`cloudflared`, installed as its own `systemd` service on the VM) exposes the bot's local port 8420 at a stable hostname, without opening any inbound firewall ports on the VM — the tunnel only makes outbound connections to Cloudflare's edge. This requires a domain added to a Cloudflare account (a quick/anonymous tunnel doesn't need this, but its URL changes every restart, which isn't workable long-term).
- **Extension frontend**: hosted on **GitHub Pages** (`docs/` folder of this repo), with its own custom domain rather than the default `username.github.io/reponame/` project-site URL. This matters for a subtle reason: Owlbear resolves the manifest's `icon`/`popover` paths as root-relative to whatever *origin* serves the manifest, not relative to the manifest's own folder — so a project-site subpath breaks it. A custom domain (via a Cloudflare DNS CNAME, set to **DNS only**, not proxied, so GitHub can provision its own certificate) makes the extension serve from a true domain root, where root-relative paths resolve correctly.

---

## Setting it up yourself

You'll need: a Discord bot application (and its token), somewhere to run Python continuously, a way to expose that process's port 8420 over HTTPS at a stable address, and somewhere to host the `docs/` folder as a static site.

### 1. Discord bot application

Create an application + bot user at the [Discord Developer Portal](https://discord.com/developers/applications), enable the **Message Content** intent (Bot → Privileged Gateway Intents), and invite it to your server with permission to send messages. Copy the bot token — you'll need it in step 3.

### 2. Get the code and install dependencies

```bash
git clone <this-repo-url>
cd <repo-folder>
python3 -m venv venv
./venv/bin/pip install -r requirements.txt
```

### 3. Provide the bot token

Either set an environment variable:

```bash
export DISCORD_BOT_TOKEN=your-token-here
```

or drop a `token.txt` file (just the token, nothing else) next to `ascension_bot_dev.py`. It's git-ignored, so it won't accidentally get committed.

### 4. Run it

```bash
./venv/bin/python ascension_bot_dev.py
```

This starts both the Discord bot and the web API (port 8420, override via `web_api.WEB_PORT` if needed) in one process. For anything beyond quick local testing, run this under a process supervisor so it restarts on crash/reboot — a `systemd` unit is the simplest option on Linux:

```ini
[Unit]
Description=Ascension Discord bot + Owlbear web API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=<your-user>
WorkingDirectory=/path/to/repo
ExecStart=/path/to/repo/venv/bin/python /path/to/repo/ascension_bot_dev.py
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### 5. Expose the web API over HTTPS at a stable address

The Owlbear extension needs to reach port 8420 from players' own browsers, over HTTPS (mixed content rules block an HTTPS page from calling an HTTP backend). A **Cloudflare named tunnel** is a solid free option:

1. Add a domain to a free Cloudflare account.
2. Zero Trust dashboard → Networks → Tunnels → create a tunnel, connector type Cloudflared.
3. Run the install command it gives you on your server (`sudo cloudflared service install <token>` on Debian/Ubuntu — installs `cloudflared` as its own systemd service).
4. In the tunnel's **Public Hostname** tab, route your chosen subdomain (e.g. `bot.yourdomain.com`) to `http://localhost:8420`.

Any other way of getting a stable HTTPS reverse proxy in front of port 8420 works too (a reverse proxy you manage yourself with a Let's Encrypt cert, another tunneling provider, etc.) — the bot doesn't care how requests arrive, only that they do.

### 6. Point the extension at your backend and host it

Open `docs/app.js` and change the `BACKEND_URL` constant near the top to your own stable URL from step 5:

```js
const BACKEND_URL = "https://bot.yourdomain.com";
```

Then host the `docs/` folder as a static site. A few free options:

- **GitHub Pages with a custom domain** (what this deployment uses) — Settings → Pages → source = `main` branch, `/docs` folder, then set a custom domain and point a DNS CNAME at `<username>.github.io` (**DNS only**, not proxied, so GitHub's certificate provisioning can complete).
- **GitHub Pages without a custom domain** — works too, but you'll need to switch `manifest.json`'s `icon`/`popover` fields from root-relative (`/icon.svg`) to plain relative (`icon.svg`), since the site will be served from a `/reponame/` subpath rather than a domain root.
- **Cloudflare Pages / Netlify / Vercel** — any static host works; same root-vs-subpath consideration applies depending on whether you attach a custom domain.

### 7. Install the extension in Owlbear

In Owlbear Rodeo, open the Extensions panel → **Add custom extension** → paste the URL to your hosted `manifest.json`.

### 8. Link a channel and go

In the Discord channel you want rolls posted to, run `!link` (needs Manage Server permission) and copy the code it replies with. Open the extension's popover in Owlbear, paste the code into Settings, save, and you're set — every player in that Owlbear room will pick up the same pairing automatically via Owlbear's room metadata sync.

---

## Repo layout

```
ascension_bot_dev.py   Discord-facing bot: commands, on_ready/on_command_error, entry point
game_logic.py          Pure dice/pool logic shared by both front ends -- no Discord/web dependency
event_bus.py           In-memory per-guild activity log the extension polls for updates
web_api.py             aiohttp HTTP API for the extension (rolls, pool changes, polling endpoint)
serve_extension.py     Small local static server (with CORS headers) for testing docs/ locally
requirements.txt       Python dependencies
docs/                  The Owlbear extension itself (static site, hosted via GitHub Pages)
  manifest.json          Owlbear extension manifest
  index.html             Popover markup
  app.js                 Popover logic (OBR SDK, polling, pairing, roll/pool controls)
  style.css              Popover styling
  icon.svg               Toolbar icon
```

## Known limitations

- **State is in-memory only.** Pairing codes and Momentum/Threat pools reset if the bot process restarts. Fine for an always-on service; something to know if you ever see Momentum/Threat unexpectedly reset to 0.
- **No cross-platform identity.** Discord and Owlbear have entirely separate identity systems with no linking between them. Attribution from the extension (`player_name`, GM role) is self-reported by the client, not cryptographically verified — adequate for a private game with people you trust, not a public/adversarial deployment.
- **Rolls are server-authoritative but the transport isn't authenticated beyond the pairing code.** Anyone who obtains a valid pairing code can post rolls/pool changes to the linked channel through the bot. Treat the code like a lightweight shared secret (`!link` is restricted to Manage Server permission for this reason).
