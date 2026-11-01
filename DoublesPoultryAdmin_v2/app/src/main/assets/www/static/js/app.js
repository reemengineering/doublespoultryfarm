// DOUBLES POULTRY FARM — weighing terminal (admin kiosk).
//
// One vanilla-JS single page app over the Flask API. The weighing workflow,
// cart persistence, verdicts, alerts, spoken names and reports mirror the
// reference terminal; the markup is our own.

import {
  api, ApiError, ttsBase, getServerOrigin,
  scale, alerts, tts, store,
  TareBaseline, ScaleLcd, fileToDataUrl, ImageTooLargeError,
  evaluateReading, parseWeight, round3, roundTargetWeight, targetRoundingNote,
  fmtWeight, fmtWeightNoUnit, fmtSignedValue,
  BRAND, LOGO_SRC, nameLoopLangs, FONT_SCALE_STEPS, AUTO_ADVANCE_MS, MAX_TARGET_KG,
  uid, escapeHtml, installScreenFit,
} from './lib.js';

// The operator can repeat the whole queue this many times at most.
const MAX_BATCHES = 50;

const state = {
  screen: 'weighing',
  stage: 'select',
  items: [],
  itemsLoading: true,
  itemsError: '',
  formulas: [],
  formulasError: '',
  cart: [],
  activeIndex: 0,
  resumed: false,
  selectedItemId: null,
  selectedFormulaId: null,
  reqInput: '',
  reqError: '',
  // Batch repetition: the whole queue is weighed batchTotal times; batchIndex
  // tracks which round is running, and betweenBatches marks the pause between
  // rounds (so the operator can clear the pan before the next one starts).
  batchTotal: 1,
  batchIndex: 1,
  betweenBatches: false,
  search: '',
  subtab: {}, // per-screen transient view state
};

const tare = new TareBaseline();
const voiceLang = 'en';

let advancedUid = null;
let advanceTimer = null;
let advanceTick = null;
let advanceRemaining = 0;
let terminalRefs = null;
let scaleLcd = null;
let voiceKey = null;
let lastVerdictKind = 'neutral';

const root = document.getElementById('app');
const mainEl = () => document.getElementById('screen-main');

// The picture for a cart line, if it has one. Matches the staff terminal so the
// two weighing screens show the same image for the same item.
function itemImageUrl(path) {
  if (!path) return null;
  const origin = getServerOrigin();
  return `${origin}${String(path).startsWith('/') ? '' : '/'}${String(path)}`;
}

// ---------------------------------------------------------------------------
// Admin PIN lock
// ---------------------------------------------------------------------------

// The admin terminal sits behind a 4-digit PIN so a shortcut launch (or anyone
// at the machine) cannot walk into formulas and the item master uninvited. The
// PIN is asked on every load: there is no "remember me", so a refresh or a new
// launch always shows the lock again. The PIN lives in the client, so this is
// a lock on the door, not a vault — it keeps casual users out. The staff
// terminal has no lock: it is the kiosk.
const ADMIN_PIN = '9876';

function renderPinLock() {
  root.className = '';
  root.innerHTML = `
    <div class="pin-lock">
      <div class="pin-card">
        <div class="pin-title">ADMIN TERMINAL</div>
        <p class="pin-hint">Enter the admin PIN to continue.</p>
        <input class="pin-input" id="pin-input" type="password" inputmode="numeric"
               autocomplete="off" maxlength="4" aria-label="Admin PIN" />
        <div class="pin-error" id="pin-error" hidden>Wrong PIN. Try again.</div>
        <button class="btn btn-primary btn-lg pin-unlock" id="pin-unlock">UNLOCK</button>
      </div>
    </div>`;
  const input = document.getElementById('pin-input');
  const error = document.getElementById('pin-error');
  // Digits only: strip anything else as it is typed.
  input.addEventListener('input', () => {
    const digits = input.value.replace(/\D/g, '').slice(0, 4);
    if (digits !== input.value) input.value = digits;
    error.hidden = true;
  });
  const unlock = () => {
    if (input.value === ADMIN_PIN) {
      void boot();
      return;
    }
    error.hidden = false;
    input.value = '';
    input.focus();
  };
  document.getElementById('pin-unlock').addEventListener('click', unlock);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') unlock();
  });
  input.focus();
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  applyFontScale();
  installScreenFit();
  alerts.primeAlertAudio();
  tts.setTtsBase(ttsBase());

  window.addEventListener('beforeunload', () => tts.stopSpeaking());
  document.addEventListener('click', onClick);
  document.addEventListener('input', onInput);
  document.addEventListener('change', onChange);
  document.addEventListener('keydown', onKeydown);

  scale.subscribe(onScaleChange);
  scale.initScale();

  renderShell();
  await loadItems();
  await loadFormulas();
  restore();
  renderScreen();
}

function applyFontScale() {
  const raw = store.getRaw(store.FONT_SCALE_KEY) || 'md';
  const step = FONT_SCALE_STEPS.find((s) => s.id === raw) || FONT_SCALE_STEPS[0];
  document.documentElement.setAttribute('data-font-scale', step.id);
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function loadItems() {
  state.itemsError = '';
  try {
    const list = await api.getItems();
    state.items = Array.isArray(list) ? list : [];
    if (state.items.length) tts.preloadAll(state.items, nameLoopLangs);
  } catch (err) {
    state.itemsError = err?.message || String(err);
  } finally {
    state.itemsLoading = false;
  }
}

async function loadFormulas() {
  state.formulasError = '';
  try {
    const list = await api.getFormulas();
    state.formulas = Array.isArray(list) ? list : [];
  } catch (err) {
    state.formulasError = err?.message || String(err);
  }
}

function restore() {
  // Data logging is gone: there is no pending bill to restore any more, only a
  // weighing that was interrupted mid-way, which resumes from the stored cart.
  const stored = store.loadCart();
  if (!stored) return;
  const restored = stored.lines.map((line) => {
    const item = state.items.find((candidate) => candidate.id === line.id);
    return {
      uid: line.uid,
      id: line.id,
      slug: item ? item.slug : line.slug,
      name: item ? item.name : line.name,
      names: item ? item.names : { en: line.name, hi: '' },
      imagePath: item ? item.imagePath ?? null : line.imagePath ?? null,
      required: roundTargetWeight(line.required),
      status: line.status,
      actual: line.actual ?? null,
      formulaName: line.formulaName ?? stored.formulaName,
      formulaId: line.formulaId ?? stored.formulaId,
    };
  });
  const firstPending = restored.findIndex((line) => line.status !== 'completed');
  if (firstPending === -1) {
    store.clearStoredCart();
    return;
  }
  state.cart = restored;
  state.activeIndex = firstPending;
  state.resumed = true;
  state.batchTotal = Math.max(1, Number(stored.batchTotal) || 1);
  state.batchIndex = Math.min(state.batchTotal, Math.max(1, Number(stored.batchIndex) || 1));
  state.betweenBatches = false;
  tare.zeroAt(scale.getReading());
  state.stage = 'weighing';
}

// The batch position as it is stored alongside the cart.
function batchState() {
  return { total: state.batchTotal, index: state.batchIndex };
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

const SCREENS = [
  { key: 'weighing', label: 'WEIGHING' },
  { key: 'formulas', label: 'FORMULAS' },
  { key: 'items', label: 'ITEM MASTER' },
];

function renderShell() {
  root.className = '';
  root.innerHTML = `
    <header class="app-header">
      <div class="brand">
        <span class="brand-text"><span class="brand-name">${escapeHtml(BRAND)}</span></span>
      </div>
      <div class="header-right">
        <div class="header-controls">
          <button class="btn btn-secondary btn-sm" data-action="font-size">A</button>
          <button class="btn btn-secondary btn-sm" data-action="toggle-alerts" id="alerts-toggle" title="Sound alerts"></button>
          <button class="btn btn-secondary btn-sm" data-action="open-scale" id="scale-chip">SCALE…</button>
          <button class="btn btn-danger btn-sm shutdown-btn" id="shutdown-btn" data-action="shutdown" title="Turn the terminal off. Tap once to arm, tap again to confirm.">⏻ SHUTDOWN</button>
        </div>
        <img class="app-logo" src="${escapeHtml(LOGO_SRC)}" alt="Reem Engineering Enterprises" />
      </div>
    </header>
    <nav class="nav-tabs" id="nav-tabs">
      ${SCREENS.map(
        (entry) =>
          `<button class="nav-tab${state.screen === entry.key ? ' active' : ''}" data-action="nav" data-screen="${entry.key}">${entry.label}</button>`,
      ).join('')}
    </nav>
    <main id="screen-main"></main>
    <footer class="app-footer">© Copyright Reem Engineering Enterprises</footer>
    <div id="overlay" class="overlay hidden"></div>
  `;
  updateAlertsToggle();
  updateScaleChip();
  updateShutdownButton();
}

// Shutdown is destructive and there is no undo, so it takes two taps: the first
// arms the button, the second confirms. Arm reverts on its own after a few
// seconds, so a stray tap cannot leave the terminal primed. This mirrors the
// staff terminal's control rather than a native confirm() popup, which is
// awkward to dismiss on a locked-down kiosk.
let shutdownState = 'idle';
let shutdownTimer = null;

function updateShutdownButton() {
  const btn = document.getElementById('shutdown-btn');
  if (!btn) return;
  btn.textContent =
    shutdownState === 'armed'
      ? '⚠ CONFIRM SHUTDOWN?'
      : shutdownState === 'sent'
        ? '⏻ SHUTTING DOWN…'
        : shutdownState === 'error'
          ? '✕ SHUTDOWN FAILED'
          : '⏻ SHUTDOWN';
  btn.classList.toggle('armed', shutdownState === 'armed');
  btn.disabled = shutdownState === 'sent';
}

function shutdownLater(ms) {
  if (shutdownTimer) clearTimeout(shutdownTimer);
  shutdownTimer = setTimeout(() => {
    shutdownState = 'idle';
    updateShutdownButton();
  }, ms);
}

function updateAlertsToggle() {
  const btn = document.getElementById('alerts-toggle');
  if (btn) {
    const on = alerts.alertsEnabled();
    btn.textContent = on ? '🔔 SOUND ON' : '🔕 SOUND OFF';
    btn.classList.toggle('muted', !on);
  }
}

function updateScaleChip() {
  const chip = document.getElementById('scale-chip');
  if (!chip) return;
  const device = scale.getDevice();
  const err = scale.getDeviceError();
  chip.textContent = err
    ? 'SCALE ERROR'
    : device.connected
      ? `SCALE ONLINE`
      : 'SCALE OFFLINE';
  chip.classList.toggle('online', device.connected && !err);
  chip.classList.toggle('error', Boolean(err));
}

function onScaleChange() {
  updateScaleChip();
  updateHeaderStatus();
  if (state.screen === 'weighing' && state.stage === 'weighing') updateTerminal();
}

function updateHeaderStatus() {
  const node = document.getElementById('header-scale-status');
  if (!node) return;
  const device = scale.getDevice();
  const err = scale.getDeviceError();
  node.textContent = err
    ? `SCALE ERROR: ${err}`
    : device.connected
      ? `SCALE ONLINE (${device.port || 'connected'})`
      : 'SCALE OFFLINE';
  node.className = `scale-status ${err ? 'error' : device.connected ? 'online' : 'offline'}`;
}

// ---------------------------------------------------------------------------
// Screen routing
// ---------------------------------------------------------------------------

function renderScreen() {
  stopTerminalTimers();
  terminalRefs = null;
  for (const tab of document.querySelectorAll('.nav-tab')) {
    tab.classList.toggle('active', tab.dataset.screen === state.screen);
  }
  const main = mainEl();
  if (!main) return;
  main.innerHTML = '';
  if (state.screen === 'weighing') renderWeighing(main);
  else if (state.screen === 'formulas') renderFormulas(main);
  else if (state.screen === 'items') renderItems(main);
}

// The formula list is long enough to push the editor below the fold once there
// are a few formulas. Opening the editor scrolls it into view so it is visible
// straight away instead of leaving the user to find it. Only the actions that
// open the editor call this — not the re-renders that happen while editing, so
// the page does not jump when rows are added, removed or reordered.
function scrollEditorIntoView() {
  requestAnimationFrame(() => {
    const editor = document.querySelector('.formula-layout > aside.panel');
    if (editor) editor.scrollIntoView({ block: 'start', behavior: 'smooth' });
  });
}

function banner(text, actionLabel, action) {
  const div = document.createElement('div');
  div.className = 'error-banner';
  div.append(document.createTextNode(text));
  if (actionLabel) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-secondary btn-sm';
    btn.textContent = actionLabel;
    btn.addEventListener('click', action);
    div.append(' ', btn);
  }
  return div;
}

// ---------------------------------------------------------------------------
// WEIGHING — item selection
// ---------------------------------------------------------------------------

function renderWeighing(main) {
  if (state.stage === 'select') renderSelect(main);
  else if (state.stage === 'weighing') renderTerminal(main);
  else if (state.stage === 'complete') renderComplete(main);
}

function renderSelect(main) {
  if (state.itemsError) {
    main.append(banner(`Item master unavailable: ${state.itemsError}`, 'RETRY', async () => {
      await loadItems();
      renderScreen();
    }));
  }
  if (state.formulasError) {
    main.append(banner(`Formula catalog unavailable: ${state.formulasError}`, 'RETRY', async () => {
      await loadFormulas();
      renderScreen();
    }));
  }

  const wrapper = document.createElement('div');
  wrapper.className = 'select-layout';

  // Left: catalog
  const catalog = document.createElement('section');
  catalog.className = 'panel catalog-panel';
  const selected = state.selectedItemId;
  const needle = state.search.trim().toLowerCase();
  const filtered = state.items.filter((item) => {
    if (!needle) return true;
    return (
      item.name.toLowerCase().includes(needle) ||
      item.code.toLowerCase().includes(needle)
    );
  });

  catalog.innerHTML = `
    <div class="panel-head">
      <h2>SELECT ITEM</h2>
      <input class="search-input" data-action="item-search" placeholder="Search…" value="${escapeHtml(state.search)}" />
    </div>
    ${state.itemsLoading ? '<p class="muted">Loading item master…</p>' : ''}
    <div class="item-grid">
      ${filtered
        .map(
          (item) => `
        <button class="item-card${item.id === selected ? ' selected' : ''}" data-action="select-item" data-id="${item.id}">
          ${
            item.imagePath
              ? `<img class="item-thumb" src="${escapeHtml(item.imagePath)}" alt="" />`
              : `<span class="item-thumb placeholder">${escapeHtml(item.code)}</span>`
          }
          <span class="item-name">${escapeHtml(item.name)}</span>
          <span class="item-code">${escapeHtml(item.code)}</span>
        </button>`,
        )
        .join('')}
    </div>
    <div class="formula-list">
      <h3>FORMULAS</h3>
      ${
        state.formulas.length === 0
          ? '<p class="muted">No formulas yet.</p>'
          : state.formulas
              .map(
                (formula) => `
          <div class="formula-row${formula.id === state.selectedFormulaId ? ' selected' : ''}">
            <button class="formula-load" data-action="load-formula" data-id="${formula.id}">
              <strong>${escapeHtml(formula.name)}</strong>
              <span>${formula.itemCount} items · ${fmtWeight(formula.totalWeight)}</span>
            </button>
            <button class="btn btn-secondary btn-sm" data-action="select-formula" data-id="${formula.id}">SELECT</button>
          </div>`,
              )
              .join('')
      }
    </div>
  `;
  wrapper.append(catalog);

  // Right: cart + add
  const cartPanel = document.createElement('aside');
  cartPanel.className = 'panel cart-panel';
  const roundingNote = targetRoundingNote(parseWeight(state.reqInput) ?? NaN);
  cartPanel.innerHTML = `
    <h2>WEIGHING QUEUE</h2>
    <div class="cart-lines">
      ${
        state.cart.length === 0
          ? '<p class="muted">No items queued. Select an item and add a weight.</p>'
          : state.cart
              .map(
                (line) => `
        <div class="cart-line">
          <span class="cart-line-name">${escapeHtml(line.name)}</span>
          <span class="cart-line-weight">${fmtWeight(line.required)}</span>
          ${
            line.status === 'completed'
              ? `<span class="cart-line-done">✓ ${line.actual == null ? 'skipped' : fmtWeight(line.actual)}</span>`
              : ''
          }
          <button class="btn-icon" data-action="remove-line" data-uid="${escapeHtml(line.uid)}" title="Remove">✕</button>
        </div>`,
              )
              .join('')
      }
    </div>
    <div class="add-controls">
      <label class="field-label">Required weight (kg)</label>
      <input class="weight-input" id="req-input" data-action="req-input" inputmode="decimal" placeholder="e.g. 50" value="${escapeHtml(state.reqInput)}" ${selected == null ? 'disabled' : ''} />
      ${roundingNote ? `<p class="rounding-note">${escapeHtml(roundingNote)}</p>` : ''}
      ${state.reqError ? `<p class="field-error">${escapeHtml(state.reqError)}</p>` : ''}
      <button class="btn btn-primary" data-action="add-to-cart" ${selected == null ? 'disabled' : ''}>ADD TO QUEUE</button>
    </div>
    <div class="cart-total">
      <span>${state.cart.length} item${state.cart.length === 1 ? '' : 's'}</span>
      <strong>${fmtWeight(state.cart.reduce((sum, line) => sum + line.required, 0))}</strong>
    </div>
    <div class="batch-control">
      <span class="field-label">Number of batches</span>
      <div class="stepper" role="group" aria-label="Number of batches">
        <button class="stepper-btn" data-action="batch-down" ${state.batchTotal <= 1 ? 'disabled' : ''} aria-label="Fewer batches">\u2212</button>
        <span class="stepper-value" aria-live="polite">${state.batchTotal}</span>
        <button class="stepper-btn" data-action="batch-up" ${state.batchTotal >= MAX_BATCHES ? 'disabled' : ''} aria-label="More batches">+</button>
      </div>
      <p class="batch-note">${state.batchTotal === 1 ? 'Weigh this queue once.' : `The queue is weighed ${state.batchTotal} times. Each round is saved as its own batch.`}</p>
    </div>
    <button class="btn btn-success btn-lg" data-action="start-weighing" ${state.cart.length === 0 ? 'disabled' : ''}>START WEIGHING</button>
  `;
  wrapper.append(cartPanel);
  main.append(wrapper);
}

// ---------------------------------------------------------------------------
// WEIGHING — live terminal
// ---------------------------------------------------------------------------

function activeItem() {
  return state.stage !== 'select' ? state.cart[state.activeIndex] : null;
}

function renderTerminal(main) {
  if (state.resumed) {
    main.append(
      banner(
        'This weighing was restored after the app reloaded. Lines already weighed are marked complete; check the queue before continuing.',
        'DISCARD',
        cancelWeighing,
      ),
    );
  }

  const wrap = document.createElement('div');
  wrap.className = 'terminal';
  wrap.innerHTML = `
    <div class="terminal-queue" id="t-queue"></div>
    <div class="terminal-main">
      <div class="terminal-head">
        <div class="scale-status offline" id="header-scale-status"></div>
      </div>
      <div class="readout" id="t-readout">
        <div class="readout-label">NET WEIGHT</div>
        <div class="readout-value" id="t-net">0.000</div>
        <div class="readout-unit">kg</div>
      </div>
      <div class="verdict neutral" id="t-verdict">
        <div class="verdict-title" id="t-verdict-title">AWAITING INPUT</div>
        <div class="verdict-detail" id="t-verdict-detail"></div>
      </div>
      <div class="terminal-meta">
        <span>Target <strong id="t-target">\u2014</strong></span>
        <span>Accumulated <strong id="t-accum">\u2014</strong></span>
        <span>Zero <strong id="t-zero">\u2014</strong></span>
        <span>Batch <strong id="t-batch">${state.batchIndex} / ${state.batchTotal}</strong></span>
      </div>
      <div class="terminal-hint" id="t-hint"></div>
      <div class="advance-bar" id="t-advance"></div>
      <div class="terminal-actions">
        <button class="btn btn-secondary" data-action="terminal-zero">ZERO HERE</button>
        <button class="btn btn-primary" data-action="terminal-next" id="t-next" disabled>NEXT</button>
        <button class="btn btn-secondary" data-action="terminal-skip">SKIP</button>
        <button class="btn btn-danger" data-action="terminal-cancel">CANCEL WEIGHING</button>
      </div>
    </div>
  `;
  main.append(wrap);

  terminalRefs = {
    queue: document.getElementById('t-queue'),
    net: document.getElementById('t-net'),
    verdict: document.getElementById('t-verdict'),
    verdictTitle: document.getElementById('t-verdict-title'),
    verdictDetail: document.getElementById('t-verdict-detail'),
    target: document.getElementById('t-target'),
    accum: document.getElementById('t-accum'),
    zero: document.getElementById('t-zero'),
    hint: document.getElementById('t-hint'),
    advance: document.getElementById('t-advance'),
    next: document.getElementById('t-next'),
  };
  updateHeaderStatus();
  updateTerminal();
}

function updateTerminal() {
  const item = activeItem();
  if (!item || !terminalRefs) return;

  const accumulated = scale.getReading();
  tare.adoptEmptyPan(accumulated);
  const netWeight = tare.net(accumulated);
  const loadRemoved = tare.underBase(accumulated);
  const verdict = evaluateReading(item.required, netWeight);
  const nextEnabled = verdict.correct;

  terminalRefs.net.textContent = netWeight == null ? '—' : netWeight.toFixed(3);
  terminalRefs.target.textContent = fmtWeight(item.required);
  terminalRefs.accum.textContent = accumulated == null ? '—' : accumulated.toFixed(3);
  terminalRefs.zero.textContent = tare.isEstablished() ? tare.baseValue().toFixed(3) : 'not set';

  terminalRefs.verdict.className = `verdict ${verdict.type}`;
  terminalRefs.verdictTitle.textContent = verdict.title;
  terminalRefs.verdictDetail.textContent = verdict.detail;
  terminalRefs.next.disabled = !nextEnabled;

  let hint = '';
  if (loadRemoved) {
    hint = 'Material came off the scale. Clear the pan and press ZERO HERE, or put the weight back on.';
  } else if (!tare.isEstablished()) {
    hint = 'Waiting for the scale to say what the pan reads.';
  } else if (netWeight == null) {
    hint = 'No live reading — check the scale connection.';
  }
  terminalRefs.hint.textContent = hint;

  renderTerminalQueue();

  // Alert tone and spoken name.
  alerts.setAlertLoop(verdict.type);
  const underweight = verdict.type === 'underweight';
  if (underweight && alerts.alertsEnabled() && item) {
    tts.startNameLoop(item, tts.orderLangs(voiceLang, nameLoopLangs));
  } else {
    tts.stopNameLoop();
  }
  lastVerdictKind = verdict.type;

  // Auto-advance countdown.
  if (nextEnabled) startAutoAdvance(`${state.activeIndex}:${item.uid}:${item.required}`, handleNext);
  else stopAutoAdvance();
}

function renderTerminalQueue() {
  if (!terminalRefs) return;
  terminalRefs.queue.innerHTML = state.cart
    .map((line, index) => {
      const cls =
        index === state.activeIndex ? 'active' : line.status === 'completed' ? 'completed' : '';
      const detail =
        line.status === 'completed'
          ? line.actual == null
            ? 'skipped'
            : `✓ ${fmtWeight(line.actual)}`
          : `→ ${fmtWeight(line.required)}`;
      return `<div class="queue-line ${cls}">
        <span class="queue-index">${index + 1}</span>
        <span class="queue-name">${escapeHtml(line.name)}</span>
        <span class="queue-weight">${detail}</span>
      </div>`;
    })
    .join('');
}

// ---------------------------------------------------------------------------
// Auto-advance
// ---------------------------------------------------------------------------

function startAutoAdvance(token, onAdvance) {
  if (advanceToken === token) return;
  stopAutoAdvance();
  advanceToken = token;
  advanceRemaining = AUTO_ADVANCE_MS;
  const startedAt = Date.now();
  updateAdvanceBar();
  advanceTimer = setTimeout(() => {
    advanceTimer = null;
    if (advanceTick) clearInterval(advanceTick);
    advanceTick = null;
    advanceRemaining = 0;
    updateAdvanceBar();
    onAdvance();
  }, AUTO_ADVANCE_MS);
  advanceTick = setInterval(() => {
    advanceRemaining = Math.max(0, AUTO_ADVANCE_MS - (Date.now() - startedAt));
    updateAdvanceBar();
  }, 200);
}

let advanceToken = null;

function stopAutoAdvance() {
  advanceToken = null;
  advanceRemaining = 0;
  if (advanceTimer) clearTimeout(advanceTimer);
  advanceTimer = null;
  if (advanceTick) clearInterval(advanceTick);
  advanceTick = null;
  updateAdvanceBar();
}

function stopTerminalTimers() {
  stopAutoAdvance();
  alerts.stopAlertLoop();
  tts.stopNameLoop();
}

function updateAdvanceBar() {
  if (!terminalRefs) return;
  if (advanceRemaining > 0) {
    const seconds = Math.ceil(advanceRemaining / 1000);
    terminalRefs.advance.textContent = `TARGET REACHED — moving on in ${seconds}s`;
    terminalRefs.advance.classList.add('active');
  } else {
    terminalRefs.advance.textContent = '';
    terminalRefs.advance.classList.remove('active');
  }
}

// ---------------------------------------------------------------------------
// Weighing actions
// ---------------------------------------------------------------------------

function addToCart() {
  const required = parseWeight(state.reqInput);
  if (required == null || required <= 0) {
    state.reqError = 'Enter a valid weight above zero, e.g. 2.000';
    renderScreen();
    return;
  }
  if (round3(required) <= 0) {
    state.reqError = 'That weight rounds to zero at 0.001 kg precision. Enter 0.001 or more.';
    renderScreen();
    return;
  }
  const target = roundTargetWeight(required);
  if (target < 1) {
    state.reqError = 'A line must weigh at least 1 kg. Enter 1.000 or more.';
    renderScreen();
    return;
  }
  if (target > MAX_TARGET_KG) {
    state.reqError = `A line cannot be more than ${MAX_TARGET_KG} kg. Enter a weight up to ${MAX_TARGET_KG} kg.`;
    renderScreen();
    return;
  }
  const item = state.items.find((candidate) => candidate.id === state.selectedItemId);
  if (!item) return;
  const next = [
    ...state.cart,
    {
      uid: uid(),
      id: item.id,
      slug: item.slug,
      name: item.name,
      names: item.names,
      imagePath: item.imagePath ?? null,
      required: target,
      status: 'pending',
    },
  ];
  state.cart = next;
  state.reqInput = '';
  state.reqError = '';
  store.saveCart(next, null, batchState());
  renderScreen();
}

function beginWeighing() {
  if (state.cart.length === 0) return;
  state.activeIndex = 0;
  state.resumed = false;
  state.batchIndex = 1;
  state.betweenBatches = false;
  advancedUid = null;
  tare.zeroAt(scale.getReading());
  store.saveCart(state.cart, null, batchState());
  state.stage = 'weighing';
  renderScreen();
}

function handleNext() {
  const item = activeItem();
  if (!item) return;
  if (advancedUid === item.uid) return;
  const reading = scale.getReading();
  const current = tare.net(reading);
  if (current == null || !evaluateReading(item.required, current).correct) return;
  advancedUid = item.uid;
  const actual = round3(current);
  const completed = state.cart.map((line, index) =>
    index === state.activeIndex ? { ...line, status: 'completed', actual } : line,
  );
  state.cart = completed;
  tare.carry(reading);
  if (state.activeIndex < state.cart.length - 1) {
    state.activeIndex += 1;
    store.saveCart(completed, null, batchState());
    tts.stopNameLoop();
    renderScreen();
  } else {
    completeWeighing(completed);
  }
}

function skipItem() {
  const item = activeItem();
  if (!item) return;
  if (advancedUid === item.uid) return;
  const isLast = state.activeIndex >= state.cart.length - 1;
  const message = isLast
    ? `Skip ${item.name}? It will be recorded with no weight, and the weighing will be closed.`
    : `Skip ${item.name}? It will be recorded with no weight and the next item will start.`;
  if (!window.confirm(message)) return;
  advancedUid = item.uid;
  const reading = scale.getReading();
  const skipped = state.cart.map((line, index) =>
    index === state.activeIndex ? { ...line, status: 'completed', actual: null } : line,
  );
  state.cart = skipped;
  tare.carry(reading);
  if (!isLast) {
    state.activeIndex += 1;
    store.saveCart(skipped, null, batchState());
    tts.stopNameLoop();
    renderScreen();
  } else {
    completeWeighing(skipped);
  }
}

function completeWeighing(completed) {
  // Data logging is gone: the weighing simply ends here. The results stay on
  // the completion screen (and can be printed) but nothing is stored.
  state.stage = 'complete';
  stopTerminalTimers();
  store.clearStoredCart();
  // More rounds to go? Hold on the summary until the operator starts the next
  // one, so the pan can be cleared first.
  state.betweenBatches = state.batchIndex < state.batchTotal;
  renderScreen();
}

// Reset the queue to "pending" and weigh it again as the next batch.
function startNextBatch() {
  if (state.batchIndex >= state.batchTotal) return;
  state.batchIndex += 1;
  state.betweenBatches = false;
  state.cart = state.cart.map((line) => ({ ...line, status: 'pending', actual: null }));
  state.activeIndex = 0;
  advancedUid = null;
  tare.zeroAt(scale.getReading());
  state.stage = 'weighing';
  store.saveCart(state.cart, null, batchState());
  renderScreen();
}

// Abandon the rounds still to go and finish on the batch just saved.
function stopBatches() {
  if (state.batchIndex >= state.batchTotal) return;
  state.batchTotal = state.batchIndex;
  state.betweenBatches = false;
  renderCompleteStatus();
}

function cancelWeighing() {
  if (state.cart.length > 0) {
    const completed = state.cart.filter((line) => line.status === 'completed').length;
    const message =
      completed > 0
        ? `Cancel this weighing? ${completed} completed line${completed === 1 ? '' : 's'} will be discarded and nothing will be recorded.`
        : 'Cancel this weighing and clear the list?';
    if (!window.confirm(message)) return;
  }
  state.stage = 'select';
  terminalRefs = null;
  stopTerminalTimers();
  tts.stopSpeaking();
  state.cart = [];
  state.activeIndex = 0;
  advancedUid = null;
  tare.reset();
  state.batchTotal = 1;
  state.batchIndex = 1;
  state.betweenBatches = false;
  state.resumed = false;
  store.clearStoredCart();
  renderScreen();
}

function startNewWeighing() {
  state.stage = 'select';
  terminalRefs = null;
  stopTerminalTimers();
  tts.stopSpeaking();
  state.cart = [];
  state.activeIndex = 0;
  advancedUid = null;
  tare.reset();
  state.batchTotal = 1;
  state.batchIndex = 1;
  state.betweenBatches = false;
  state.selectedItemId = null;
  state.reqInput = '';
  state.reqError = '';
  state.resumed = false;
  store.clearStoredCart();
  renderScreen();
}

// ---------------------------------------------------------------------------
// WEIGHING — completion
// ---------------------------------------------------------------------------

function renderComplete(main) {
  const wrap = document.createElement('div');
  wrap.className = 'panel complete-panel';
  wrap.id = 'complete-panel';
  main.append(wrap);
  renderCompleteStatus();
}

function renderCompleteStatus() {
  const panel = document.getElementById('complete-panel');
  if (!panel) return;
  const between = state.betweenBatches;
  const rows = state.cart
    .map(
      (line) => `
      <tr>
        <td>${escapeHtml(line.name)}</td>
        <td class="num">${fmtWeight(line.required)}</td>
        <td class="num">${line.actual == null ? '\u2014' : fmtWeight(line.actual)}</td>
      </tr>`,
    )
    .join('');
  const total = state.cart.reduce((sum, line) => sum + line.required, 0);
  const totalActual = state.cart.reduce((sum, line) => sum + (line.actual || 0), 0);

  const title = between
    ? `BATCH ${state.batchIndex} OF ${state.batchTotal} COMPLETE`
    : 'WEIGHING COMPLETE';
  const actions = between
    ? `<button class="btn btn-primary btn-lg" data-action="start-next-batch">START BATCH ${state.batchIndex + 1}</button>
       <button class="btn btn-secondary" data-action="stop-batches">STOP</button>`
    : `<button class="btn btn-primary btn-lg" data-action="start-new">START NEW WEIGHING</button>`;

  panel.innerHTML = `
    <div class="complete-head">
      <h2>${title}</h2>
      ${between ? `<p class="batch-progress">Batch ${state.batchIndex} of ${state.batchTotal} \u00B7 ${state.batchTotal - state.batchIndex} to go</p>` : ''}
    </div>
    ${
      between
        ? '<p class="batch-next-hint">Clear everything off the scale, then start the next batch.</p>'
        : ''
    }
    <table class="bill-table">
      <thead><tr><th>Item</th><th class="num">Target</th><th class="num">Actual</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><td>Total</td><td class="num">${fmtWeight(total)}</td><td class="num">${fmtWeight(totalActual)}</td></tr></tfoot>
    </table>
    <div class="complete-actions">
      ${actions}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// FORMULAS
// ---------------------------------------------------------------------------

function renderFormulas(main) {
  const editingId = state.subtab.formulaEditingId ?? null;
  const wrap = document.createElement('div');
  wrap.className = 'formula-layout';

  const list = document.createElement('section');
  list.className = 'panel';
  list.innerHTML = `
    <div class="panel-head">
      <h2>FORMULAS</h2>
      <button class="btn btn-primary btn-sm" data-action="new-formula">NEW FORMULA</button>
    </div>
    ${
      state.formulas.length === 0
        ? '<p class="muted">No formulas yet.</p>'
        : state.formulas
            .map(
              (formula) => `
      <div class="formula-card${editingId === formula.id ? ' editing' : ''}">
        <div class="formula-card-head">
          <strong>${escapeHtml(formula.name)}</strong>
          <span class="muted">${formula.itemCount} items · ${fmtWeight(formula.totalWeight)}</span>
        </div>
        <ul class="formula-lines-inline">
          ${formula.lines.map((line) => `<li>${escapeHtml(line.itemName)} — ${fmtWeight(line.requiredWeight)}</li>`).join('')}
        </ul>
        <div class="formula-card-actions">
          <button class="btn btn-secondary btn-sm" data-action="edit-formula" data-id="${formula.id}">EDIT</button>
          <button class="btn btn-danger btn-sm" data-action="delete-formula" data-id="${formula.id}">DELETE</button>
        </div>
      </div>`,
            )
            .join('')
    }
  `;
  wrap.append(list);

  const editor = document.createElement('aside');
  editor.className = 'panel';
  const editing = editingId != null ? state.formulas.find((f) => f.id === editingId) : null;
  const draft = state.subtab.formulaDraft || (editing
    ? {
        name: editing.name,
        lines: editing.lines.map((line) => ({ itemId: line.itemId, requiredWeight: line.requiredWeight })),
      }
    : { name: '', lines: [{ itemId: null, requiredWeight: '' }] });
  state.subtab.formulaDraft = draft;

  editor.innerHTML = `
    <div class="panel-head">
      <h2>${editingId != null ? 'EDIT FORMULA' : 'NEW FORMULA'}</h2>
      ${editingId != null ? '<button class="btn btn-secondary btn-sm" data-action="cancel-formula">CANCEL</button>' : ''}
    </div>
    <label class="field-label">Formula name</label>
    <input class="text-input" id="formula-name" data-action="formula-name" value="${escapeHtml(draft.name)}" placeholder="e.g. Layer Starter" />
    <label class="field-label">Ingredients</label>
    <div class="draft-lines">
      ${draft.lines
        .map(
          (line, index) => `
        <div class="draft-line">
          <select class="select-input" data-action="draft-item" data-index="${index}">
            <option value="">— select item —</option>
            ${state.items
              .map(
                (item) =>
                  `<option value="${item.id}"${item.id === line.itemId ? ' selected' : ''}>${escapeHtml(item.code)} · ${escapeHtml(item.name)}</option>`,
              )
              .join('')}
          </select>
          <input class="weight-input" data-action="draft-weight" data-index="${index}" inputmode="decimal" placeholder="kg" value="${escapeHtml(line.requiredWeight)}" />
          <div class="draft-line-order">
            <button class="btn-icon" data-action="move-draft-line" data-dir="up" data-index="${index}" title="Move up" aria-label="Move ingredient up"${index === 0 ? ' disabled' : ''}>▲</button>
            <button class="btn-icon" data-action="move-draft-line" data-dir="down" data-index="${index}" title="Move down" aria-label="Move ingredient down"${index === draft.lines.length - 1 ? ' disabled' : ''}>▼</button>
          </div>
          <button class="btn-icon" data-action="remove-draft-line" data-index="${index}" title="Remove">✕</button>
        </div>`,
        )
        .join('')}
    </div>
    <button class="btn btn-secondary btn-sm" data-action="add-draft-line">+ ADD INGREDIENT</button>
    <div class="editor-actions">
      <button class="btn btn-primary btn-lg" data-action="save-formula" data-id="${editingId ?? ''}">
        ${editingId != null ? 'SAVE CHANGES' : 'CREATE FORMULA'}
      </button>
    </div>
  `;
  wrap.append(editor);
  main.append(wrap);
}

async function saveFormula(editingId) {
  const name = document.getElementById('formula-name')?.value?.trim() || '';
  const draft = state.subtab.formulaDraft || { lines: [] };
  const body = { name, lines: draft.lines };
  try {
    if (editingId) await api.updateFormula(Number(editingId), body);
    else await api.createFormula(body);
    state.subtab.formulaDraft = null;
    state.subtab.formulaEditingId = null;
    await loadFormulas();
    renderScreen();
  } catch (err) {
    window.alert(err?.message || String(err));
  }
}

async function deleteFormula(id) {
  if (!window.confirm('Delete this formula?')) return;
  try {
    await api.deleteFormula(Number(id));
    if (state.subtab.formulaEditingId === Number(id)) {
      state.subtab.formulaEditingId = null;
      state.subtab.formulaDraft = null;
    }
    await loadFormulas();
    renderScreen();
  } catch (err) {
    window.alert(err?.message || String(err));
  }
}

// ---------------------------------------------------------------------------
// ITEM MASTER
// ---------------------------------------------------------------------------

function renderItems(main) {
  const editingId = state.subtab.itemEditingId ?? null;
  const editing = editingId != null ? state.items.find((it) => it.id === editingId) || null : null;
  const wrap = document.createElement('div');
  wrap.className = 'two-col';
  const list = document.createElement('section');
  list.className = 'panel';
  list.innerHTML = `
    <div class="panel-head"><h2>ITEM MASTER</h2><span class="muted">${state.items.length} items</span></div>
    <div class="items-table">
      ${state.items
        .map(
          (item) => `
        <div class="item-row${item.id === editingId ? ' editing' : ''}">
          ${
            item.imagePath
              ? `<img class="item-thumb" src="${escapeHtml(item.imagePath)}" alt="" />`
              : `<span class="item-thumb placeholder">${escapeHtml(item.code)}</span>`
          }
          <div class="item-row-main">
            <strong>${escapeHtml(item.name)}</strong>
            <span class="muted">${escapeHtml(item.code)} · ${escapeHtml(item.slug)}</span>
            <span class="muted native">${escapeHtml([item.names.hi, item.names.bn, item.names.ta].filter(Boolean).join(' · '))}</span>
          </div>
          <div class="item-row-actions">
            <button class="btn btn-secondary btn-sm" data-action="edit-item" data-id="${item.id}">EDIT</button>
            <button class="btn btn-secondary btn-sm" data-action="pick-image" data-id="${item.id}" data-name="${escapeHtml(item.name)}">PHOTO</button>
            ${item.imagePath ? `<button class="btn btn-secondary btn-sm" data-action="remove-image" data-id="${item.id}">CLEAR</button>` : ''}
            <button class="btn btn-secondary btn-sm" data-action="regen-item" data-id="${item.id}">REGENERATE</button>
            <button class="btn btn-danger btn-sm" data-action="delete-item" data-id="${item.id}">DELETE</button>
          </div>
        </div>`,
        )
        .join('')}
    </div>
  `;
  wrap.append(list);

  const editor = document.createElement('aside');
  editor.className = 'panel';
  editor.innerHTML = `
    <div class="panel-head">
      <h2>${editing ? 'EDIT ITEM' : 'ADD ITEM'}</h2>
      ${editing ? '<button class="btn btn-secondary btn-sm" data-action="cancel-item">CANCEL</button>' : ''}
    </div>
    <label class="field-label">English name</label>
    <input class="text-input" id="new-item-name" placeholder="e.g. Rice" value="${editing ? escapeHtml(editing.name) : ''}" />
    <label class="field-label">Hindi name (optional)</label>
    <input class="text-input" id="new-item-hi" placeholder="translated automatically if left blank" value="${editing ? escapeHtml(editing.names.hi) : ''}" />
    <div class="editor-actions">
      <button class="btn btn-primary btn-lg" data-action="save-item" data-id="${editing ? editing.id : ''}">${editing ? 'SAVE CHANGES' : 'ADD ITEM'}</button>
    </div>
  `;
  wrap.append(editor);
  main.append(wrap);
}

async function saveItem(id) {
  const name = document.getElementById('new-item-name')?.value?.trim() || '';
  const body = {
    name,
    name_hi: document.getElementById('new-item-hi')?.value || '',
  };
  try {
    if (id) await api.updateItem(Number(id), body);
    else await api.createItem(body);
    state.subtab.itemEditingId = null;
    await loadItems();
    await loadFormulas();
    renderScreen();
  } catch (err) {
    window.alert(err?.message || String(err));
  }
}

async function deleteItem(id) {
  try {
    await api.deleteItem(Number(id));
    await loadItems();
    await loadFormulas();
    renderScreen();
  } catch (err) {
    window.alert(err?.message || String(err));
  }
}

async function regenerateItem(id) {
  try {
    await api.regenerateItem(Number(id));
    await loadItems();
    renderScreen();
  } catch (err) {
    window.alert(err?.message || String(err));
  }
}

function pickImage(id) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await fileToDataUrl(file);
      await api.setItemImage(Number(id), dataUrl);
      await loadItems();
      renderScreen();
    } catch (err) {
      window.alert(err instanceof ImageTooLargeError ? err.message : err?.message || String(err));
    }
  });
  input.click();
}

async function removeImage(id) {
  try {
    await api.deleteItemImage(Number(id));
    await loadItems();
    renderScreen();
  } catch (err) {
    window.alert(err?.message || String(err));
  }
}

// ---------------------------------------------------------------------------
// Overlays: scale, server, font size
// ---------------------------------------------------------------------------

function openOverlay(html) {
  const overlay = document.getElementById('overlay');
  overlay.className = 'overlay';
  overlay.innerHTML = `<div class="modal">${html}</div>`;
}

function closeOverlay() {
  const overlay = document.getElementById('overlay');
  overlay.className = 'overlay hidden';
  overlay.innerHTML = '';
}

function openScalePanel() {
  const device = scale.getDevice();
  const info = scale.getScaleInfo();
  openOverlay(`
    <div class="modal-head"><h2>SCALE</h2><button class="btn-icon" data-action="close-overlay">✕</button></div>
    <p class="status-line ${device.connected ? 'online' : 'offline'}" id="server-scale-status">
      ${device.connected ? `Connected on ${escapeHtml(device.port || '')}` : 'Not connected'}
      ${device.message ? ` — ${escapeHtml(device.message)}` : ''}
    </p>
    <label class="field-label">Serial port</label>
    <div class="row">
      <select class="select-input" id="scale-port">
        <option value="">— detected ports —</option>
        ${info.ports.map((p) => `<option value="${escapeHtml(p)}"${p === info.port ? ' selected' : ''}>${escapeHtml(p)}</option>`).join('')}
        <option value="${escapeHtml(info.port)}"${info.ports.includes(info.port) ? '' : ' selected'}>${escapeHtml(info.port)}</option>
      </select>
      <button class="btn btn-secondary btn-sm" data-action="refresh-ports">RESCAN</button>
    </div>
    <label class="field-label">Baud rate</label>
    <select class="select-input" id="scale-baud">
      ${info.baudRates.map((rate) => `<option value="${rate}"${rate === device.baudRate ? ' selected' : ''}>${rate}</option>`).join('')}
    </select>
    <div class="editor-actions">
      <button class="btn btn-primary" data-action="connect-scale" ${info.deviceBusy ? 'disabled' : ''}>CONNECT</button>
      <button class="btn btn-secondary" data-action="disconnect-scale" ${info.deviceBusy ? 'disabled' : ''}>DISCONNECT</button>
    </div>
  `);
}

function cycleFontScale() {
  const current = store.getRaw(store.FONT_SCALE_KEY) || 'md';
  const index = Math.max(0, FONT_SCALE_STEPS.findIndex((s) => s.id === current));
  const next = FONT_SCALE_STEPS[(index + 1) % FONT_SCALE_STEPS.length];
  store.setRaw(store.FONT_SCALE_KEY, next.id);
  applyFontScale();
  showToast(`Text size: ${next.label}`);
  const label = document.getElementById('font-scale-label');
  if (label) label.textContent = next.label;
}

async function doShutdown() {
  if (shutdownState === 'armed') {
    shutdownState = 'sent';
    updateShutdownButton();
    try {
      await api.shutdown();
      document.body.innerHTML = '<div class="shutdown-screen">Shutting down…</div>';
    } catch (err) {
      shutdownState = 'error';
      updateShutdownButton();
      shutdownLater(5000);
      showToast(err?.message || String(err));
    }
    return;
  }
  shutdownState = 'armed';
  updateShutdownButton();
  shutdownLater(6000);
}

let toastTimer = null;
function showToast(message) {
  let node = document.getElementById('toast');
  if (!node) {
    node = document.createElement('div');
    node.id = 'toast';
    node.className = 'toast';
    document.body.append(node);
  }
  node.textContent = message;
  node.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 2200);
}

function generateAutoImage(id, name) {
  if (!id) return;
  const inputName = document.getElementById('new-item-name')?.value || '';
  const label = (name || inputName || '').trim();
  if (!label) {
    window.alert('Enter an item name first');
    return;
  }
  showToast('Fetching image...');
  const seed = encodeURIComponent(label.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
  const url = `https://picsum.photos/seed/${seed}/512/512`;
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 512;
      canvas.height = 512;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('canvas');
      ctx.drawImage(img, 0, 0, 512, 512);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
      showToast('Saving image...');
      api
        .setItemImage(id, dataUrl)
        .then((item) => {
          state.items = state.items.map((it) => (it.id === item.id ? item : it));
          renderScreen();
          showToast('Image added');
        })
        .catch((err) => {
          window.alert(err?.message || String(err));
        });
    } catch (e) {
      window.alert('Could not use image. Try again or upload manually.');
    }
  };
  img.onerror = () => {
    window.alert('Failed to fetch image. Check internet connection.');
  };
  img.src = url;
}

// ---------------------------------------------------------------------------
// Event handling
// ---------------------------------------------------------------------------

function onClick(event) {
  alerts.primeAlertAudio();
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  const id = target.dataset.id;
  const index = target.dataset.index;

  switch (action) {
    case 'nav':
      state.screen = target.dataset.screen;
      if (state.screen !== 'weighing') stopTerminalTimers();
      renderScreen();
      break;
    case 'select-item':
      state.selectedItemId = Number(id);
      state.selectedFormulaId = null;
      state.reqInput = '';
      state.reqError = '';
      renderScreen();
      break;
    case 'select-formula': {
      const formula = state.formulas.find((f) => f.id === Number(id));
      if (formula) {
        loadFormula(formula);
        break;
      }
      state.selectedFormulaId = Number(id);
      state.selectedItemId = null;
      state.reqInput = '';
      state.reqError = '';
      renderScreen();
      break;
    }
    case 'load-formula': {
      const formula = state.formulas.find((f) => f.id === Number(id));
      if (formula) loadFormula(formula);
      break;
    }
    case 'remove-line':
      state.cart = state.cart.filter((line) => line.uid !== target.dataset.uid);
      store.saveCart(state.cart, null, batchState());
      renderScreen();
      break;
    case 'add-to-cart':
      addToCart();
      break;
    case 'batch-down':
      state.batchTotal = Math.max(1, state.batchTotal - 1);
      state.batchIndex = Math.min(state.batchIndex, state.batchTotal);
      renderScreen();
      break;
    case 'batch-up':
      state.batchTotal = Math.min(MAX_BATCHES, state.batchTotal + 1);
      renderScreen();
      break;
    case 'start-weighing':
      beginWeighing();
      break;
    case 'start-next-batch':
      startNextBatch();
      break;
    case 'stop-batches':
      stopBatches();
      break;
    case 'terminal-zero':
      tare.zeroAt(scale.getReading());
      updateTerminal();
      break;
    case 'terminal-next':
      handleNext();
      break;
    case 'terminal-skip':
      skipItem();
      break;
    case 'terminal-cancel':
      cancelWeighing();
      break;
    case 'start-new':
      startNewWeighing();
      break;
    case 'new-formula':
      state.subtab.formulaEditingId = null;
      state.subtab.formulaDraft = { name: '', lines: [{ itemId: null, requiredWeight: '' }] };
      renderScreen();
      scrollEditorIntoView();
      break;
    case 'edit-formula': {
      const formula = state.formulas.find((f) => f.id === Number(id));
      if (!formula) break;
      state.subtab.formulaEditingId = formula.id;
      state.subtab.formulaDraft = {
        name: formula.name,
        lines: formula.lines.map((line) => ({ itemId: line.itemId, requiredWeight: line.requiredWeight })),
      };
      renderScreen();
      scrollEditorIntoView();
      break;
    }
    case 'cancel-formula':
      state.subtab.formulaEditingId = null;
      state.subtab.formulaDraft = null;
      renderScreen();
      break;
    case 'add-draft-line':
      state.subtab.formulaDraft.lines.push({ itemId: null, requiredWeight: '' });
      renderScreen();
      break;
    case 'remove-draft-line':
      state.subtab.formulaDraft.lines.splice(Number(index), 1);
      if (state.subtab.formulaDraft.lines.length === 0) {
        state.subtab.formulaDraft.lines.push({ itemId: null, requiredWeight: '' });
      }
      renderScreen();
      break;
    case 'move-draft-line': {
      // Reorder the ingredient rows. The array order is what the server stores
      // as each line's `position`, and that order is what the staff terminal
      // weighs in, so moving a row here changes the weighing sequence.
      const lines = state.subtab.formulaDraft.lines;
      const from = Number(index);
      const to = target.dataset.dir === 'up' ? from - 1 : from + 1;
      if (from >= 0 && from < lines.length && to >= 0 && to < lines.length) {
        [lines[from], lines[to]] = [lines[to], lines[from]];
        renderScreen();
      }
      break;
    }
    case 'save-formula':
      saveFormula(id ? Number(id) : null);
      break;
    case 'delete-formula':
      deleteFormula(id);
      break;
    case 'save-item':
      saveItem(id ? Number(id) : null);
      break;
    case 'edit-item':
      state.subtab.itemEditingId = Number(id);
      renderScreen();
      break;
    case 'cancel-item':
      state.subtab.itemEditingId = null;
      renderScreen();
      break;
    case 'delete-item':
      deleteItem(id);
      break;
    case 'regen-item':
      regenerateItem(id);
      break;
    case 'pick-image':
      pickImage(id);
      break;
    case 'remove-image':
      removeImage(id);
      break;
    case 'auto-image':
      generateAutoImage(id ? Number(id) : null, target.dataset.name || '');
      break;
    case 'open-scale':
      openScalePanel();
      break;
    case 'close-overlay':
      closeOverlay();
      break;
    case 'refresh-ports':
      scale.refreshScaleInfo().then(openScalePanel);
      break;
    case 'connect-scale': {
      const port = document.getElementById('scale-port')?.value;
      const baudRate = Number(document.getElementById('scale-baud')?.value) || undefined;
      scale.connect({ port, baudRate }).then(openScalePanel);
      break;
    }
    case 'disconnect-scale':
      scale.disconnect().then(openScalePanel);
      break;
    case 'toggle-alerts':
      alerts.toggleAlertsEnabled();
      updateAlertsToggle();
      break;
    case 'font-size':
      cycleFontScale();
      break;
    case 'shutdown':
      doShutdown();
      break;
    default:
      break;
  }
}

// A tiny helper so an async throw inside the switch cannot go unhandled.
function await0(promise) {
  promise.catch((err) => window.alert(err?.message || String(err)));
}

function onInput(event) {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  if (action === 'req-input') {
    state.reqInput = target.value;
    updateReqRounding();
  } else if (action === 'item-search') {
    state.search = target.value;
    // Re-render only the grid to keep the caret.
    const grid = document.querySelector('.item-grid');
    if (grid) {
      const needle = state.search.trim().toLowerCase();
      const filtered = state.items.filter(
        (item) => !needle || item.name.toLowerCase().includes(needle) || item.code.toLowerCase().includes(needle),
      );
      grid.innerHTML = filtered
        .map(
          (item) => `
        <button class="item-card${item.id === state.selectedItemId ? ' selected' : ''}" data-action="select-item" data-id="${item.id}">
          ${
            item.imagePath
              ? `<img class="item-thumb" src="${escapeHtml(item.imagePath)}" alt="" />`
              : `<span class="item-thumb placeholder">${escapeHtml(item.code)}</span>`
          }
          <span class="item-name">${escapeHtml(item.name)}</span>
          <span class="item-code">${escapeHtml(item.code)}</span>
        </button>`,
        )
        .join('');
    }
  } else if (action === 'draft-weight') {
    const line = state.subtab.formulaDraft?.lines[Number(target.dataset.index)];
    if (line) line.requiredWeight = target.value;
  } else if (action === 'formula-name') {
    if (state.subtab.formulaDraft) state.subtab.formulaDraft.name = target.value;
  }
}

function onChange(event) {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  if (target.dataset.action === 'draft-item') {
    const line = state.subtab.formulaDraft?.lines[Number(target.dataset.index)];
    if (line) line.itemId = target.value ? Number(target.value) : null;
  }
}

function updateReqRounding() {
  const node = document.querySelector('.rounding-note');
  const note = targetRoundingNote(parseWeight(state.reqInput) ?? NaN);
  if (!node && note) {
    const input = document.getElementById('req-input');
    if (input) {
      const p = document.createElement('p');
      p.className = 'rounding-note';
      p.textContent = note;
      input.after(p);
    }
    return;
  }
  if (node) {
    if (note) node.textContent = note;
    else node.remove();
  }
}

function onKeydown(event) {
  if (event.key === 'Escape') closeOverlay();
  if (!event.ctrlKey || !event.altKey) return;
  if (event.key.toLowerCase() !== 'a' && event.code !== 'KeyA') return;
  // Ctrl+Alt+A hands the admin kiosk back to the staff station (staff.js
  // sends it the other way), so the combo toggles between the two pages.
  event.preventDefault();
  window.location.replace(`/staff/?panel=${Date.now().toString(36)}`);
}

function loadFormula(formula) {
  const lines = formula.lines.map((line) => {
    const item = state.items.find((candidate) => candidate.id === line.itemId);
    return {
      uid: uid(),
      id: line.itemId ?? null,
      slug: item ? item.slug : '',
      name: item ? item.name : line.itemName,
      names: item ? item.names : { en: line.itemName, hi: '', bn: '', ta: '' },
      imagePath: item ? item.imagePath ?? null : null,
      required: roundTargetWeight(line.requiredWeight),
      status: 'pending',
      formulaId: formula.id,
      formulaName: formula.name,
    };
  });
  if (lines.length === 0) return;
  state.cart = lines;
  state.selectedFormulaId = null;
  state.resumed = false;
  store.clearStoredCart();
  store.saveCart(lines, formula.id);
  tts.stopSpeaking();
  renderScreen();
}

// The lock screen is the entry point: every load starts here, and only a
// correct PIN calls boot() to open the terminal.
renderPinLock();
