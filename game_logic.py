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

# Safety caps on dice count so a bad/huge input can't spam dozens of messages.
# Challenge Dice gets a higher cap than d20 since its emoji tags are shorter,
# so even 50 of them stays comfortably under Discord's message length limit.
MAX_D20_DICE = 20
MAX_CD_DICE = 50

# Global dictionaries to keep track of momentum and threat for each server
momentum_pool = {}
threat_pool = {}

# Tracks each guild's most recent d20 check's total_successes, for the "con"
# (contested check) notation: !d20 ... con rolls with Difficulty set to
# whatever the immediately previous check in that guild rolled, so a
# defender's plain check can be followed by an attacker's contested one.
# Updated after every d20 roll (Discord or an announced Owlbear one),
# regardless of whether that roll itself used a Difficulty/con.
last_d20_successes = {}


def record_last_d20_successes(server_id, total_successes):
    last_d20_successes[server_id] = total_successes


def get_last_d20_successes(server_id):
    return last_d20_successes.get(server_id)


class AscensionError(Exception):
    """A user-facing validation failure (bad roll/pool input). Any front end
    -- a Discord command, an Owlbear HTTP endpoint -- can catch this and show
    str(error) to the user without knowing the internals."""


# ---------------------------------------------------------------------------
# Dice rolling
# ---------------------------------------------------------------------------

def roll_dice(sides, num_dice):
    return [random.randint(1, sides) for _ in range(num_dice)]


def roll_d20(target_number, crit_range, num_dice, difficulty=None, modifier=0):
    rolls = roll_dice(20, num_dice)
    successes = sum(1 for roll in rolls if roll <= target_number)
    crit_successes = sum(1 for roll in rolls if roll <= crit_range)
    complications = sum(1 for roll in rolls if roll == 20)
    total_successes = successes + crit_successes

    # A flat +X/-X adjustment to the dice-derived total (see !d20's "+X"/"-X"
    # notation) -- applied before Difficulty, since Difficulty compares
    # against the roll's *final* success count. Clamped at 0 since a
    # negative success count isn't meaningful.
    if modifier:
        total_successes = max(0, total_successes + modifier)

    # Difficulty is the number of successes a task needs to succeed at all;
    # extra successes are whatever's earned beyond that, 0 if the roll
    # succeeded exactly at difficulty or failed outright.
    task_success = None
    extra_successes = None
    if difficulty is not None:
        task_success = total_successes >= difficulty
        extra_successes = total_successes - difficulty if total_successes > difficulty else 0

    return rolls, total_successes, complications, task_success, extra_successes


def perform_d20_roll(target_number, crit_range, num_dice, difficulty=None, modifier=0):
    """Validates and rolls d20s. Raises AscensionError on bad input. difficulty
    is optional -- omitting it (None) leaves task_success/extra_successes as
    None too, unchanged from the pre-Difficulty behavior. modifier is a flat
    +X/-X applied to the final success count, 0 (no change) by default."""
    if not 1 <= num_dice <= MAX_D20_DICE:
        raise AscensionError(f"Number of dice must be between 1 and {MAX_D20_DICE}.")
    if difficulty is not None and difficulty < 0:
        raise AscensionError("Difficulty must be zero or greater.")
    return roll_d20(target_number, crit_range, num_dice, difficulty, modifier)


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


def format_d20_discord(rolls, target_number, crit_range, total_successes, complications,
                        task_success=None, extra_successes=None, modifier=0):
    """Turns a raw d20 roll result into the (emoji_chunks, result_text) pair
    a Discord message pair is built from. task_success/extra_successes are
    only reported when a Difficulty was given for the roll (see
    roll_d20/perform_d20_roll) -- omitted (None), the output is identical to
    before Difficulty existed. modifier is purely for display here -- the
    caller has already applied it to total_successes; passing it through
    just lets the message show that a +X/-X was involved."""
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
    result_text = (
        f"**Target:** {target_number}, **Crit Range:** {crit_range}\n"
        f"**Rolls:** [{formatted_rolls}]\n**Total Successes:** {total_successes}"
    )
    if modifier:
        result_text += f"\n**Modifier:** {modifier:+d}"
    if complications > 0:
        result_text += f"\n**Complications:** {complications}"
    if task_success is not None:
        result_text += f"\n**Task Success:** {'Yes' if task_success else 'No'}"
        if extra_successes:
            result_text += f"\n**Extra Successes:** {extra_successes}"

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
    if not 1 <= num_dice <= MAX_CD_DICE:
        raise AscensionError(f"Number of dice must be between 1 and {MAX_CD_DICE}.")
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
