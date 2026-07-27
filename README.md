# Ascension Bot & Owlbear Extension

A Discord bot and an Owlbear Rodeo extension for the "Ascension" tabletop system, sharing the exact same roll/pool rules. Each works completely on its own — roll dice and track Momentum/Threat right from Owlbear with no Discord bot required — and pairing them together also posts every roll and pool change into a linked Discord channel.

**Just want to use it?** Invite the live bot to your Discord server: **[Add to Discord](https://discord.com/oauth2/authorize?client_id=1303062746362810389&scope=bot&permissions=330752)** — then run `!h` in any channel for the command list, or `!link` to pair the Owlbear extension.

The link requests View Channels, Send Messages, Read Message History, and Use External Emojis — without these, the bot can join a server but stay silent in channels where `@everyone` doesn't already have those permissions. If the bot's already in your server from an older link, re-clicking this one will prompt Discord to update its permissions rather than add a duplicate.

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
Owlbear extension (docs/, static files, rolls locally)
        |  OBR.broadcast (peer-to-peer, no server)  -->  everyone else in the room
        |
        |  HTTPS fetch(), only if paired
        v
Discord bot process (game logic + Discord commands + a small web API)
        |  channel.send(...)
        v
     Discord channel
```

Both front ends share the same roll/pool rules: the bot's copy lives in `game_logic.py` (Python), the extension's in `docs/diceLogic.js` (a hand-maintained JS port, since a static site can't run Python). Rolling and Momentum/Threat both work with **no Discord bot involved at all** — the extension computes rolls itself and shares them live with everyone in the same Owlbear room via `OBR.broadcast`; Momentum/Threat sync the same way via Owlbear's room metadata. Pairing with Discord is optional: when paired, the extension additionally sends its already-computed result to the bot's `/announce` endpoint, which reuses `game_logic.py`'s own formatting to post a matching message to Discord — the bot only relays and formats, it never re-rolls. Discord's `!m`/`!t` commands still need one canonical value reachable from both platforms, so while paired, Momentum/Threat stay bot-authoritative (the existing `/momentum`/`/threat` endpoints and polling), rather than living in room metadata.

---

## The Discord bot

### Commands

| Command | Who | What it does |
|---|---|---|
| `!d20 <target_number> <crit_range> [num_dice=2] [dN \| con] [+N \| -N]` | anyone | Rolls `num_dice` d20s. A roll counts as a success if it's ≤ `target_number`, and as an *extra* success if it's ≤ `crit_range` (so low rolls in the crit range count double). A natural 20 is a "complication." Rolls in the crit range are bolded in the summary. Dice are capped at 20 per roll (spam/abuse guard). Optional `dN` sets a task Difficulty of `N` successes — the summary then reports whether the task succeeded (total successes ≥ Difficulty) and any Extra Successes (total successes − Difficulty, only when that's positive). Optional `con` instead sets Difficulty to the previous `!d20` roll's total successes, for **contested checks** (defender rolls plain, attacker rolls `con`) — reports "no defender roll found" and rolls without a Difficulty if there's no previous roll in that server yet. `dN` and `con` can't be combined. Optional `+N`/`-N` adjusts the final success count up or down (applied before Difficulty, floored at 0) — e.g. `!d20 10 2 +3`. |
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

- **Challenge Dice roller** — same parameters as the Discord command, with a dice-count stepper (dedicated +/- buttons beside a larger input, not the small overlay stepper other fields use — the count can go down to 0). **Roll CD** rolls it. Next to it, **Reroll Blanks** immediately re-rolls however many dice came up blank on the last Challenge Dice roll seen in this room (regardless of what's currently dialed into the count field), erroring if no prior Challenge Dice roll has been seen yet; **Reset** zeroes the count field. At the bottom of the card, a **Result** viewer shows the dice icons (centered) and the total/effects/blanks line for the most recent Challenge Dice roll(s) made *in this browser* — same scoping as the Task card's own Result viewer below (see there for details); Reset doesn't clear it. A fresh **Roll CD** clears the viewer and starts over, but **Reroll Blanks** instead appends its result below whatever's already there, so a chain of rerolls (reroll the blanks, then reroll *those* blanks, and so on) all stay visible stacked together until the next Roll CD wipes the chain. Rolls happen locally in the browser via `docs/diceLogic.js` and are shared live with everyone else in the room via Owlbear's own broadcast channel (`OBR.broadcast`) — no server round trip needed to see someone else's roll. (d20 checks are rolled from the **Task** card below, not a separate d20 card — see below.)
- **Momentum and Threat** — a collapsible dropdown (open by default, since these are checked/adjusted constantly during play, unlike the set-once Character Sheet) holding both pools together. `-1`/`+1` buttons only *stage* a pending delta locally; an **Apply** button sends the accumulated change as a single update, instead of spamming one change per click. A "Set to" input remains for setting an absolute value directly. Threat's controls are hidden unless `OBR.player.getRole() === "GM"` (Owlbear's own native GM/Player distinction, no Discord permission mapping involved, and no cryptographic identity behind it either way — see "Known limitations"). Each pool keeps its own accent-colored left border (Momentum = accent 1, Threat = accent 2) for an at-a-glance identity within the shared card.
- **Roll History** — a scrolling log of recent rolls from either platform: Owlbear-originated rolls arrive via `OBR.broadcast`, Discord-originated ones (typed directly as `!d20`/`!cd`) via polling `/api/<code>/updates` (only while paired).
- **Character Sheet** — a collapsible section (below Roll History) holding just a character's 7 Attributes (AGILI, BRAWN, COORD, AWARE, REASON, FAITH, PRES) and 6 Skills (SKIR, AUTH, DIPL, STUDY, MED, INT) as numeric fields, each next to a select button, under centered "Attributes"/"Skills" column headers.
- **Task** — always visible (not collapsible), this is where d20 checks actually get rolled: a **Dice** count (1–5, default 2), **Focus** toggle (Crit Range = the selected Skill's value instead of 1), **Complication/Advantage** (-5 to +5, always shown with an explicit sign — `+2`/`-3`/`+0` — a plain adjustment to the roll's final success count), and **Difficulty** (0–9, blank for none) with a **Contested** toggle that fills it in (grayed out) with the last check's successes — uncapped, since it has to reflect the real previous roll rather than the manual-entry range. Below that: **Target** (1–20) and **Crit** (1–9) fields, auto-filled (and clamped to those ranges) whenever an Attribute+Skill pair is selected in the Character Sheet above — but adjusting either by hand deselects those buttons, since they'd no longer necessarily match. Last is **Roll**, a plain editable text box (filling the rest of its row) auto-filled with the same syntax `!d20` accepts (target, crit, dice, then `dN`/`con`/`+N`-`-N`) built from Target/Crit and everything else above. Below that, on its own row: **Roll Task** rolls whatever's actually typed in the Roll field, so it can be hand-tweaked (or replaced entirely) before rolling; next to it, a plain **Reset** button puts every roll-time control back to its default (Dice 2, Focus off, Complication/Advantage +0, Difficulty/Target/Roll blank, Contested off, Crit 1) and deselects the Attribute/Skill buttons — without touching the Attributes'/Skills' own stat values, since those are the character, not roll-time settings. At the bottom of the card, a **Result** viewer shows just the dice icons (centered) and the rolls/outcome line for the single most recent roll made by clicking Roll Task *in this browser* — it's fed directly by that button's own click handler, so it never sees Challenge Dice rolls, other players' rolls (arriving via `OBR.broadcast`), or Discord-typed rolls (arriving via polling) — only this browser's own Roll Task presses, and Reset doesn't clear it (it's a roll record, not an input). Both Character Sheet and Task are purely personal, per-browser data (like the rest of a player's own settings), not synced to the room or the bot — only the roll it triggers is shared/announced like any other.
- **Named rolls** — the same roll-naming feature the sibling Lancer extension has (a bolded title shown above the roll in history, and riding on the same header line when posted to Discord), except the name is never hand-typed here: clicking **Roll Task** while both an Attribute and a Skill are still selected in the Character Sheet names the roll after that pair, using each stat's full display name rather than its abbreviated button label (e.g. "Agility + Skirmish"). Rolling with only one (or neither) selected — including after a manual Target/Crit edit deselects them — leaves the roll unnamed, same as before this feature existed.
- **Editable accent colors** — Settings has two hex-code text fields ("Accent color 1"/"Accent color 2") plus a **Reset colors** button, the same mechanism the sibling Lancer extension uses: typing a valid `#rrggbb` value live-updates the corresponding `--accent`/`--accent-2` CSS custom property (via an inline override on the root element, so it wins over the stylesheet's light/dark defaults) and persists it to `localStorage`; an invalid value shows an inline error and reverts the field. This is a per-browser preference, not synced to the room. `--accent` is used for the primary/filled action buttons (Roll Task, Roll CD); `--accent-2` is used for the Focus/Contested toggle switches and as every other button's hover highlight (they stay neutral-outlined at rest).
- **Export/Import Settings and Character Sheet** — same mechanism the sibling Lancer extension uses for its own Export/Import Settings (and Saved Rolls, which this bullet's Character Sheet stats take the place of, since Ascension has no saved-rolls concept). Export downloads a JSON file containing the 13 Character Sheet stat values (Attributes + Skills only — *not* the current selection, Focus toggle, or Target/Crit, which are roll-time state) plus the personal Settings (both accent colors, the Pair with Discord toggle). Import reads that file back in per-field, forgiving of anything missing or malformed (an invalid or absent key is just skipped, not an error) and applies everything live, no reload needed. Deliberately excluded either direction: the Discord pairing code itself, since it's tied to a specific Discord channel (and lives in room metadata, not this browser) rather than being a personal preference.

### Standalone by default, Discord optional

Rolling and Momentum/Threat both work with **no pairing code at all** — nothing here requires the Discord bot. A **Pair with Discord** toggle in Settings (on by default) is the master switch for the optional Discord relay:

- **Unpaired** (or the toggle turned off): Momentum/Threat live in `OBR.room.metadata`, the same primitive Owlbear uses to replicate the pairing code itself — every client in the room reads/writes it directly and stays in sync, including someone who joins or reloads mid-session.
- **Paired**: Momentum/Threat switch to being bot-authoritative instead (the existing `/state`/`/updates`/`/momentum`/`/threat` endpoints), because Discord's `!m`/`!t` commands need to reach the exact same value, and the bot has no way to read or write a specific Owlbear room's metadata directly. Rolls made in the extension additionally get posted to Discord via a `POST /api/<code>/announce` call — the bot reuses its own `format_d20_discord`/`format_challenge_discord` to build that message, it never re-rolls.

Toggling pairing on/off carries the current Momentum/Threat values across rather than resetting them to 0 — switching to local mode freezes the last-known values into room metadata; switching to bot mode picks up whatever `/state` reports (typically 0 for a freshly linked channel).

### Pairing

Since the extension has no way to know which Discord channel should receive its rolls, a **pairing code** links the two:

1. A GM runs `!link` in the target Discord channel; the bot replies with a short code (mapping `code → (guild, channel)`, kept in memory).
2. A GM pastes that code into the extension's Settings once (setting the code itself stays GM-gated, same as `!link`; the Pair with Discord toggle itself is available to every player, since it's a personal opt-out, not a room-level change).
3. The extension stores it in `OBR.room.metadata` — Owlbear automatically replicates room metadata to every client connected to that Owlbear room, so **only one person ever has to enter the code**; everyone else's extension picks it up automatically.

Pairing codes (and the bot-side Momentum/Threat pools, while paired) live only in the bot process's memory — they reset if the bot restarts. In practice this rarely matters, since the bot runs as an always-on service (see below), but a `!link` re-run is the fix if it ever does.

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
web_api.py             aiohttp HTTP API for the extension (/announce, paired pool changes, polling endpoint)
serve_extension.py     Small local static server (with CORS headers) for testing docs/ locally
requirements.txt       Python dependencies
docs/                  The Owlbear extension itself (static site, hosted via GitHub Pages)
  manifest.json          Owlbear extension manifest
  index.html             Popover markup
  app.js                 Popover logic (OBR SDK, local rolling, broadcast, metadata sync, pairing, roll/pool controls)
  diceLogic.js           JS port of game_logic.py's rolling/pool rules
  style.css              Popover styling
  icon.svg               Toolbar icon
```

## Known limitations

- **State is in-memory only, on the bot side.** Pairing codes, the bot-side (paired) Momentum/Threat pools, and the last-d20-roll tracker used by `con` all reset if the bot process restarts. Fine for an always-on service; something to know if `con` unexpectedly reports "no defender roll found" right after a restart, or if Momentum/Threat reset to 0 right after pairing.
- **Unpaired Momentum/Threat updates have a small race window.** Room metadata replication is last-write-wins, not a merge — two players adjusting a pool within the same network round trip can clobber each other (the extension re-fetches metadata immediately before writing to shrink this window, but doesn't eliminate it). Worst case is a lost click; the paired/bot-authoritative path doesn't have this issue, since it's a single in-memory dict updated on one thread.
- **No cross-platform identity.** Discord and Owlbear have entirely separate identity systems with no linking between them. Attribution from the extension (`player_name`, GM role) is self-reported by the client, not cryptographically verified — adequate for a private game with people you trust, not a public/adversarial deployment.
- **The Discord relay isn't authenticated beyond the pairing code.** Anyone who obtains a valid pairing code can post rolls/pool changes to the linked channel through the bot. Treat the code like a lightweight shared secret (`!link` is restricted to Manage Server permission for this reason).
