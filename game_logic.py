"""Pure game-logic core for the Ascension dice system: dice rolling,
Challenge Dice, and Momentum/Threat pool math.

No Discord or web-framework dependency here, on purpose -- both the Discord
commands (ascension_bot_dev.py) and the HTTP API for the Owlbear extension
(web_api.py) import this module and call the exact same validated logic,
instead of each reimplementing it.
"""

import random

# Momentum is capped at 6 by game rules. Threat has no in-game cap (that's an
# intentional difference between the two currencies), but we still bound it
# here as a safety limit against typos/spam.
MOMENTUM_MAX = 6
THREAT_SAFETY_CAP = 50

# Safety cap on dice count so a bad/huge input can't spam dozens of messages.
MAX_DICE = 20

# Global dictionaries to keep track of momentum and threat for each server
momentum_pool = {}
threat_pool = {}


class AscensionError(Exception):
    """A user-facing validation failure (bad roll/pool input). Any front end
    -- a Discord command, an Owlbear HTTP endpoint -- can catch this and show
    str(error) to the user without knowing the internals."""


# ---------------------------------------------------------------------------
# Dice rolling
# ---------------------------------------------------------------------------

def roll_dice(sides, num_dice):
    return [random.randint(1, sides) for _ in range(num_dice)]


def roll_d20(target_number, crit_range, num_dice):
    rolls = roll_dice(20, num_dice)
    successes = sum(1 for roll in rolls if roll <= target_number)
    crit_successes = sum(1 for roll in rolls if roll <= crit_range)
    complications = sum(1 for roll in rolls if roll == 20)
    total_successes = successes + crit_successes
    return rolls, total_successes, complications


def perform_d20_roll(target_number, crit_range, num_dice):
    """Validates and rolls d20s. Raises AscensionError on bad input."""
    if not 1 <= num_dice <= MAX_DICE:
        raise AscensionError(f"Number of dice must be between 1 and {MAX_DICE}.")
    return roll_d20(target_number, crit_range, num_dice)


# Emojis for d20 rolls
d20_emojis = {
    1: '<:d20_1:1303408045388464129>',
    2: '<:d20_2:1303408062002102282>',
    3: '<:d20_3:1303408078275743775>',
    4: '<:d20_4:1303408093811708074>',
    5: '<:d20_5:1303408111758868582>',
    6: '<:d20_6:1303408129077415946>',
    7: '<:d20_7:1303408146559144026>',
    8: '<:d20_8:1303408165408473189>',
    9: '<:d20_9:1303408182038888579>',
    10: '<:d20_10:1303408199184941068>',
    11: '<:d20_11:1303408230277320704>',
    12: '<:d20_12:1303408247641866361>',
    13: '<:d20_13:1303408265157152799>',
    14: '<:d20_14:1303408283045859379>',
    15: '<:d20_15:1303408306299207712>',
    16: '<:d20_16:1303408339593728041>',
    17: '<:d20_17:1303408357503139950>',
    18: '<:d20_18:1303408374628749322>',
    19: '<:d20_19:1303408403883753492>',
    20: '<:d20_20:1303410979324825733>'
}


def format_d20_discord(rolls, target_number, crit_range, total_successes, complications):
    """Turns a raw d20 roll result into the (emoji_chunks, result_text) pair
    a Discord message pair is built from."""
    emoji_string = ''.join(d20_emojis[roll] for roll in rolls)

    # Split the emoji string into chunks of a reasonable length
    chunk_size = 2000  # Discord's message character limit is 2000
    emoji_chunks = [emoji_string[i:i + chunk_size] for i in range(0, len(emoji_string), chunk_size)]

    def format_roll(roll):
        if roll <= crit_range:
            return f"**__{roll}__**"  # crit success: bold + underlined
        if roll <= target_number:
            return f"**{roll}**"  # regular success: bold
        return str(roll)

    formatted_rolls = ", ".join(format_roll(roll) for roll in rolls)
    result_text = f"**Rolls:** [{formatted_rolls}]\n**Total Successes:** {total_successes}"
    if complications > 0:
        result_text += f"\n**Complications:** {complications}"

    return emoji_chunks, result_text


# Challenge Dice faces: a d6 roll maps to one of these outcomes.
CD_FACE_EMOJIS = {
    'success': '<:CD_1:1303632314026299432>',
    'double_success': '<:CD_2:1303632332091031667>',
    'blank': '<:CD_blank:1303632288688508959>',
    'effect': '<:CD_effect:1303632363275812904>',
}


def classify_challenge_die(roll):
    if roll == 1:
        return 'success'
    elif roll == 2:
        return 'double_success'
    elif roll in (3, 4):
        return 'blank'
    else:
        return 'effect'


def roll_challenge_faces(num_dice):
    rolls = roll_dice(6, num_dice)
    faces = [classify_challenge_die(roll) for roll in rolls]

    # Count outcomes from the face names, not from the rendered emoji text.
    successes = faces.count('success') + 2 * faces.count('double_success')
    effects = faces.count('effect')
    blanks = faces.count('blank')
    total_successes = successes + effects

    return faces, total_successes, effects, blanks


def perform_challenge_roll(num_dice):
    """Validates and rolls Challenge Dice. Raises AscensionError on bad input."""
    if not 1 <= num_dice <= MAX_DICE:
        raise AscensionError(f"Number of dice must be between 1 and {MAX_DICE}.")
    return roll_challenge_faces(num_dice)


def format_challenge_discord(faces, total_successes, effects, blanks):
    """Turns a raw Challenge Dice result into the (symbols, result_text) pair
    a Discord message pair is built from."""
    symbols = ''.join(CD_FACE_EMOJIS[face] for face in faces)
    result_text = f"**Result:** {total_successes}\n**Effects:** {effects}\n**Blanks:** {blanks}"
    return symbols, result_text


# ---------------------------------------------------------------------------
# Momentum / Threat pools
# ---------------------------------------------------------------------------

def parse_signed_amount(args):
    """Parses an add/subtract amount, allowing a space between the sign and
    the number (e.g. '!m + 3') as well as no space (e.g. '!m +3')."""
    if len(args) == 2 and args[0] in ("+", "-"):
        return int(args[0] + args[1])
    return int(args[0])


def get_momentum(server_id):
    return momentum_pool.get(server_id, 0)


def set_momentum(server_id, amount):
    if not 0 <= amount <= MOMENTUM_MAX:
        raise AscensionError(f"Momentum must be between 0 and {MOMENTUM_MAX}.")
    momentum_pool[server_id] = amount
    return amount


def adjust_momentum(server_id, delta):
    new_value = get_momentum(server_id) + delta
    if not 0 <= new_value <= MOMENTUM_MAX:
        raise AscensionError(f"Momentum must be between 0 and {MOMENTUM_MAX}.")
    momentum_pool[server_id] = new_value
    return new_value


def momentum_emoji_string(server_id):
    return '<:momentum:1303392608013258833>' * get_momentum(server_id)


def get_threat(server_id):
    return threat_pool.get(server_id, 0)


def set_threat(server_id, amount):
    if not 0 <= amount <= THREAT_SAFETY_CAP:
        raise AscensionError(f"Threat must be between 0 and {THREAT_SAFETY_CAP}.")
    threat_pool[server_id] = amount
    return amount


def adjust_threat(server_id, delta):
    new_value = get_threat(server_id) + delta
    if not 0 <= new_value <= THREAT_SAFETY_CAP:
        raise AscensionError(f"Threat must be between 0 and {THREAT_SAFETY_CAP}.")
    threat_pool[server_id] = new_value
    return new_value


def threat_emoji_string(server_id):
    return '<:threat:1303392625910485063>' * get_threat(server_id)
