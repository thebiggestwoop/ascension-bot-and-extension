import OBR from "https://esm.sh/@owlbear-rodeo/sdk@3.1.0";

// The bot now lives at a stable address, so this is baked in rather than
// something each player has to paste into Settings.
const BACKEND_URL = "https://bot.heruv.uk";

// Everyone in the same Owlbear room shares this key via OBR.room metadata,
// so only one player has to paste the pairing code -- Owlbear replicates
// room metadata to every connected client automatically.
const METADATA_KEY = "com.ascension.owlbear-extension/pairing-code";
const MAX_HISTORY_ENTRIES = 20;
const POLL_INTERVAL_MS = 2500;

const els = {
  pairingCode: document.getElementById("pairing-code"),
  saveSettings: document.getElementById("save-settings"),
  settingsStatus: document.getElementById("settings-status"),
  globalStatus: document.getElementById("global-status"),

  rollHistory: document.getElementById("roll-history"),

  d20Target: document.getElementById("d20-target"),
  d20Crit: document.getElementById("d20-crit"),
  d20NumDice: document.getElementById("d20-num-dice"),
  d20RollBtn: document.getElementById("d20-roll-btn"),

  cdNumDice: document.getElementById("cd-num-dice"),
  cdRollBtn: document.getElementById("cd-roll-btn"),

  momentumValue: document.getElementById("momentum-value"),
  momentumStageMinus: document.getElementById("momentum-stage-minus"),
  momentumPending: document.getElementById("momentum-pending"),
  momentumStagePlus: document.getElementById("momentum-stage-plus"),
  momentumApplyBtn: document.getElementById("momentum-apply-btn"),
  momentumSetInput: document.getElementById("momentum-set-input"),
  momentumSetBtn: document.getElementById("momentum-set-btn"),

  threatValue: document.getElementById("threat-value"),
  threatGmNotice: document.getElementById("threat-gm-notice"),
  threatControls: document.getElementById("threat-controls"),
  threatStageMinus: document.getElementById("threat-stage-minus"),
  threatPending: document.getElementById("threat-pending"),
  threatStagePlus: document.getElementById("threat-stage-plus"),
  threatApplyBtn: document.getElementById("threat-apply-btn"),
  threatSetInput: document.getElementById("threat-set-input"),
  threatSetBtn: document.getElementById("threat-set-btn"),
};

let pairingCode = "";
let playerName = "Someone";
let isGM = false;
let momentumPending = 0;
let threatPending = 0;
let lastSeq = 0;
let pollTimer = null;

function setStatus(el, message, isError) {
  el.textContent = message;
  el.classList.toggle("error", Boolean(isError));
}

function applyConfigToInputs() {
  els.pairingCode.value = pairingCode || "";
  const linked = Boolean(pairingCode);
  setStatus(els.settingsStatus, linked ? "Linked." : "Not linked yet.", !linked);
}

function updateThreatVisibility() {
  els.threatControls.hidden = !isGM;
  els.threatGmNotice.hidden = isGM;
}

function formatSigned(value) {
  return value >= 0 ? `+${value}` : `${value}`;
}

function renderPending() {
  els.momentumPending.textContent = formatSigned(momentumPending);
  els.threatPending.textContent = formatSigned(threatPending);
}

// Builds "[3, 14, 20]" as DOM nodes (not an HTML string) so nothing in
// `rolls` can ever be interpreted as markup, with crit-range rolls bolded.
function buildRollsFragment(rolls, critRange) {
  const frag = document.createDocumentFragment();
  frag.appendChild(document.createTextNode("["));
  rolls.forEach((roll, i) => {
    if (i > 0) {
      frag.appendChild(document.createTextNode(", "));
    }
    if (roll <= critRange) {
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
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

// Returns { actor, sourceTag, node } describing a roll event as safe DOM
// nodes, or null if the event isn't a roll (e.g. a pool change).
function describeRoll(event) {
  const sourceTag = event.source === "discord" ? "Discord" : "Owlbear";

  if (event.type === "d20_roll") {
    const line = document.createElement("span");
    line.appendChild(buildRollsFragment(event.rolls, event.crit_range));
    let suffix = ` -> ${pluralize(event.total_successes, "success")}`;
    if (event.complications > 0) {
      suffix += `, ${pluralize(event.complications, "complication")}`;
    }
    line.appendChild(document.createTextNode(suffix));
    return { actor: event.actor, sourceTag, node: line };
  }

  if (event.type === "challenge_roll") {
    const line = document.createElement("span");
    line.textContent =
      `CD -> ${pluralize(event.total_successes, "success")}, ` +
      `${pluralize(event.effects, "effect")}, ${pluralize(event.blanks, "blank")}`;
    return { actor: event.actor, sourceTag, node: line };
  }

  return null;
}

function addHistoryEntry(event) {
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

  li.appendChild(line1);
  li.appendChild(described.node);

  els.rollHistory.prepend(li);
  while (els.rollHistory.children.length > MAX_HISTORY_ENTRIES) {
    els.rollHistory.removeChild(els.rollHistory.lastChild);
  }
}

async function pollUpdates() {
  if (!pairingCode) {
    return;
  }
  try {
    const data = await requestJson(`/api/${pairingCode}/updates?since=${lastSeq}`);
    els.momentumValue.textContent = data.momentum;
    els.threatValue.textContent = data.threat;
    for (const event of data.events) {
      if (event.type === "d20_roll" || event.type === "challenge_roll") {
        addHistoryEntry(event);
      }
    }
    lastSeq = data.seq;
  } catch (err) {
    // Non-fatal -- just try again on the next tick.
  }
}

function startPolling() {
  stopPolling();
  lastSeq = 0;
  if (!pairingCode) {
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

async function savePairingCode() {
  pairingCode = els.pairingCode.value.trim();
  await OBR.room.setMetadata({ [METADATA_KEY]: pairingCode });
  applyConfigToInputs();
  startPolling();
}

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

function withBusy(button, fn) {
  return async () => {
    button.disabled = true;
    try {
      await fn();
      setStatus(els.globalStatus, "Done.", false);
    } catch (err) {
      setStatus(els.globalStatus, err.message, true);
    } finally {
      button.disabled = false;
    }
  };
}

els.saveSettings.addEventListener("click", withBusy(els.saveSettings, savePairingCode));

els.d20RollBtn.addEventListener(
  "click",
  withBusy(els.d20RollBtn, () =>
    postJson(`/api/${pairingCode}/roll/d20`, {
      target_number: Number(els.d20Target.value),
      crit_range: Number(els.d20Crit.value),
      num_dice: Number(els.d20NumDice.value) || 2,
      player_name: playerName,
    })
  )
);

els.cdRollBtn.addEventListener(
  "click",
  withBusy(els.cdRollBtn, () =>
    postJson(`/api/${pairingCode}/roll/cd`, {
      num_dice: Number(els.cdNumDice.value),
      player_name: playerName,
    })
  )
);

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
    const result = await postJson(`/api/${pairingCode}/momentum`, {
      action: "adjust",
      amount: momentumPending,
      player_name: playerName,
    });
    els.momentumValue.textContent = result.momentum;
    momentumPending = 0;
    renderPending();
  })
);
els.momentumSetBtn.addEventListener(
  "click",
  withBusy(els.momentumSetBtn, async () => {
    const result = await postJson(`/api/${pairingCode}/momentum`, {
      action: "set",
      amount: Number(els.momentumSetInput.value),
      player_name: playerName,
    });
    els.momentumValue.textContent = result.momentum;
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
    const result = await postJson(`/api/${pairingCode}/threat`, {
      action: "adjust",
      amount: threatPending,
      player_name: playerName,
      caller_role: isGM ? "GM" : "PLAYER",
    });
    els.threatValue.textContent = result.threat;
    threatPending = 0;
    renderPending();
  })
);
els.threatSetBtn.addEventListener(
  "click",
  withBusy(els.threatSetBtn, async () => {
    const result = await postJson(`/api/${pairingCode}/threat`, {
      action: "set",
      amount: Number(els.threatSetInput.value),
      player_name: playerName,
      caller_role: isGM ? "GM" : "PLAYER",
    });
    els.threatValue.textContent = result.threat;
  })
);

async function refreshRole() {
  isGM = (await OBR.player.getRole()) === "GM";
  updateThreatVisibility();
}

async function init() {
  playerName = (await OBR.player.getName()) || "Someone";

  await refreshRole();
  OBR.player.onChange(() => {
    refreshRole();
  });

  await loadPairingCodeFromRoom();
  startPolling();

  OBR.room.onMetadataChange((metadata) => {
    const stored = metadata[METADATA_KEY];
    if (stored) {
      pairingCode = stored;
      applyConfigToInputs();
      startPolling();
    }
  });

  renderPending();
}

if (OBR.isReady) {
  init();
} else {
  OBR.onReady(init);
}
