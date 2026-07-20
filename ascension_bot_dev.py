"""Development fork of ascension_bot_ver2.py for the Owlbear integration project.

Discord-facing commands only -- the actual dice/pool logic lives in
game_logic.py, and the HTTP API for the Owlbear extension lives in
web_api.py. Both this bot and the web API import the same game_logic
functions, so Momentum/Threat state and roll validation stay identical
no matter which front end (Discord chat vs. Owlbear) triggered them.

This file intentionally does NOT reuse ascension_bot_ver2.py's token.txt --
running two processes on the same bot token at once causes Discord
connection conflicts. Use a separate bot application/token for this dev copy
(env var DISCORD_BOT_TOKEN, or a token.txt placed in this same folder).
"""

import asyncio
import logging
import os
import secrets

import discord
from discord.ext import commands

import event_bus
import game_logic as gl
import web_api

# Set up logging
logging.basicConfig(level=logging.INFO)

# Set up bot with a prefix for commands
intents = discord.Intents.default()
intents.message_content = True
bot = commands.Bot(command_prefix="!", intents=intents)

# Maps a pairing code -> {"guild_id": int, "channel_id": int}, created by
# !link and consumed by web_api.py. In-memory only -- codes (and the link
# itself) are lost on restart, same as the momentum/threat pools.
pairing_codes = {}


def generate_pairing_code():
    return secrets.token_urlsafe(6)


# Command for d20 roll
@bot.command()
@commands.guild_only()
async def d20(ctx, target_number: int, crit_range: int, num_dice: int = 2):
    try:
        rolls, total_successes, complications = gl.perform_d20_roll(target_number, crit_range, num_dice)
    except gl.AscensionError as e:
        await ctx.send(f"{ctx.author.mention}\n**Error:** {e}")
        return

    emoji_chunks, result_text = gl.format_d20_discord(rolls, target_number, crit_range, total_successes, complications)

    # Sent emoji-only (no text) so Discord renders the dice faces at large size
    for chunk in emoji_chunks:
        await ctx.send(chunk)

    await ctx.send(f"{ctx.author.mention}\n{result_text}")

    event_bus.publish(ctx.guild.id, {
        "type": "d20_roll",
        "source": "discord",
        "actor": ctx.author.display_name,
        "rolls": rolls,
        "crit_range": crit_range,
        "total_successes": total_successes,
        "complications": complications,
    })


# Command for Challenge Dice roll
@bot.command(name="cd")
@commands.guild_only()
async def challenge(ctx, num_dice: int):
    try:
        faces, total_successes, effects, blanks = gl.perform_challenge_roll(num_dice)
    except gl.AscensionError as e:
        await ctx.send(f"{ctx.author.mention}\n**Error:** {e}")
        return

    symbols, result_text = gl.format_challenge_discord(faces, total_successes, effects, blanks)

    # Sent emoji-only (no text) so Discord renders the dice faces at large size
    await ctx.send(symbols)
    # Send the details of the roll in a second message
    await ctx.send(f"{ctx.author.mention}\n{result_text}")

    event_bus.publish(ctx.guild.id, {
        "type": "challenge_roll",
        "source": "discord",
        "actor": ctx.author.display_name,
        "faces": faces,
        "total_successes": total_successes,
        "effects": effects,
        "blanks": blanks,
    })


@bot.command(name="m")
@commands.guild_only()
async def momentum(ctx, *args):
    server_id = ctx.guild.id

    if not args:
        await ctx.send(f"{ctx.author.mention}\n**Current Momentum:** {gl.get_momentum(server_id)}")
    elif args[0] == "set" and len(args) == 2:
        try:
            amount = int(args[1])
            new_value = gl.set_momentum(server_id, amount)
            await ctx.send(f"{ctx.author.mention}\n**Momentum set to:** {new_value}")
            event_bus.publish(server_id, {
                "type": "momentum", "source": "discord", "actor": ctx.author.display_name, "value": new_value,
            })
        except gl.AscensionError as e:
            await ctx.send(f"{ctx.author.mention}\n**Error:** {e}")
        except ValueError:
            await ctx.send(f"{ctx.author.mention}\n**Error:** Please provide a valid number.")
    else:
        try:
            amount = gl.parse_signed_amount(args)
            new_value = gl.adjust_momentum(server_id, amount)
            await ctx.send(f"{ctx.author.mention}\n**Momentum updated to:** {new_value}")
            event_bus.publish(server_id, {
                "type": "momentum", "source": "discord", "actor": ctx.author.display_name, "value": new_value,
            })
        except gl.AscensionError as e:
            await ctx.send(f"{ctx.author.mention}\n**Error:** {e}")
        except ValueError:
            await ctx.send(f"{ctx.author.mention}\n**Error:** Please provide a valid number.")

    # Send the current momentum as a string of emojis (kept emoji-only so Discord renders them large)
    emoji_string = gl.momentum_emoji_string(server_id)
    if emoji_string:
        await ctx.send(emoji_string)


@bot.command(name="t")
@commands.guild_only()
async def threat(ctx, *args):
    server_id = ctx.guild.id

    if not args:
        await ctx.send(f"{ctx.author.mention}\n**Current Threat:** {gl.get_threat(server_id)}")
    elif args[0] == "set" and len(args) == 2:
        try:
            amount = int(args[1])
            new_value = gl.set_threat(server_id, amount)
            await ctx.send(f"{ctx.author.mention}\n**Threat set to:** {new_value}")
            event_bus.publish(server_id, {
                "type": "threat", "source": "discord", "actor": ctx.author.display_name, "value": new_value,
            })
        except gl.AscensionError as e:
            await ctx.send(f"{ctx.author.mention}\n**Error:** {e}")
        except ValueError:
            await ctx.send(f"{ctx.author.mention}\n**Error:** Please provide a valid number.")
    else:
        try:
            amount = gl.parse_signed_amount(args)
            new_value = gl.adjust_threat(server_id, amount)
            await ctx.send(f"{ctx.author.mention}\n**Threat updated to:** {new_value}")
            event_bus.publish(server_id, {
                "type": "threat", "source": "discord", "actor": ctx.author.display_name, "value": new_value,
            })
        except gl.AscensionError as e:
            await ctx.send(f"{ctx.author.mention}\n**Error:** {e}")
        except ValueError:
            await ctx.send(f"{ctx.author.mention}\n**Error:** Please provide a valid number.")

    # Send the current threat as a string of emojis (kept emoji-only so Discord renders them large)
    emoji_string = gl.threat_emoji_string(server_id)
    if emoji_string:
        await ctx.send(emoji_string)


@bot.command(name="h")
async def help_command(ctx):
    help_text = (
        "**Bot Commands:**\n\n"
        "**!d20 [target_number] [crit_range] [num_dice]** - Rolls d20 dice. Specify the target number, critical range, and number of dice (default is 2).\n"
        "**!cd [num_dice]** - Rolls Challenge Dice. Specify the number of dice.\n"
        "**!m [amount]** - Adjusts the Momentum pool. Use `!m` to check current Momentum, `!m set [amount]` to set a value, or `!m [amount]` to add/subtract.\n"
        "**!t [amount]** - Adjusts the Threat pool. Use `!t` to check current Threat, `!t set [amount]` to set a value, or `!t [amount]` to add/subtract.\n"
        "**!link** - Generates a code to link this channel to the Owlbear extension.\n"
    )
    await ctx.send(help_text)


@bot.command(name="link")
@commands.guild_only()
async def link(ctx):
    code = generate_pairing_code()
    pairing_codes[code] = {"guild_id": ctx.guild.id, "channel_id": ctx.channel.id}
    await ctx.send(f"{ctx.author.mention}\n**Owlbear pairing code:** {code}")


# Bot event to log readiness
@bot.event
async def on_ready():
    logging.info(f'Logged in as {bot.user} (ID: {bot.user.id})')
    logging.info('------')


# Central error handler so bad input doesn't dump a raw traceback to users
@bot.event
async def on_command_error(ctx, error):
    if isinstance(error, commands.NoPrivateMessage):
        await ctx.send(f"{ctx.author.mention}\n**Error:** This command can't be used in DMs.")
    elif isinstance(error, commands.MissingPermissions):
        await ctx.send(f"{ctx.author.mention}\n**Error:** You don't have permission to run that command.")
    elif isinstance(error, commands.MissingRequiredArgument):
        await ctx.send(f"{ctx.author.mention}\n**Error:** Missing argument: `{error.param.name}`.")
    elif isinstance(error, commands.BadArgument):
        await ctx.send(f"{ctx.author.mention}\n**Error:** Invalid argument. Please check the command usage with `!h`.")
    elif isinstance(error, commands.CommandNotFound):
        pass
    else:
        logging.error(f"Unhandled error in command '{ctx.command}': {error}")
        await ctx.send(f"{ctx.author.mention}\n**Error:** Something went wrong running that command.")


def load_token():
    """Load the bot token from the DISCORD_BOT_TOKEN env var, falling back to
    a token.txt file kept next to this script (not committed to source)."""
    token = os.environ.get("DISCORD_BOT_TOKEN")
    if token:
        return token

    token_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "token.txt")
    if os.path.isfile(token_path):
        with open(token_path, "r", encoding="utf-8") as f:
            token = f.read().strip()
        if token:
            return token

    raise RuntimeError(
        "No Discord bot token found. Set the DISCORD_BOT_TOKEN environment variable, "
        "or create a token.txt file next to this script containing just the token."
    )


async def main():
    async with bot:
        asyncio.create_task(web_api.start_web_server(bot, pairing_codes))
        await bot.start(load_token())


if __name__ == "__main__":
    asyncio.run(main())
