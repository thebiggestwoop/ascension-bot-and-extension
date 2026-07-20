"""In-memory, per-guild activity log the Owlbear extension polls for new
rolls, instead of a persistent push connection.

An earlier version of this used Server-Sent Events (a long-lived streaming
response), but Cloudflare's free/quick tunnels don't reliably relay
streaming responses -- confirmed by testing directly: an SSE connection's
very first bytes would sit in the tunnel indefinitely and never reach the
client, even though the same response worked instantly over plain
localhost. Short polling only ever does ordinary bounded request/response
cycles, which already work fine through the same tunnel.

Each event gets an incrementing per-guild sequence number so a poller can
ask "what's new since seq N" instead of re-fetching everything each time.
"""

MAX_HISTORY = 40

_history = {}  # guild_id -> list of (seq, event), oldest first
_next_seq = {}  # guild_id -> next sequence number to assign


def publish(guild_id, event):
    seq = _next_seq.get(guild_id, 1)
    _next_seq[guild_id] = seq + 1

    entries = _history.setdefault(guild_id, [])
    entries.append((seq, event))
    if len(entries) > MAX_HISTORY:
        del entries[: len(entries) - MAX_HISTORY]


def get_since(guild_id, since_seq):
    return [event for seq, event in _history.get(guild_id, ()) if seq > since_seq]


def latest_seq(guild_id):
    entries = _history.get(guild_id)
    return entries[-1][0] if entries else 0
