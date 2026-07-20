"""aiohttp web layer that lets the Owlbear extension trigger the same
dice-roll/pool logic used by the Discord commands (via game_logic.py), and
post the results into whichever Discord channel a pairing code is linked to.

Runs in the same asyncio event loop as the bot (see ascension_bot_dev.main()),
so handlers can call channel.send(...) directly using the bot's existing
Discord connection -- no separate webhook or bot token needed.

Also exposes a polling endpoint (handle_updates) so the extension can pick
up rolls and pool changes triggered from Discord chat commands, not just
its own actions -- see event_bus.py for why this is polling rather than a
push/streaming connection.
"""

import logging

from aiohttp import web

import event_bus
import game_logic as gl

WEB_PORT = 8420


def _attribution(actor):
    return f"**{actor}** (via Owlbear)"


async def _get_channel(bot, channel_id):
    channel = bot.get_channel(channel_id)
    if channel is None:
        channel = await bot.fetch_channel(channel_id)
    return channel


def create_app(bot, pairing_codes):
    """pairing_codes is the same dict mutated by the bot's !link command --
    code -> {"guild_id": int, "channel_id": int}."""

    def resolve_pairing(request):
        return pairing_codes.get(request.match_info["code"])

    async def read_json(request):
        try:
            return await request.json()
        except Exception:
            return None

    async def handle_state(request):
        pairing = resolve_pairing(request)
        if pairing is None:
            return web.json_response({"error": "Unknown or expired pairing code."}, status=404)

        guild_id = pairing["guild_id"]
        return web.json_response({
            "momentum": gl.get_momentum(guild_id),
            "threat": gl.get_threat(guild_id),
        })

    async def handle_updates(request):
        """Polled by the extension every few seconds: current momentum/threat
        plus any roll/pool events published since the `since` sequence
        number it last saw (0 the first time, which returns full history)."""
        pairing = resolve_pairing(request)
        if pairing is None:
            return web.json_response({"error": "Unknown or expired pairing code."}, status=404)

        guild_id = pairing["guild_id"]
        try:
            since = int(request.query.get("since", 0))
        except ValueError:
            since = 0

        return web.json_response({
            "momentum": gl.get_momentum(guild_id),
            "threat": gl.get_threat(guild_id),
            "events": event_bus.get_since(guild_id, since),
            "seq": event_bus.latest_seq(guild_id),
        })

    async def handle_d20_roll(request):
        pairing = resolve_pairing(request)
        if pairing is None:
            return web.json_response({"error": "Unknown or expired pairing code."}, status=404)

        data = await read_json(request)
        if data is None:
            return web.json_response({"error": "Invalid JSON body."}, status=400)

        try:
            target_number = int(data["target_number"])
            crit_range = int(data["crit_range"])
            num_dice = int(data.get("num_dice", 2))
        except (KeyError, TypeError, ValueError):
            return web.json_response({"error": "target_number and crit_range are required integers."}, status=400)

        try:
            rolls, total_successes, complications = gl.perform_d20_roll(target_number, crit_range, num_dice)
        except gl.AscensionError as e:
            return web.json_response({"error": str(e)}, status=400)

        emoji_chunks, result_text = gl.format_d20_discord(rolls, target_number, crit_range, total_successes, complications)

        actor = data.get("player_name") or "Someone"
        channel = await _get_channel(bot, pairing["channel_id"])
        for chunk in emoji_chunks:
            await channel.send(chunk)
        await channel.send(f"{_attribution(actor)}\n{result_text}")

        event_bus.publish(pairing["guild_id"], {
            "type": "d20_roll",
            "source": "owlbear",
            "actor": actor,
            "rolls": rolls,
            "crit_range": crit_range,
            "total_successes": total_successes,
            "complications": complications,
        })

        return web.json_response({
            "rolls": rolls,
            "total_successes": total_successes,
            "complications": complications,
        })

    async def handle_challenge_roll(request):
        pairing = resolve_pairing(request)
        if pairing is None:
            return web.json_response({"error": "Unknown or expired pairing code."}, status=404)

        data = await read_json(request)
        if data is None:
            return web.json_response({"error": "Invalid JSON body."}, status=400)

        try:
            num_dice = int(data["num_dice"])
        except (KeyError, TypeError, ValueError):
            return web.json_response({"error": "num_dice is a required integer."}, status=400)

        try:
            faces, total_successes, effects, blanks = gl.perform_challenge_roll(num_dice)
        except gl.AscensionError as e:
            return web.json_response({"error": str(e)}, status=400)

        symbols, result_text = gl.format_challenge_discord(faces, total_successes, effects, blanks)

        actor = data.get("player_name") or "Someone"
        channel = await _get_channel(bot, pairing["channel_id"])
        await channel.send(symbols)
        await channel.send(f"{_attribution(actor)}\n{result_text}")

        event_bus.publish(pairing["guild_id"], {
            "type": "challenge_roll",
            "source": "owlbear",
            "actor": actor,
            "faces": faces,
            "total_successes": total_successes,
            "effects": effects,
            "blanks": blanks,
        })

        return web.json_response({
            "total_successes": total_successes,
            "effects": effects,
            "blanks": blanks,
        })

    async def handle_pool_update(pairing, data, get_fn, set_fn, adjust_fn, emoji_fn, pool_label):
        guild_id = pairing["guild_id"]
        action = data.get("action")

        try:
            amount = int(data["amount"])
        except (KeyError, TypeError, ValueError):
            return web.json_response({"error": "amount is a required integer."}, status=400)

        try:
            if action == "set":
                new_value = set_fn(guild_id, amount)
                verb = "set to"
            elif action == "adjust":
                new_value = adjust_fn(guild_id, amount)
                verb = "updated to"
            else:
                return web.json_response({"error": "action must be 'set' or 'adjust'."}, status=400)
        except gl.AscensionError as e:
            return web.json_response({"error": str(e)}, status=400)

        actor = data.get("player_name") or "Someone"
        channel = await _get_channel(bot, pairing["channel_id"])
        await channel.send(f"{_attribution(actor)}\n**{pool_label} {verb}:** {new_value}")

        emoji_string = emoji_fn(guild_id)
        if emoji_string:
            await channel.send(emoji_string)

        event_bus.publish(guild_id, {
            "type": pool_label.lower(),
            "source": "owlbear",
            "actor": actor,
            "value": new_value,
        })

        return web.json_response({pool_label.lower(): new_value})

    async def handle_momentum(request):
        pairing = resolve_pairing(request)
        if pairing is None:
            return web.json_response({"error": "Unknown or expired pairing code."}, status=404)

        data = await read_json(request)
        if data is None:
            return web.json_response({"error": "Invalid JSON body."}, status=400)

        return await handle_pool_update(
            pairing, data, gl.get_momentum, gl.set_momentum, gl.adjust_momentum, gl.momentum_emoji_string, "Momentum"
        )

    async def handle_threat(request):
        pairing = resolve_pairing(request)
        if pairing is None:
            return web.json_response({"error": "Unknown or expired pairing code."}, status=404)

        data = await read_json(request)
        if data is None:
            return web.json_response({"error": "Invalid JSON body."}, status=400)

        # Soft gate only -- the extension hides these controls from non-GM
        # Owlbear players and sends this flag itself, same trust level as
        # player_name. It stops accidental UI tampering, not a determined
        # attacker with the pairing code (there's no real cross-platform
        # identity to check against).
        if data.get("caller_role") != "GM":
            return web.json_response({"error": "Only the GM can adjust Threat."}, status=403)

        return await handle_pool_update(
            pairing, data, gl.get_threat, gl.set_threat, gl.adjust_threat, gl.threat_emoji_string, "Threat"
        )

    @web.middleware
    async def cors_middleware(request, handler):
        if request.method == "OPTIONS":
            response = web.Response()
        else:
            try:
                response = await handler(request)
            except web.HTTPException as exc:
                response = exc
            except Exception:
                logging.exception("Unhandled error in Owlbear web API request")
                response = web.json_response({"error": "Internal server error."}, status=500)
        response.headers["Access-Control-Allow-Origin"] = "*"
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type"
        return response

    app = web.Application(middlewares=[cors_middleware])
    app.router.add_get('/api/{code}/state', handle_state)
    app.router.add_get('/api/{code}/updates', handle_updates)
    app.router.add_post('/api/{code}/roll/d20', handle_d20_roll)
    app.router.add_post('/api/{code}/roll/cd', handle_challenge_roll)
    app.router.add_post('/api/{code}/momentum', handle_momentum)
    app.router.add_post('/api/{code}/threat', handle_threat)
    app.router.add_route('OPTIONS', '/{tail:.*}', lambda request: web.Response())
    return app


async def start_web_server(bot, pairing_codes, port=WEB_PORT):
    app = create_app(bot, pairing_codes)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, '0.0.0.0', port)
    await site.start()
    logging.info(f"Owlbear web API listening on http://0.0.0.0:{port}")
