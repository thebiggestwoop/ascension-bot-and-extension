import OBR from "https://esm.sh/@owlbear-rodeo/sdk@3.1.0";
import * as diceLogic from "./diceLogic.js";

// The bot now lives at a stable address, so this is baked in rather than
// something each player has to paste into Settings.
const BACKEND_URL = "https://bot.heruv.uk";

// Everyone in the same Owlbear room shares this key via OBR.room metadata,
// so only one player has to paste the pairing code -- Owlbear replicates
// room metadata to every connected client automatically.
const METADATA_KEY = "com.ascension.owlbear-extension/pairing-code";
// Every roll made in this extension (paired or not) is broadcast on this
// channel so everyone else in the same Owlbear room sees it live, with no
// server involved.
const ROLL_CHANNEL = "com.ascension.owlbear-extension/roll";
// Momentum/Threat, synced via room metadata (like the pairing code) ONLY
// while unpaired -- see poolsRemote() below. While paired, the bot's own
// game_logic.py dicts stay authoritative instead, since Discord's !m/!t
// commands need to reach the same values and have no way to touch Owlbear
// room metadata directly.
const MOMENTUM_METADATA_KEY = "com.ascension.owlbear-extension/momentum";
const THREAT_METADATA_KEY = "com.ascension.owlbear-extension/threat";
// Per-browser master switch for the whole Discord integration -- off means
// no announce attempts and no polling, same rolling/pool behavior either
// way. Defaults on so an already-linked room's existing pairing code keeps
// working after this setting was introduced.
const PAIR_DISCORD_STORAGE_KEY = "ascension-owlbear-extension-pair-discord";
const MAX_HISTORY_ENTRIES = 20;
const POLL_INTERVAL_MS = 2500;

// User-editable accent colors (Settings) -- these are just the extension's
// own existing default hues, made overridable per-browser. Applied as
// inline custom-property overrides on the root element (see
// loadAccentColorSetting() below), so a saved color wins over the
// stylesheet's :root default in both light and dark mode without touching
// CSS -- same approach the sibling Lancer extension uses for its own
// editable accent colors.
const DEFAULT_ACCENT = "#361887";
const DEFAULT_ACCENT_2 = "#867220";
const ACCENT_COLOR_STORAGE_KEY = "ascension-owlbear-extension-accent-color";
const ACCENT_COLOR_2_STORAGE_KEY = "ascension-owlbear-extension-accent-color-2";
const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;

const els = {
  settingsGmNotice: document.getElementById("settings-gm-notice"),
  settingsControls: document.getElementById("settings-controls"),
  pairDiscordSetting: document.getElementById("pair-discord-setting"),
  pairingCode: document.getElementById("pairing-code"),
  saveSettings: document.getElementById("save-settings"),
  settingsStatus: document.getElementById("settings-status"),
  globalStatus: document.getElementById("global-status"),
  accentColorSetting: document.getElementById("accent-color-setting"),
  accentColor2Setting: document.getElementById("accent-color-2-setting"),
  resetColorsBtn: document.getElementById("reset-colors-btn"),
  exportSettingsBtn: document.getElementById("export-settings-btn"),
  importSettingsBtn: document.getElementById("import-settings-btn"),
  importSettingsFile: document.getElementById("import-settings-file"),

  rollHistory: document.getElementById("roll-history"),

  characterSheetFocus: document.getElementById("char-sheet-focus"),
  charSheetNumDice: document.getElementById("char-sheet-num-dice"),
  charSheetDifficulty: document.getElementById("char-sheet-difficulty"),
  charSheetContested: document.getElementById("char-sheet-contested"),
  charSheetModifier: document.getElementById("char-sheet-modifier"),
  charSheetTarget: document.getElementById("char-sheet-target"),
  charSheetCrit: document.getElementById("char-sheet-crit"),
  charSheetSyntax: document.getElementById("char-sheet-syntax"),
  charSheetRollBtn: document.getElementById("char-sheet-roll-btn"),
  charSheetResetBtn: document.getElementById("char-sheet-reset-btn"),
  taskResult: document.getElementById("task-result"),

  cdNumDice: document.getElementById("cd-num-dice"),
  cdNumDiceAdd: document.getElementById("cd-num-dice-add"),
  cdNumDiceMinus: document.getElementById("cd-num-dice-minus"),
  cdRollBtn: document.getElementById("cd-roll-btn"),
  cdRerollBlanksBtn: document.getElementById("cd-reroll-blanks-btn"),
  cdResetBtn: document.getElementById("cd-reset-btn"),
  cdResult: document.getElementById("cd-result"),

  momentumValue: document.getElementById("momentum-value"),
  momentumIcons: document.getElementById("momentum-icons"),
  momentumStageMinus: document.getElementById("momentum-stage-minus"),
  momentumPending: document.getElementById("momentum-pending"),
  momentumStagePlus: document.getElementById("momentum-stage-plus"),
  momentumApplyBtn: document.getElementById("momentum-apply-btn"),
  momentumSetInput: document.getElementById("momentum-set-input"),
  momentumSetBtn: document.getElementById("momentum-set-btn"),

  threatValue: document.getElementById("threat-value"),
  threatIcons: document.getElementById("threat-icons"),
  threatGmNotice: document.getElementById("threat-gm-notice"),
  threatControls: document.getElementById("threat-controls"),
  threatStageMinus: document.getElementById("threat-stage-minus"),
  threatPending: document.getElementById("threat-pending"),
  threatStagePlus: document.getElementById("threat-stage-plus"),
  threatApplyBtn: document.getElementById("threat-apply-btn"),
  threatSetInput: document.getElementById("threat-set-input"),
  threatSetBtn: document.getElementById("threat-set-btn"),
};

// Clamps to the input's min/max attributes when present (read via
// getAttribute rather than the .min/.max IDL properties, since those only
// "apply" to type="number" -- some fields using this stepper, like the
// signed Complication/Advantage field, are type="text" so they can display
// an explicit "+"/"-" sign, which a native number input can't hold as its
// .value at all).
function clampStepperValue(input, value) {
  const min = input.getAttribute("min");
  const max = input.getAttribute("max");
  let clamped = value;
  if (min !== null) {
    clamped = Math.max(Number(min), clamped);
  }
  if (max !== null) {
    clamped = Math.min(Number(max), clamped);
  }
  return clamped;
}

// Native number-input spinners look like unstyled browser chrome next to
// the rest of the themed UI (they're hidden entirely via CSS), so every
// number field gets this small custom up/down stepper instead. Applied
// generically to all of them rather than duplicating markup per field --
// moving an <input> into a new wrapper doesn't invalidate any existing
// references to it (e.g. the ones in `els` above), so ordering doesn't matter.
// Fields with a "signed-number" class (e.g. Complication/Advantage) always
// display an explicit sign ("+2", "-3", "+0") -- reused from Momentum/
// Threat's own formatSigned() below.
function attachStepper(input) {
  const wrapper = document.createElement("span");
  wrapper.className = "number-input";
  input.parentNode.insertBefore(wrapper, input);
  wrapper.appendChild(input);

  const isSigned = input.classList.contains("signed-number");
  const applyValue = (value) => {
    input.value = isSigned ? formatSigned(value) : String(value);
  };

  const stepper = document.createElement("span");
  stepper.className = "number-stepper";

  const makeStepButton = (label, delta) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "stepper-btn";
    btn.textContent = label;
    btn.setAttribute("aria-label", delta > 0 ? "Increase" : "Decrease");
    btn.addEventListener("click", () => {
      applyValue(clampStepperValue(input, (Number(input.value) || 0) + delta));
      // Setting .value directly doesn't fire "change" on its own -- dispatch
      // it so anything listening for edits to this field (e.g. the
      // Character Sheet's roll-syntax preview) picks up stepper clicks too,
      // not just typed edits.
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    return btn;
  };

  stepper.appendChild(makeStepButton("▲", 1));
  stepper.appendChild(makeStepButton("▼", -1));
  wrapper.appendChild(stepper);

  // Clamps/reformats manually-typed values too (fires on blur), not just
  // stepper clicks.
  input.addEventListener("change", () => {
    applyValue(clampStepperValue(input, Number(input.value) || 0));
  });
}

// Character Sheet values are rarely adjusted (typed in once, then reused
// roll after roll), so the +/- rocker is just clutter there -- skip those.
document.querySelectorAll('input[type="number"]:not(.char-stat-value), input.signed-number').forEach(attachStepper);

let pairingCode = "";
let playerName = "Someone";
let isGM = false;
let momentumPending = 0;
let threatPending = 0;
let lastSeq = 0;
let pollTimer = null;
let currentMomentum = 0;
let currentThreat = 0;

// The last d20 check's total_successes seen in this room, from ANY source
// (a local roll, a broadcast-received one, or a polled Discord one) -- used
// to resolve the "Con" (contested check) option below. null until at least
// one d20 roll has been seen this session; Challenge Dice rolls don't
// affect it.
let lastD20TotalSuccesses = null;

// The last Challenge Dice roll's blank count seen in this room, from ANY
// source -- used by "Reroll Blanks" below. null until at least one
// challenge_roll has been seen this session; d20 rolls don't affect it.
let lastCdBlanks = null;

// Per-browser master switch for the Discord integration (see
// PAIR_DISCORD_STORAGE_KEY above) -- separate from just having a pairing
// code typed in, so a player can opt out of an already-linked room's
// Discord relay without clearing the shared code for everyone else.
let pairingEnabled = true;

// Set once a poll of /updates actually succeeds against the current
// pairing code -- distinct from just having *a* code present, which could
// be stale, mistyped, or for a bot that's since restarted. Reset to false
// any time polling (re)starts.
let pairingVerified = false;

function loadPairDiscordSetting() {
  const stored = localStorage.getItem(PAIR_DISCORD_STORAGE_KEY);
  pairingEnabled = stored === null ? true : stored === "true";
  els.pairDiscordSetting.checked = pairingEnabled;
}

// Rolling and pool tracking both work standalone -- whether Momentum/Threat
// are currently bot-authoritative (paired) or room-metadata-authoritative
// (unpaired) is the only thing this toggles.
function poolsRemote() {
  return pairingEnabled && Boolean(pairingCode);
}

function setStatus(el, message, isError) {
  el.textContent = message;
  el.classList.toggle("error", Boolean(isError));
}

function applyConfigToInputs() {
  els.pairingCode.value = pairingCode || "";
  els.pairingCode.disabled = !pairingEnabled;
  els.saveSettings.disabled = !pairingEnabled;

  if (!pairingEnabled) {
    setStatus(els.settingsStatus, "Discord pairing is turned off -- rolling and pools stay local only.", false);
    return;
  }
  if (!pairingCode) {
    setStatus(els.settingsStatus, "Not linked -- rolling and pools stay local only.", false);
    return;
  }
  setStatus(
    els.settingsStatus,
    pairingVerified ? "Linked -- rolls and pool changes also post to Discord." : "Checking Discord link...",
    false,
  );
}

function updateThreatVisibility() {
  els.threatControls.hidden = !isGM;
  els.threatGmNotice.hidden = isGM;
}

function updateSettingsVisibility() {
  els.settingsControls.hidden = !isGM;
  els.settingsGmNotice.hidden = isGM;
}

function formatSigned(value) {
  return value >= 0 ? `+${value}` : `${value}`;
}

function renderPending() {
  els.momentumPending.textContent = formatSigned(momentumPending);
  els.threatPending.textContent = formatSigned(threatPending);
}

function renderPoolIcons(container, iconSrc, count) {
  const icons = [];
  for (let i = 0; i < count; i++) {
    const img = document.createElement("img");
    img.src = iconSrc;
    img.alt = "";
    img.className = "pool-icon";
    icons.push(img);
  }
  container.replaceChildren(...icons);
}

function setMomentumValue(value) {
  currentMomentum = value;
  els.momentumValue.textContent = value;
  renderPoolIcons(els.momentumIcons, "icons/momentum.png", value);
}

function setThreatValue(value) {
  currentThreat = value;
  els.threatValue.textContent = value;
  renderPoolIcons(els.threatIcons, "icons/threat.png", value);
}

// Builds "[3, 14, 20]" as DOM nodes (not an HTML string) so nothing in
// `rolls` can ever be interpreted as markup. Matches the bot's own text
// formatting: crit successes bold+underlined, plain successes bold.
function buildRollsFragment(rolls, targetNumber, critRange) {
  const frag = document.createDocumentFragment();
  frag.appendChild(document.createTextNode("["));
  rolls.forEach((roll, i) => {
    if (i > 0) {
      frag.appendChild(document.createTextNode(", "));
    }
    if (roll <= critRange) {
      const strong = document.createElement("strong");
      strong.style.textDecoration = "underline";
      strong.textContent = String(roll);
      frag.appendChild(strong);
    } else if (roll <= targetNumber) {
      const strong = document.createElement("strong");
      strong.textContent = String(roll);
      frag.appendChild(strong);
    } else {
      frag.appendChild(document.createTextNode(String(roll)));
    }
  });
  frag.appendChild(document.createTextNode("]"));
  return frag;
}

function pluralize(count, word) {
  const suffix = /[sxz]$|[cs]h$/i.test(word) ? "es" : "s";
  return `${count} ${word}${count === 1 ? "" : suffix}`;
}

// Same face art the Discord bot posts as custom emoji, reused here as icons.
const CD_FACE_ICONS = {
  success: "icons/CD_1.png",
  double_success: "icons/CD_2.png",
  blank: "icons/CD_blank.png",
  effect: "icons/CD_effect.png",
};

const D20_ICONS = Object.fromEntries(
  Array.from({ length: 20 }, (_, i) => [i + 1, `icons/d20_${i + 1}.png`])
);

function buildIconRow(values, iconMap) {
  const row = document.createElement("div");
  row.className = "dice-faces";
  values.forEach((value) => {
    const src = iconMap[value];
    if (!src) {
      return;
    }
    const img = document.createElement("img");
    img.src = src;
    img.alt = String(value);
    img.className = "dice-face-icon";
    row.appendChild(img);
  });
  return row;
}

// A small bordered highlight box for a roll's key outcome (mirrors the
// sibling Lancer extension's roll-total-line treatment) -- `stakes` picks
// the secondary accent border, used for a Difficulty/Con result (which
// carries more "on the line" weight than the plain success count).
function buildOutcomeBox(text, stakes) {
  const box = document.createElement("span");
  box.className = stakes ? "roll-outcome-box roll-outcome-stakes" : "roll-outcome-box";
  box.textContent = text;
  return box;
}

// Builds just the dice-icon row + "[rolls] -> outcome" line for a d20 roll --
// shared by describeRoll() below (which prefixes it with a Target/Crit meta
// line for the main Roll History card) and the Task card's own "Result"
// viewer (updateTaskResult(), which shows only this and nothing else -- no
// actor/time, no title, no Target/Crit line).
function buildD20RollSummary(event) {
  const container = document.createElement("div");
  if (Array.isArray(event.rolls)) {
    container.appendChild(buildIconRow(event.rolls, D20_ICONS));
  }
  const line = document.createElement("span");
  line.appendChild(buildRollsFragment(event.rolls, event.target_number, event.crit_range));
  line.appendChild(document.createTextNode(" -> "));

  let baseOutcome = pluralize(event.total_successes, "success");
  if (event.modifier) {
    baseOutcome += ` (modifier ${event.modifier >= 0 ? "+" : ""}${event.modifier})`;
  }
  if (event.complications > 0) {
    baseOutcome += `, ${pluralize(event.complications, "complication")}`;
  }
  line.appendChild(buildOutcomeBox(baseOutcome));

  if (event.difficulty !== undefined && event.difficulty !== null) {
    let stakesOutcome = event.task_success ? `success (Difficulty ${event.difficulty})` : `failure (Difficulty ${event.difficulty})`;
    if (event.extra_successes > 0) {
      stakesOutcome += `, ${pluralize(event.extra_successes, "extra success")}`;
    }
    line.appendChild(document.createTextNode(" "));
    line.appendChild(buildOutcomeBox(stakesOutcome, true));
  }
  container.appendChild(line);
  return container;
}

// Same idea for Challenge Dice -- shared by describeRoll() (prefix "CD -> ",
// to tell it apart from d20 rolls in the mixed Roll History feed) and the
// Challenge Dice card's own "Result" viewer (updateCdResult(), no prefix
// needed since that card only ever shows CD rolls).
function buildChallengeRollSummary(event, prefix) {
  const container = document.createElement("div");
  if (Array.isArray(event.faces)) {
    container.appendChild(buildIconRow(event.faces, CD_FACE_ICONS));
  }
  const line = document.createElement("span");
  if (prefix) {
    line.appendChild(document.createTextNode(prefix));
  }
  line.appendChild(
    buildOutcomeBox(
      `${event.total_successes} total, ${pluralize(event.effects, "effect")}, ${pluralize(event.blanks, "blank")}`,
    ),
  );
  container.appendChild(line);
  return container;
}

// Returns { actor, sourceTag, node } describing a roll event as safe DOM
// nodes, or null if the event isn't a roll (e.g. a pool change).
function describeRoll(event) {
  const sourceTag = event.source === "discord" ? "Discord" : "Owlbear";

  if (event.type === "d20_roll") {
    const container = document.createElement("div");
    const targetCritLine = document.createElement("div");
    targetCritLine.textContent = `Target ${event.target_number}, Crit Range ${event.crit_range}`;
    container.appendChild(targetCritLine);
    container.appendChild(buildD20RollSummary(event));
    return { actor: event.actor, sourceTag, node: container };
  }

  if (event.type === "challenge_roll") {
    const container = buildChallengeRollSummary(event, "CD -> ");
    return { actor: event.actor, sourceTag, node: container };
  }

  return null;
}

// event.timestamp is Unix epoch seconds (set server-side by event_bus.py).
// Rendering it here, client-side, means each viewer sees it in their own
// local timezone -- the same approach Discord itself uses for messages.
function formatRollTime(epochSeconds) {
  return new Date(epochSeconds * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function addHistoryEntry(event) {
  if (event.type === "d20_roll" && typeof event.total_successes === "number") {
    lastD20TotalSuccesses = event.total_successes;
    updateCharSheetContestedPreview();
  }
  if (event.type === "challenge_roll" && typeof event.blanks === "number") {
    lastCdBlanks = event.blanks;
  }

  const described = describeRoll(event);
  if (!described) {
    return;
  }

  const li = document.createElement("li");

  const line1 = document.createElement("div");
  const actorEl = document.createElement("strong");
  actorEl.textContent = described.actor;
  line1.appendChild(actorEl);
  line1.appendChild(document.createTextNode(` (${described.sourceTag})`));
  if (typeof event.timestamp === "number") {
    const timeEl = document.createElement("span");
    timeEl.className = "roll-time";
    timeEl.textContent = ` ${formatRollTime(event.timestamp)}`;
    line1.appendChild(timeEl);
  }

  li.appendChild(line1);

  // Its own row, above the roll detail -- same idea (and class name) as the
  // sibling Lancer extension's roll-naming feature, but this title always
  // comes from the Attribute+Skill pair selected when Roll Task was
  // clicked, never hand-typed.
  if (event.title) {
    const titleEl = document.createElement("div");
    titleEl.className = "roll-title-line";
    titleEl.textContent = event.title;
    li.appendChild(titleEl);
  }

  li.appendChild(described.node);

  els.rollHistory.appendChild(li);
  while (els.rollHistory.children.length > MAX_HISTORY_ENTRIES) {
    els.rollHistory.removeChild(els.rollHistory.firstChild);
  }
  els.rollHistory.scrollTop = els.rollHistory.scrollHeight;
}

async function pollUpdates() {
  if (!poolsRemote()) {
    return;
  }
  try {
    const data = await requestJson(`/api/${pairingCode}/updates?since=${lastSeq}`);
    pairingVerified = true;
    setMomentumValue(data.momentum);
    setThreatValue(data.threat);
    for (const event of data.events) {
      if (event.type === "d20_roll" || event.type === "challenge_roll") {
        addHistoryEntry(event);
      }
    }
    lastSeq = data.seq;
    applyConfigToInputs();
  } catch (err) {
    // Non-fatal -- just try again on the next tick.
  }
}

function startPolling() {
  stopPolling();
  lastSeq = 0;
  pairingVerified = false;
  if (!poolsRemote()) {
    return;
  }
  pollUpdates();
  pollTimer = setInterval(pollUpdates, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function loadPairingCodeFromRoom() {
  const metadata = await OBR.room.getMetadata();
  const stored = metadata[METADATA_KEY];
  if (stored) {
    pairingCode = stored;
  }
  applyConfigToInputs();
}

// Called right before switching from bot-authoritative pools to local/
// metadata-authoritative ones (pairing code cleared, or the "Pair with
// Discord" toggle flipped off) -- writes whatever's currently displayed
// into room metadata once, so Momentum/Threat carry over instead of
// jarringly resetting to 0.
async function freezeCurrentPoolsToMetadata() {
  await OBR.room.setMetadata({
    [MOMENTUM_METADATA_KEY]: currentMomentum,
    [THREAT_METADATA_KEY]: currentThreat,
  });
}

async function savePairingCode() {
  const wasRemote = poolsRemote();
  pairingCode = els.pairingCode.value.trim();
  await OBR.room.setMetadata({ [METADATA_KEY]: pairingCode });
  if (wasRemote && !poolsRemote()) {
    await freezeCurrentPoolsToMetadata();
  }
  applyConfigToInputs();
  startPolling();
}

els.pairDiscordSetting.addEventListener("change", async () => {
  const wasRemote = poolsRemote();
  pairingEnabled = els.pairDiscordSetting.checked;
  localStorage.setItem(PAIR_DISCORD_STORAGE_KEY, String(pairingEnabled));
  if (wasRemote && !poolsRemote()) {
    await freezeCurrentPoolsToMetadata();
  }
  applyConfigToInputs();
  startPolling();
});

function apiUrl(path) {
  return `${BACKEND_URL}${path}`;
}

async function requestJson(path, options) {
  if (!pairingCode) {
    throw new Error("Not linked yet -- enter the pairing code first.");
  }
  const response = await fetch(apiUrl(path), options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Request failed (${response.status}).`);
  }
  return data;
}

function postJson(path, body) {
  return requestJson(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// fn's return value (if truthy) is shown as a non-error status message --
// used for soft warnings (e.g. "rolled, but couldn't post to Discord")
// where the action itself already succeeded and shouldn't look like a
// failure, just an FYI.
function withBusy(button, fn) {
  return async () => {
    button.disabled = true;
    try {
      const warning = await fn();
      setStatus(els.globalStatus, warning || "", Boolean(warning));
    } catch (err) {
      setStatus(els.globalStatus, err.message, true);
    } finally {
      button.disabled = false;
    }
  };
}

els.saveSettings.addEventListener("click", withBusy(els.saveSettings, savePairingCode));

// A per-player local preference (not synced to the room or bot) -- applied
// unconditionally at module load below, not gated behind OBR.onReady/init(),
// since it doesn't depend on any Owlbear state.
function loadAccentColorSetting() {
  const stored = localStorage.getItem(ACCENT_COLOR_STORAGE_KEY);
  const hex = stored && HEX_COLOR_RE.test(stored) ? stored : DEFAULT_ACCENT;
  els.accentColorSetting.value = hex;
  document.documentElement.style.setProperty("--accent", hex);
}

function loadAccentColor2Setting() {
  const stored = localStorage.getItem(ACCENT_COLOR_2_STORAGE_KEY);
  const hex = stored && HEX_COLOR_RE.test(stored) ? stored : DEFAULT_ACCENT_2;
  els.accentColor2Setting.value = hex;
  document.documentElement.style.setProperty("--accent-2", hex);
}

els.accentColorSetting.addEventListener("change", () => {
  const hex = els.accentColorSetting.value.trim();
  if (!HEX_COLOR_RE.test(hex)) {
    setStatus(els.settingsStatus, "Accent color must be a hex code like #361887.", true);
    loadAccentColorSetting();
    return;
  }
  localStorage.setItem(ACCENT_COLOR_STORAGE_KEY, hex);
  document.documentElement.style.setProperty("--accent", hex);
});

els.accentColor2Setting.addEventListener("change", () => {
  const hex = els.accentColor2Setting.value.trim();
  if (!HEX_COLOR_RE.test(hex)) {
    setStatus(els.settingsStatus, "Accent color must be a hex code like #867220.", true);
    loadAccentColor2Setting();
    return;
  }
  localStorage.setItem(ACCENT_COLOR_2_STORAGE_KEY, hex);
  document.documentElement.style.setProperty("--accent-2", hex);
});

els.resetColorsBtn.addEventListener("click", () => {
  localStorage.removeItem(ACCENT_COLOR_STORAGE_KEY);
  localStorage.removeItem(ACCENT_COLOR_2_STORAGE_KEY);
  loadAccentColorSetting();
  loadAccentColor2Setting();
});

loadAccentColorSetting();
loadAccentColor2Setting();

// Export/Import Settings and Character Sheet -- same mechanism the sibling
// Lancer extension uses for its own Export/Import Settings (and Saved
// Rolls, which Ascension has no equivalent of; the Character Sheet's stat
// values take that role here instead). Deliberately excludes the Discord
// pairing code -- that's tied to a specific Discord channel (and lives in
// OBR.room.metadata, not localStorage), not a personal preference.
els.exportSettingsBtn.addEventListener(
  "click",
  withBusy(els.exportSettingsBtn, () => {
    const payload = {
      characterSheet: getCharacterSheetValues(),
      settings: {
        pairDiscord: els.pairDiscordSetting.checked,
        accentColor: els.accentColorSetting.value,
        accentColor2: els.accentColor2Setting.value,
      },
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "ascension-dice-settings.json";
    a.click();
    URL.revokeObjectURL(url);
  })
);

els.importSettingsBtn.addEventListener("click", () => {
  els.importSettingsFile.click();
});

// Not wrapped in withBusy -- that helper treats any truthy return as an
// *error*-styled status (Boolean(warning)), but a successful import needs a
// non-error confirmation message, so this manages disabled/status itself
// (same reason the sibling Lancer extension's own import handler does).
els.importSettingsFile.addEventListener("change", async () => {
  const file = els.importSettingsFile.files[0];
  els.importSettingsFile.value = "";
  if (!file) {
    return;
  }

  els.importSettingsBtn.disabled = true;
  try {
    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      throw new Error("That file isn't valid JSON.");
    }
    if (!parsed || typeof parsed !== "object") {
      throw new Error("That doesn't look like a settings file.");
    }

    const imported = [];

    if (parsed.characterSheet && typeof parsed.characterSheet === "object") {
      let appliedAnyStat = false;
      for (const row of charStatRows) {
        const value = parsed.characterSheet[row.dataset.key];
        if (typeof value === "number") {
          row.querySelector(".char-stat-value").value = value;
          appliedAnyStat = true;
        }
      }
      if (appliedAnyStat) {
        // Only the 13 stat values themselves change -- current
        // selection/Focus/Target/Crit are left as they were, though
        // Target/Crit are refreshed if a selection happens to be active
        // right now, since they'd otherwise silently go stale against the
        // new values.
        saveCharacterSheet();
        updateCharSheetTargetCritFromSelection();
        refreshCharSheetSyntax();
        imported.push("the character sheet");
      }
    }

    let importedSettingsCount = 0;
    const s = parsed.settings;
    if (s && typeof s === "object") {
      if (typeof s.pairDiscord === "boolean") {
        els.pairDiscordSetting.checked = s.pairDiscord;
        els.pairDiscordSetting.dispatchEvent(new Event("change"));
        importedSettingsCount++;
      }
      if (typeof s.accentColor === "string" && HEX_COLOR_RE.test(s.accentColor)) {
        localStorage.setItem(ACCENT_COLOR_STORAGE_KEY, s.accentColor);
        loadAccentColorSetting();
        importedSettingsCount++;
      }
      if (typeof s.accentColor2 === "string" && HEX_COLOR_RE.test(s.accentColor2)) {
        localStorage.setItem(ACCENT_COLOR_2_STORAGE_KEY, s.accentColor2);
        loadAccentColor2Setting();
        importedSettingsCount++;
      }
    }
    if (importedSettingsCount > 0) {
      imported.push(`${importedSettingsCount} setting(s)`);
    }

    if (imported.length === 0) {
      throw new Error("No character sheet or settings found in that file.");
    }
    setStatus(els.globalStatus, `Imported ${imported.join(" and ")}.`, false);
  } catch (err) {
    setStatus(els.globalStatus, err.message, true);
  } finally {
    els.importSettingsBtn.disabled = false;
  }
});

// Rolls locally via diceLogic.js (a JS port of game_logic.py), shows the
// result immediately, and shares it with the room. Owlbear-to-Owlbear sync
// is always broadcast, regardless of pairing; posting to Discord is a
// separate, optional step that never blocks or alters the roll itself.
// onLocalEvent (optional) fires with the constructed event right after it's
// added to Roll History -- the one hook point that only fires for a roll
// made locally in this browser (broadcast-received and Discord-polled
// rolls both call addHistoryEntry() directly, never this function). Used by
// the Task card's Roll Task button to feed its own mini "last roll" viewer,
// without Challenge Dice rolls (which don't pass this) affecting it.
async function performLocalRoll(type, fields, onLocalEvent) {
  const event = {
    type,
    source: "owlbear",
    actor: playerName,
    timestamp: Math.floor(Date.now() / 1000),
    ...fields,
  };
  addHistoryEntry(event);
  onLocalEvent?.(event);
  OBR.broadcast.sendMessage(ROLL_CHANNEL, event, { destination: "REMOTE" }).catch(() => {});

  if (!poolsRemote()) {
    return undefined;
  }
  try {
    await postJson(`/api/${pairingCode}/announce`, { ...fields, type, player_name: playerName });
    return undefined;
  } catch (err) {
    return `Rolled, but couldn't post to Discord: ${err.message}`;
  }
}

els.cdNumDiceAdd.addEventListener("click", () => {
  els.cdNumDice.value = (Number(els.cdNumDice.value) || 0) + 1;
});
els.cdNumDiceMinus.addEventListener("click", () => {
  els.cdNumDice.value = Math.max(0, (Number(els.cdNumDice.value) || 0) - 1);
});

// Shows the dice icons + outcome of the most recent Challenge Dice roll(s)
// made in THIS browser -- same idea as the Task card's updateTaskResult(),
// and passed the same way as performLocalRoll's onLocalEvent hook, so it
// never sees Task (d20) rolls, other players' broadcasted rolls, or
// Discord-typed rolls. A fresh Roll CD clears the box and starts over;
// Reroll Blanks (appendCdResult below) instead stacks onto whatever's
// already there, so a chain of rerolls stays visible together until the
// next non-reroll roll wipes it.
function updateCdResult(event) {
  if (event.type !== "challenge_roll") {
    return;
  }
  els.cdResult.replaceChildren(buildChallengeRollSummary(event));
}

function appendCdResult(event) {
  if (event.type !== "challenge_roll") {
    return;
  }
  els.cdResult.appendChild(buildChallengeRollSummary(event));
}

els.cdRollBtn.addEventListener(
  "click",
  withBusy(els.cdRollBtn, () => {
    const numDice = Number(els.cdNumDice.value);
    const { faces, totalSuccesses, effects, blanks } = diceLogic.performChallengeRoll(numDice);
    return performLocalRoll(
      "challenge_roll",
      {
        faces,
        total_successes: totalSuccesses,
        effects,
        blanks,
      },
      updateCdResult,
    );
  })
);

// Immediately rolls Challenge Dice equal to the blank count from the last
// Challenge Dice roll seen in this room -- doesn't touch the dice-count
// field, it just rolls that many right away.
els.cdRerollBlanksBtn.addEventListener(
  "click",
  withBusy(els.cdRerollBlanksBtn, () => {
    if (lastCdBlanks === null) {
      throw new Error("No previous Challenge Dice roll found.");
    }
    const { faces, totalSuccesses, effects, blanks } = diceLogic.performChallengeRoll(lastCdBlanks);
    return performLocalRoll(
      "challenge_roll",
      {
        faces,
        total_successes: totalSuccesses,
        effects,
        blanks,
      },
      appendCdResult,
    );
  })
);

els.cdResetBtn.addEventListener("click", () => {
  els.cdNumDice.value = "0";
});

// Momentum: +1/-1 only stage a pending delta locally; Apply sends it as one
// request (and one Discord message) instead of spamming one per click.
els.momentumStageMinus.addEventListener("click", () => {
  momentumPending -= 1;
  renderPending();
});
els.momentumStagePlus.addEventListener("click", () => {
  momentumPending += 1;
  renderPending();
});
els.momentumApplyBtn.addEventListener(
  "click",
  withBusy(els.momentumApplyBtn, async () => {
    if (momentumPending === 0) {
      return;
    }
    let newValue;
    if (poolsRemote()) {
      const result = await postJson(`/api/${pairingCode}/momentum`, {
        action: "adjust",
        amount: momentumPending,
        player_name: playerName,
      });
      newValue = result.momentum;
    } else {
      // Re-fetch metadata immediately before writing, rather than trusting
      // a stale locally-cached value, to shrink (not eliminate) the window
      // where two players adjusting at once could clobber each other --
      // room metadata replication is last-write-wins, not a merge.
      const metadata = await OBR.room.getMetadata();
      newValue = diceLogic.adjustMomentumLocal(metadata[MOMENTUM_METADATA_KEY] ?? 0, momentumPending);
      await OBR.room.setMetadata({ [MOMENTUM_METADATA_KEY]: newValue });
    }
    setMomentumValue(newValue);
    momentumPending = 0;
    renderPending();
  })
);
els.momentumSetBtn.addEventListener(
  "click",
  withBusy(els.momentumSetBtn, async () => {
    const amount = Number(els.momentumSetInput.value);
    let newValue;
    if (poolsRemote()) {
      const result = await postJson(`/api/${pairingCode}/momentum`, {
        action: "set",
        amount,
        player_name: playerName,
      });
      newValue = result.momentum;
    } else {
      newValue = diceLogic.setMomentumLocal(amount);
      await OBR.room.setMetadata({ [MOMENTUM_METADATA_KEY]: newValue });
    }
    setMomentumValue(newValue);
  })
);

els.threatStageMinus.addEventListener("click", () => {
  threatPending -= 1;
  renderPending();
});
els.threatStagePlus.addEventListener("click", () => {
  threatPending += 1;
  renderPending();
});
els.threatApplyBtn.addEventListener(
  "click",
  withBusy(els.threatApplyBtn, async () => {
    if (threatPending === 0) {
      return;
    }
    let newValue;
    if (poolsRemote()) {
      const result = await postJson(`/api/${pairingCode}/threat`, {
        action: "adjust",
        amount: threatPending,
        player_name: playerName,
        caller_role: isGM ? "GM" : "PLAYER",
      });
      newValue = result.threat;
    } else {
      const metadata = await OBR.room.getMetadata();
      newValue = diceLogic.adjustThreatLocal(metadata[THREAT_METADATA_KEY] ?? 0, threatPending);
      await OBR.room.setMetadata({ [THREAT_METADATA_KEY]: newValue });
    }
    setThreatValue(newValue);
    threatPending = 0;
    renderPending();
  })
);
els.threatSetBtn.addEventListener(
  "click",
  withBusy(els.threatSetBtn, async () => {
    const amount = Number(els.threatSetInput.value);
    let newValue;
    if (poolsRemote()) {
      const result = await postJson(`/api/${pairingCode}/threat`, {
        action: "set",
        amount,
        player_name: playerName,
        caller_role: isGM ? "GM" : "PLAYER",
      });
      newValue = result.threat;
    } else {
      newValue = diceLogic.setThreatLocal(amount);
      await OBR.room.setMetadata({ [THREAT_METADATA_KEY]: newValue });
    }
    setThreatValue(newValue);
  })
);

// ---------------------------------------------------------------------------
// Character Sheet -- Attributes + Skills feeding the "Roll Task" button.
// Purely personal, per-browser data (like the saved-roll presets of other
// extensions in this family) -- not shared via room metadata or the bot;
// only the roll it triggers gets shared/announced, same as any other roll.
// ---------------------------------------------------------------------------

const CHARACTER_SHEET_STORAGE_KEY = "ascension-owlbear-extension-character-sheet";

// Full display names for the abbreviated data-key codes used on the
// buttons/rows themselves (kept short there for the narrow popover) --
// only used for the roll-naming title below.
const STAT_FULL_NAMES = {
  AGILI: "Agility",
  BRAWN: "Brawn",
  COORD: "Coordination",
  AWARE: "Awareness",
  REASON: "Reason",
  FAITH: "Faith",
  PRES: "Presence",
  SKIR: "Skirmish",
  AUTH: "Authority",
  DIPL: "Diplomacy",
  STUDY: "Study",
  MED: "Medicine",
  INT: "Intrigue",
};

const charStatRows = Array.from(document.querySelectorAll(".char-stat-row"));

let selectedAttribute = null;
let selectedSkill = null;

function charStatRow(group, key) {
  return charStatRows.find((row) => row.dataset.group === group && row.dataset.key === key);
}

function renderCharacterSheetSelection() {
  for (const row of charStatRows) {
    const isSelected =
      (row.dataset.group === "attribute" && row.dataset.key === selectedAttribute) ||
      (row.dataset.group === "skill" && row.dataset.key === selectedSkill);
    row.querySelector(".char-stat-btn").classList.toggle("active", isSelected);
  }
}

// Composes the same syntax !d20 understands (target, crit, dice, then any
// of dN/con/+N--N) from the sheet's current Target/Crit/Dice/etc. fields, so
// Roll Task can just parse this field rather than reading each control
// directly -- letting a player hand-edit it before rolling.
function buildCharSheetRollSyntax() {
  if (els.charSheetTarget.value.trim() === "") {
    return "";
  }
  const targetNumber = Number(els.charSheetTarget.value) || 0;
  const critRange = Number(els.charSheetCrit.value) || 0;
  const numDice = Number(els.charSheetNumDice.value) || 2;
  const modifier = Number(els.charSheetModifier.value) || 0;

  const parts = [String(targetNumber), String(critRange), String(numDice)];
  if (els.charSheetContested.checked) {
    parts.push("con");
  } else {
    const difficultyRaw = els.charSheetDifficulty.value.trim();
    if (difficultyRaw !== "") {
      parts.push(`d${difficultyRaw}`);
    }
  }
  if (modifier) {
    parts.push(modifier > 0 ? `+${modifier}` : `${modifier}`);
  }
  return parts.join(" ");
}

// Target/Crit are auto-filled from the current Attribute+Skill selection
// (Target = their sum, Crit = the Skill's value if Focus is on, else 1) --
// but only ever a one-way push from selection into these fields, done
// directly (no dispatched "change") so it never trips the deselect
// listeners below. Manually adjusting Target/Crit afterward is what breaks
// the link, not the other way around.
function updateCharSheetTargetCritFromSelection() {
  if (!selectedAttribute || !selectedSkill) {
    return;
  }
  const attributeValue = Number(charStatRow("attribute", selectedAttribute).querySelector(".char-stat-value").value) || 0;
  const skillValue = Number(charStatRow("skill", selectedSkill).querySelector(".char-stat-value").value) || 0;
  els.charSheetTarget.value = clampStepperValue(els.charSheetTarget, attributeValue + skillValue);
  els.charSheetCrit.value = clampStepperValue(els.charSheetCrit, els.characterSheetFocus.checked ? skillValue : 1);
  saveCharacterSheet();
  refreshCharSheetSyntax();
}

// Manually adjusting Target/Crit (typing, or the stepper -- see
// attachStepper's dispatched "change") means they no longer necessarily
// reflect the selected Attribute+Skill pair, so the selection is cleared
// rather than silently going stale.
function deselectCharSheetAttributeAndSkill() {
  selectedAttribute = null;
  selectedSkill = null;
  renderCharacterSheetSelection();
  saveCharacterSheet();
}

function refreshCharSheetSyntax() {
  els.charSheetSyntax.value = buildCharSheetRollSyntax();
}

// Shared with the Export Settings handler below -- the one place that
// knows how to read the 13 stat inputs.
function getCharacterSheetValues() {
  const values = {};
  for (const row of charStatRows) {
    values[row.dataset.key] = Number(row.querySelector(".char-stat-value").value) || 0;
  }
  return values;
}

function saveCharacterSheet() {
  localStorage.setItem(
    CHARACTER_SHEET_STORAGE_KEY,
    JSON.stringify({
      values: getCharacterSheetValues(),
      selectedAttribute,
      selectedSkill,
      focus: els.characterSheetFocus.checked,
      target: els.charSheetTarget.value,
      crit: els.charSheetCrit.value,
    }),
  );
}

function loadCharacterSheet() {
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem(CHARACTER_SHEET_STORAGE_KEY));
  } catch {
    saved = null;
  }
  if (!saved) {
    return;
  }
  for (const row of charStatRows) {
    const value = saved.values && saved.values[row.dataset.key];
    if (typeof value === "number") {
      row.querySelector(".char-stat-value").value = value;
    }
  }
  selectedAttribute = saved.selectedAttribute || null;
  selectedSkill = saved.selectedSkill || null;
  els.characterSheetFocus.checked = Boolean(saved.focus);
  if (saved.target !== undefined) {
    els.charSheetTarget.value = saved.target;
  }
  if (saved.crit !== undefined) {
    els.charSheetCrit.value = saved.crit;
  }
  renderCharacterSheetSelection();
}

for (const row of charStatRows) {
  row.querySelector(".char-stat-btn").addEventListener("click", () => {
    if (row.dataset.group === "attribute") {
      selectedAttribute = selectedAttribute === row.dataset.key ? null : row.dataset.key;
    } else {
      selectedSkill = selectedSkill === row.dataset.key ? null : row.dataset.key;
    }
    renderCharacterSheetSelection();
    saveCharacterSheet();
    updateCharSheetTargetCritFromSelection();
    refreshCharSheetSyntax();
  });
  row.querySelector(".char-stat-value").addEventListener("change", () => {
    saveCharacterSheet();
    updateCharSheetTargetCritFromSelection();
    refreshCharSheetSyntax();
  });
}

els.characterSheetFocus.addEventListener("change", () => {
  saveCharacterSheet();
  updateCharSheetTargetCritFromSelection();
  refreshCharSheetSyntax();
});
els.charSheetNumDice.addEventListener("change", refreshCharSheetSyntax);
els.charSheetModifier.addEventListener("change", refreshCharSheetSyntax);
els.charSheetDifficulty.addEventListener("change", refreshCharSheetSyntax);

els.charSheetTarget.addEventListener("change", () => {
  deselectCharSheetAttributeAndSkill();
  refreshCharSheetSyntax();
});
els.charSheetCrit.addEventListener("change", () => {
  deselectCharSheetAttributeAndSkill();
  refreshCharSheetSyntax();
});

// While Contested is checked, the Difficulty field is a read-only preview
// of whatever it will actually roll against (the last check's successes)
// rather than an editable number -- kept live via addHistoryEntry() above,
// so it stays accurate if another roll happens while this is still checked.
function updateCharSheetContestedPreview() {
  if (!els.charSheetContested.checked) {
    return;
  }
  els.charSheetDifficulty.value = lastD20TotalSuccesses === null ? "" : lastD20TotalSuccesses;
  refreshCharSheetSyntax();
}

// The stepper +/- buttons sit next to the Difficulty input, not inside it,
// so disabling the input alone wouldn't stop them from still changing its
// value -- disable those too so the field is genuinely uneditable while
// Contested is on. Shared with the Reset button below.
function setCharSheetDifficultyDisabled(disabled) {
  els.charSheetDifficulty.disabled = disabled;
  const stepperButtons = els.charSheetDifficulty.closest(".number-input")?.querySelectorAll(".stepper-btn") ?? [];
  stepperButtons.forEach((btn) => {
    btn.disabled = disabled;
  });
}

els.charSheetContested.addEventListener("change", () => {
  const checked = els.charSheetContested.checked;
  setCharSheetDifficultyDisabled(checked);
  if (checked) {
    updateCharSheetContestedPreview();
  } else {
    els.charSheetDifficulty.value = "";
    refreshCharSheetSyntax();
  }
});

loadCharacterSheet();
refreshCharSheetSyntax();

// Shows just the dice icons + outcome of the single most recent roll made
// by clicking Roll Task in THIS browser -- passed as performLocalRoll's
// onLocalEvent hook below, so it never sees Challenge Dice rolls, other
// players' broadcasted rolls, or Discord-typed rolls (see that function's
// own comment for why those don't reach it).
function updateTaskResult(event) {
  if (event.type !== "d20_roll") {
    return;
  }
  els.taskResult.replaceChildren(buildD20RollSummary(event));
}

// Rolls whatever's currently typed in the syntax field -- auto-filled from
// the Attribute/Skill selection and the fields above, but editable by hand
// before rolling (same "!d20 10 2 4 d5 +2" syntax the Discord command
// accepts, parsed via diceLogic.parseD20Expression).
els.charSheetRollBtn.addEventListener(
  "click",
  withBusy(els.charSheetRollBtn, async () => {
    // Mirrors Lancer Nav's roll-naming mechanic (a trailing title shown
    // above the roll in history/Discord) -- but instead of free-text typed
    // into the expression, the name here is always the Attribute+Skill pair
    // that built this roll, and only if both are still selected right now
    // (manually adjusting Target/Crit already deselects them elsewhere).
    const title =
      selectedAttribute && selectedSkill
        ? `${STAT_FULL_NAMES[selectedAttribute]} + ${STAT_FULL_NAMES[selectedSkill]}`
        : undefined;

    const parsed = diceLogic.parseD20Expression(els.charSheetSyntax.value);

    let difficulty = parsed.difficulty;
    let conWarning;
    if (parsed.conRequested) {
      if (lastD20TotalSuccesses === null) {
        difficulty = null;
        conWarning = "No defender roll found -- rolled without a Difficulty.";
      } else {
        difficulty = lastD20TotalSuccesses;
      }
    }

    const { rolls, totalSuccesses, complications, taskSuccess, extraSuccesses } = diceLogic.performD20Roll(
      parsed.targetNumber, parsed.critRange, parsed.numDice, difficulty, parsed.modifier,
    );
    const postWarning = await performLocalRoll(
      "d20_roll",
      {
        rolls,
        target_number: parsed.targetNumber,
        crit_range: parsed.critRange,
        total_successes: totalSuccesses,
        complications,
        difficulty,
        task_success: taskSuccess,
        extra_successes: extraSuccesses,
        modifier: parsed.modifier,
        title,
      },
      updateTaskResult,
    );
    return [conWarning, postWarning].filter(Boolean).join(" ");
  }),
);

// Resets every control that feeds a roll -- Dice/Focus/Complication.../
// Difficulty/Contested/Target/Crit/Roll -- back to its defaults and
// deselects the Attribute/Skill buttons. Deliberately does NOT touch the
// Attributes'/Skills' own numeric values -- those are a character's stats,
// not roll-time settings, and resetting a roll shouldn't erase them.
els.charSheetResetBtn.addEventListener("click", () => {
  deselectCharSheetAttributeAndSkill();
  els.charSheetNumDice.value = "2";
  els.characterSheetFocus.checked = false;
  els.charSheetModifier.value = "+0";
  els.charSheetDifficulty.value = "";
  els.charSheetContested.checked = false;
  setCharSheetDifficultyDisabled(false);
  els.charSheetTarget.value = "";
  els.charSheetCrit.value = "1";
  els.charSheetSyntax.value = "";
  saveCharacterSheet();
});

async function refreshRole() {
  isGM = (await OBR.player.getRole()) === "GM";
  updateThreatVisibility();
  updateSettingsVisibility();
}

async function init() {
  playerName = (await OBR.player.getName()) || "Someone";

  await refreshRole();
  OBR.player.onChange(() => {
    refreshRole();
  });

  loadPairDiscordSetting();
  await loadPairingCodeFromRoom();

  if (poolsRemote()) {
    startPolling(); // fetches momentum/threat from /state as part of its first poll
  } else {
    const metadata = await OBR.room.getMetadata();
    setMomentumValue(metadata[MOMENTUM_METADATA_KEY] ?? 0);
    setThreatValue(metadata[THREAT_METADATA_KEY] ?? 0);
  }

  OBR.room.onMetadataChange((metadata) => {
    const stored = metadata[METADATA_KEY];
    if (stored && stored !== pairingCode) {
      pairingCode = stored;
      applyConfigToInputs();
      startPolling();
    }
    // Only take metadata's momentum/threat as truth while unpaired -- while
    // paired, polling is the source of truth instead (see pollUpdates()).
    if (!poolsRemote()) {
      if (MOMENTUM_METADATA_KEY in metadata) {
        setMomentumValue(metadata[MOMENTUM_METADATA_KEY]);
      }
      if (THREAT_METADATA_KEY in metadata) {
        setThreatValue(metadata[THREAT_METADATA_KEY]);
      }
    }
  });

  // Owlbear-to-Owlbear roll sync -- unconditional, works whether or not
  // this room is paired with Discord.
  OBR.broadcast.onMessage(ROLL_CHANNEL, (event) => addHistoryEntry(event.data));

  renderPending();
}

if (OBR.isReady) {
  init();
} else {
  OBR.onReady(init);
}
