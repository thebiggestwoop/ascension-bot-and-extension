// Pure game-logic core for the Ascension dice system: dice rolling,
// Challenge Dice, and Momentum/Threat pool math -- a hand-maintained JS port
// of game_logic.py's rolling/validation rules (no build step, no automatic
// sync -- any future rule change must be applied to both files by hand).
//
// Unlike game_logic.py's guild-keyed momentum_pool/threat_pool dicts, the
// browser only ever has one room's pool values in scope at a time, so the
// pool helpers here are stateless (current value in, new value out) rather
// than keyed dictionaries.

export class AscensionError extends Error {}

// Momentum is capped at 6 by game rules. Threat has no in-game cap (that's
// an intentional difference between the two currencies), but it's still
// bounded here as a safety limit against typos/spam -- mirrors
// game_logic.py exactly.
export const MOMENTUM_MAX = 6;
export const THREAT_SAFETY_CAP = 50;

// Safety caps on dice count so a bad/huge input can't spam dozens of
// messages/broadcasts.
export const MAX_D20_DICE = 20;
export const MAX_CD_DICE = 50;

function rollDice(sides, numDice) {
  const rolls = [];
  for (let i = 0; i < numDice; i++) {
    rolls.push(Math.floor(Math.random() * sides) + 1);
  }
  return rolls;
}

function rollD20(targetNumber, critRange, numDice, difficulty, modifier) {
  const rolls = rollDice(20, numDice);
  const successes = rolls.filter((roll) => roll <= targetNumber).length;
  const critSuccesses = rolls.filter((roll) => roll <= critRange).length;
  const complications = rolls.filter((roll) => roll === 20).length;
  let totalSuccesses = successes + critSuccesses;

  // A flat +X/-X adjustment to the dice-derived total -- applied before
  // Difficulty, since Difficulty compares against the roll's *final*
  // success count. Clamped at 0 since a negative success count isn't
  // meaningful.
  if (modifier) {
    totalSuccesses = Math.max(0, totalSuccesses + modifier);
  }

  // Difficulty is the number of successes a task needs to succeed at all;
  // extra successes are whatever's earned beyond that, 0 if the roll
  // succeeded exactly at difficulty or failed outright.
  let taskSuccess = null;
  let extraSuccesses = null;
  if (difficulty !== null && difficulty !== undefined) {
    taskSuccess = totalSuccesses >= difficulty;
    extraSuccesses = totalSuccesses > difficulty ? totalSuccesses - difficulty : 0;
  }

  return { rolls, totalSuccesses, complications, taskSuccess, extraSuccesses };
}

export function performD20Roll(targetNumber, critRange, numDice, difficulty = null, modifier = 0) {
  if (!(numDice >= 1 && numDice <= MAX_D20_DICE)) {
    throw new AscensionError(`Number of dice must be between 1 and ${MAX_D20_DICE}.`);
  }
  if (difficulty !== null && difficulty !== undefined && difficulty < 0) {
    throw new AscensionError("Difficulty must be zero or greater.");
  }
  return rollD20(targetNumber, critRange, numDice, difficulty, modifier);
}

// Mirrors ascension_bot_dev.py's !d20 argument parsing exactly (target
// number, crit range, then any order of: a plain number for dice count,
// "dN" for Difficulty, "con" for a contested check, "+N"/"-N" for the
// success-count modifier) -- used so the Character Sheet's roll-syntax
// field can be typed/edited by hand and rolled the same way `!d20` would.
// conRequested is left for the caller to resolve (it needs session state --
// the last d20 roll's successes -- that this pure module doesn't have).
const CON_TOKEN_RE = /^con$/i;
const DIFFICULTY_TOKEN_RE = /^[dD](\d+)$/;
const MODIFIER_TOKEN_RE = /^[+-]\d+$/;

export function parseD20Expression(text) {
  const tokens = String(text).trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) {
    throw new AscensionError('Enter at least a target number and crit range (e.g. "10 2").');
  }

  const targetNumber = Number(tokens[0]);
  const critRange = Number(tokens[1]);
  if (!Number.isInteger(targetNumber) || !Number.isInteger(critRange)) {
    throw new AscensionError("Target number and crit range must be whole numbers.");
  }

  let numDice = 2;
  let difficulty = null;
  let modifier = 0;
  let conRequested = false;

  for (const token of tokens.slice(2)) {
    if (CON_TOKEN_RE.test(token)) {
      conRequested = true;
      continue;
    }
    const difficultyMatch = DIFFICULTY_TOKEN_RE.exec(token);
    if (difficultyMatch) {
      difficulty = Number(difficultyMatch[1]);
      continue;
    }
    if (MODIFIER_TOKEN_RE.test(token)) {
      modifier = Number(token);
      continue;
    }
    const dice = Number(token);
    if (!Number.isInteger(dice)) {
      throw new AscensionError(`Unrecognized argument: "${token}".`);
    }
    numDice = dice;
  }

  if (conRequested && difficulty !== null) {
    throw new AscensionError("Can't combine dN and con -- use one or the other.");
  }

  return { targetNumber, critRange, numDice, difficulty, modifier, conRequested };
}

function classifyChallengeDie(roll) {
  if (roll === 1) return "success";
  if (roll === 2) return "double_success";
  if (roll === 3 || roll === 4) return "blank";
  return "effect";
}

function rollChallengeFaces(numDice) {
  const rolls = rollDice(6, numDice);
  const faces = rolls.map(classifyChallengeDie);

  const successCount = faces.filter((f) => f === "success").length;
  const doubleSuccessCount = faces.filter((f) => f === "double_success").length;
  const effects = faces.filter((f) => f === "effect").length;
  const blanks = faces.filter((f) => f === "blank").length;
  const successes = successCount + 2 * doubleSuccessCount;
  const totalSuccesses = successes + effects;

  return { faces, totalSuccesses, effects, blanks };
}

export function performChallengeRoll(numDice) {
  if (!(numDice >= 1 && numDice <= MAX_CD_DICE)) {
    throw new AscensionError(`Number of dice must be between 1 and ${MAX_CD_DICE}.`);
  }
  return rollChallengeFaces(numDice);
}

// ---------------------------------------------------------------------------
// Momentum / Threat pools -- local-only variants for use while unpaired (see
// docs/app.js's poolsRemote()). Stateless: current value in, new value out,
// same clamping rules as game_logic.py's set_momentum/adjust_momentum.
// ---------------------------------------------------------------------------

export function setMomentumLocal(amount) {
  if (!(amount >= 0 && amount <= MOMENTUM_MAX)) {
    throw new AscensionError(`Momentum must be between 0 and ${MOMENTUM_MAX}.`);
  }
  return amount;
}

export function adjustMomentumLocal(current, delta) {
  const newValue = current + delta;
  if (!(newValue >= 0 && newValue <= MOMENTUM_MAX)) {
    throw new AscensionError(`Momentum must be between 0 and ${MOMENTUM_MAX}.`);
  }
  return newValue;
}

export function setThreatLocal(amount) {
  if (!(amount >= 0 && amount <= THREAT_SAFETY_CAP)) {
    throw new AscensionError(`Threat must be between 0 and ${THREAT_SAFETY_CAP}.`);
  }
  return amount;
}

export function adjustThreatLocal(current, delta) {
  const newValue = current + delta;
  if (!(newValue >= 0 && newValue <= THREAT_SAFETY_CAP)) {
    throw new AscensionError(`Threat must be between 0 and ${THREAT_SAFETY_CAP}.`);
  }
  return newValue;
}
