// DOUBLES POULTRY FARM — staff weighing terminal.
//
// The staff terminal is its own front end, mirroring the reference staff-app:
// it weighs formulas, never single items, and never lets an operator type a
// weight by hand. A formula is loaded from the list, every line is poured onto
// the scale in turn, and the finished cart is posted to the server as one bill.
//
// It reuses the same shared modules as the admin kiosk (weights, tare, alerts,
// tts, scale, api, storage). Only the shell and the screens live here.

import {
  api, getServerOrigin,
  scale, alerts, tts, store,
  TareBaseline, ScaleLcd,
  evaluateReading, round3, roundOffWeight, roundTargetWeight,
  fmtWeight, fmtWeightNoUnit,
  BRAND, LOGO_SRC, FONT_SCALE_STEPS, AUTO_ADVANCE_MS,
  uid, escapeHtml, installScreenFit,
} from './lib.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

// No language picker any more: every announcement leads in English and the
// underweight repeat walks the remaining languages on its own.
const voiceLang = 'en';
// The operator can repeat the whole formula this many times at most.
const MAX_BATCHES = 50;

const root = document.getElementById('app');

const state = {
  stage: 'select', // 'select' | 'batches' | 'weighing' | 'between' | 'done'
  items: [],
  formulas: [],
  itemsLoading: true,
  loadError: '',
  cart: [],
  activeIndex: 0,
  resumed: false,
  batchTotal: 1,
  batchIndex: 1,
  // Keyboard-only operation: the operator moves with the arrow keys and
  // confirms with Enter. kbIndex is the highlighted formula row; batchFormula
  // is the formula picked while the batch count is being entered.
  kbIndex: 0,
  batchFormula: null,
};

const tare = new TareBaseline();

// A tap on NEXT can land in the same moment the auto-advance timer fires.
let advancedUid = null;

let terminalRefs = null;
let scaleLcd = null;
let voiceKey = null;
let shutdownState = 'idle';
let shutdownTimer = null;

let advanceToken = null;
let advanceTimer = null;
let advanceTick = null;
let advanceRemaining = 0;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const errText = (err) => (err instanceof Error ? err.message : String(err));

function itemImageUrl(path) {
  if (!path) return null;
  const origin = getServerOrigin();
  return `${origin}${path.startsWith('/') ? '' : '/'}${path}`;
}

function deviceStateLabel(device) {
  if (!device) return 'OFFLINE';
  if (device.status === 'connected') return 'ONLINE';
  if (device.status === 'connecting') return 'CONNECTING';
  if (device.status === 'reconnecting') return 'RECONNECTING';
  if (device.status === 'failed') return 'UNAVAILABLE';
  return 'OFFLINE';
}

const activeItem = () => (state.stage === 'weighing' ? state.cart[state.activeIndex] || null : null);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  applyFontScale();
  installScreenFit();
  renderShell();
  installPanelSwitch();
  installKeyboardNav();

  document.addEventListener('click', onClick);
  document.addEventListener('change', onChange);
  window.addEventListener('beforeunload', () => tts.stopSpeaking());
  // Install --screen-fit (grows the root font on bigger screens); the
  // debounced re-fit below additionally re-fills each stretched box's text
  // whenever the viewport shape changes afterwards.
  window.addEventListener('resize', scheduleStageFit, { passive: true });
  window.addEventListener('orientationchange', scheduleStageFit, { passive: true });

  scale.subscribe(onScaleChange);
  await scale.initScale();

  await loadData();
  restore();
  renderStage();
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

async function loadData() {
  state.itemsLoading = true;
  state.loadError = '';
  renderStage();
  const [itemResult, formulaResult] = await Promise.allSettled([
    api.getItems(),
    api.getFormulas(),
  ]);
  const problems = [];
  if (itemResult.status === 'fulfilled') {
    state.items = Array.isArray(itemResult.value) ? itemResult.value : [];
  } else {
    problems.push(`items: ${errText(itemResult.reason)}`);
  }
  if (formulaResult.status === 'fulfilled') {
    state.formulas = Array.isArray(formulaResult.value) ? formulaResult.value : [];
  } else {
    problems.push(`formulas: ${errText(formulaResult.reason)}`);
  }
  state.loadError = problems.join(' · ');
  state.itemsLoading = false;
  if (state.items.length > 0) tts.preloadAll(state.items);
  renderStage();
}

// Resume a weighing interrupted by a refresh or a locked screen. Completed
// lines keep the weight already measured and the terminal picks up at the
// first line still to do. (Data logging is gone, so there is no saved-bill
// recovery any more — only a weighing interrupted mid-way resumes.)
function restore() {
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
  // The finished lines are still on the pan, so whatever the scale reads now
  // becomes the zero the resumed line is measured against.
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

function renderShell() {
  root.className = '';
  root.innerHTML = `
    <header class="app-header staff-header">
      <div class="brand">
        <span class="brand-text"><span class="brand-name">${escapeHtml(BRAND)}</span></span>
      </div>
      <div class="header-right">
        <div class="header-controls" id="header-controls"></div>
        <img class="app-logo" src="${escapeHtml(LOGO_SRC)}" alt="Reem Engineering Enterprises" />
      </div>
    </header>
    <main id="screen-main"></main>
    <footer class="app-footer">© Copyright Reem Engineering Enterprises</footer>
  `;
  renderHeaderControls();
}

function renderHeaderControls() {
  const host = document.getElementById('header-controls');
  if (!host) return;
  const idx = Math.max(
    0,
    FONT_SCALE_STEPS.findIndex((s) => s.id === currentFontStepId()),
  );
  const step = FONT_SCALE_STEPS[idx];
  const info = scale.getScaleInfo();
  host.innerHTML = `
    <div class="font-size-control">
      <button class="font-size-btn" data-action="font-down" ${idx <= 0 ? 'disabled' : ''} aria-label="Decrease text size" title="Smaller text">A\u2212</button>
      <span class="font-size-value" aria-live="polite">${escapeHtml(step.label)}</span>
      <button class="font-size-btn" data-action="font-up" ${idx >= FONT_SCALE_STEPS.length - 1 ? 'disabled' : ''} aria-label="Increase text size" title="Larger text">A+</button>
    </div>
    <button class="alert-toggle" data-action="toggle-alerts" id="t-alerts" aria-pressed="true"></button>
    <div class="scale-settings" id="scale-settings">
      <button class="scale-settings-btn" data-action="toggle-scale" aria-expanded="false" title="${escapeHtml(scaleLinkLabel())}">
        <span class="scale-settings-glyph" aria-hidden="true">\u2699</span>
        <span class="scale-settings-mode">SCALE</span>
        <span class="scale-settings-dot ${scaleLinkState()}" aria-hidden="true"></span>
      </button>
      <div class="scale-settings-panel hidden" id="scale-panel" role="dialog" aria-label="Scale settings"></div>
    </div>
    <button class="btn btn-danger btn-sm shutdown-btn" data-action="shutdown" title="Turn the machine off. Tap once to arm, tap again to confirm.">\u23FB SHUTDOWN</button>
  `;
  void info;
  updateAlertsToggle();
}

// ---------------------------------------------------------------------------
// Auto-fit stage text: fill the stretched boxes
// ---------------------------------------------------------------------------
// The portrait kiosk layout stretches every weighing block to share the free
// screen height (CSS: .sketch-block / .scale-lcd / .scale-cumulative each get
// flex share). That leaves vertical whitespace inside each box at font sizes
// tuned for the reference viewport. This measurement-driven routine scales
// the DISPLAY text of each block until it fills its box — no magic numbers:
// everything is computed from the live box and text geometry, redone on
// render, resize and reading updates.

const AUTO_FIT_TARGETS = [
  // The three sketch rows fit against their whole .sketch-block: the caption
  // above and the hint beside the text are fixed cost, the NAME grows until
  // the block is full or the width runs out. Fitting the inner row instead
  // made every name stop at a different size (formula tiny, item big) — the
  // small stylesheet baselines all hit the growth cap.
  { box: '.sketch-block:nth-of-type(1)', el: '.current-formula' },
  { box: '.sketch-block:nth-of-type(2)', el: '.current-item-name' },
  { box: '.sketch-block:nth-of-type(3)', el: '.sketch-target-value' },
  // The LCD rows are single-line displays: their row box is the budget.
  { box: '.scale-lcd', el: '.scale-reading' },
  { box: '.scale-cumulative', el: '.scale-cumulative-value' },
];

const FIT_MIN_FACTOR = 0.5;
const FIT_MAX_FACTOR = 24;
const FIT_REFINE_STEPS = 14;
const FIT_REFINE_SHRINK = 0.92;

function elBox(el) {
  const cs = getComputedStyle(el);
  return {
    top: parseFloat(cs.paddingTop) || 0,
    bottom: parseFloat(cs.paddingBottom) || 0,
    left: parseFloat(cs.paddingLeft) || 0,
    right: parseFloat(cs.paddingRight) || 0,
    marginTop: parseFloat(cs.marginTop) || 0,
    marginBottom: parseFloat(cs.marginBottom) || 0,
    marginLeft: parseFloat(cs.marginLeft) || 0,
    marginRight: parseFloat(cs.marginRight) || 0,
  };
}

// The direct child of `box` that holds (or is) the growing text.
function growingChildOf(box, target) {
  for (const child of box.children) {
    if (child === target || child.contains(target)) return child;
  }
  return null;
}

// Vertical space inside `box` that the target text may occupy: everything
// except the grower (captions, hints, units) is fixed cost, flex gaps
// included. Row containers (LCD displays) cost no column height for
// siblings.
function freeHeightOf(box, target) {
  const pad = elBox(box);
  const inner = box.clientHeight - pad.top - pad.bottom;
  const cs = getComputedStyle(box);
  const isColumn = cs.flexDirection === 'column' || cs.display === 'block';
  if (!isColumn) return Math.max(0, inner);
  const grower = growingChildOf(box, target);
  let used = 0;
  for (const child of box.children) {
    if (child === grower) continue;
    const m = elBox(child);
    used += child.offsetHeight + m.marginTop + m.marginBottom;
  }
  // Column flex gap sits between every pair of items — including between
  // the fixed children and the (still occupying) grower slot.
  const rowGap = parseFloat(cs.rowGap) || 0;
  used += (box.children.length - 1) * rowGap;
  return Math.max(0, inner - used);
}

// True when, at the CURRENT font size, the content leaves its box: the row
// scrolls horizontally (single-line text too wide) or the block scrolls
// vertically / horizontally (wrapped text too tall).
function fitOverflows(box, target) {
  const row = target.parentElement;
  if (row && row.scrollWidth > row.clientWidth + 1) return true;
  return (
    box.scrollHeight > box.clientHeight + 1 ||
    box.scrollWidth > box.clientWidth + 1
  );
}

function fitOnePair(box, target) {
  if (!box || !target) return false;
  if (box.offsetParent === null || box.clientHeight === 0) return false;
  // Reset to the stylesheet baseline so repeated runs never compound.
  target.style.fontSize = '';
  const base = parseFloat(getComputedStyle(target).fontSize);
  const natural = target.offsetHeight;
  if (base <= 0 || natural <= 0) return false;

  const avail = freeHeightOf(box, target);
  if (avail <= 0) return false;

  // First estimate: the name grows to the free height, assuming the line
  // count stays the same.
  let factor = Math.min(FIT_MAX_FACTOR, Math.max(FIT_MIN_FACTOR, avail / natural));

  // Width budget on a shared row (name left, hint right, unit beside a
  // reading): single-line (nowrap) text scales linearly with the font, so
  // cap the factor by the width left after the siblings.
  const row = target.parentElement;
  if (
    row &&
    row !== box &&
    getComputedStyle(target).whiteSpace === 'nowrap'
  ) {
    const rowCs = getComputedStyle(row);
    if (rowCs.display.includes('flex')) {
      const rowPad = elBox(row);
      let others = 0;
      for (const sib of row.children) {
        if (sib === target || sib.contains(target)) continue;
        const m = elBox(sib);
        others += sib.offsetWidth + m.marginLeft + m.marginRight;
      }
      const colGap =
        parseFloat(rowCs.columnGap) || parseFloat(rowCs.gap) || 0;
      const rowInner =
        row.clientWidth - rowPad.left - rowPad.right - (row.children.length - 1) * colGap;
      const naturalW = target.scrollWidth + 1;
      if (naturalW > 0 && rowInner - others > 0) {
        factor = Math.min(factor, (rowInner - others) / naturalW);
      }
    }
  }

  target.style.fontSize = `${base * factor}px`;
  // Then SHRINK while it actually overflows: wrapping names, wide digits and
  // width side-limits are all caught by the real geometry.
  for (let i = 0; i < FIT_REFINE_STEPS; i++) {
    if (!fitOverflows(box, target)) break;
    factor *= FIT_REFINE_SHRINK;
    target.style.fontSize = `${base * factor}px`;
  }
  return factor > 0;
}

function autoFitStageTexts() {
  for (const pair of AUTO_FIT_TARGETS) {
    const box = document.querySelector(pair.box);
    const target = box ? box.querySelector(pair.el) : null;
    if (target) fitOnePair(box, target);
  }
}

let fitObserverDebounce = 0;
function scheduleStageFit() {
  window.clearTimeout(fitObserverDebounce);
  fitObserverDebounce = window.setTimeout(autoFitStageTexts, 60);
}

let stageTextObserver = null;
// Re-fit whenever the LCD placeholders are replaced by real readings — the
// digit count can change what the width budget allows.
function observeStageTextChanges() {
  const lcds = document.querySelectorAll('#t-lcd, #t-cumulative');
  if (stageTextObserver) stageTextObserver.disconnect();
  stageTextObserver = new MutationObserver(scheduleStageFit);
  stageTextObserver.observe(lcds[0] || document.body, {
    childList: true, characterData: true, subtree: true,
  });
  stageTextObserver.observe(lcds[1] || document.body, {
    childList: true, characterData: true, subtree: true,
  });
}

function currentFontStepId() {
  const raw = store.getRaw(store.FONT_SCALE_KEY) || 'md';
  return FONT_SCALE_STEPS.some((s) => s.id === raw) ? raw : 'md';
}

function applyFontScale() {
  const step = FONT_SCALE_STEPS.find((s) => s.id === currentFontStepId()) || FONT_SCALE_STEPS[0];
  document.documentElement.setAttribute('data-font-scale', step.id);
}

// ---------------------------------------------------------------------------
// Stage rendering
// ---------------------------------------------------------------------------

function renderStage() {
  const main = document.getElementById('screen-main');
  if (!main) return;
  stopAutoAdvance();
  scaleLcd = null;
  terminalRefs = null;
  const banners = loadErrorBanner();
  if (state.stage === 'select') {
    main.innerHTML = banners + selectHtml();
    // Keep the keyboard-highlighted formula in view after every move.
    const active = main.querySelector('.staff-row.kb-active');
    if (active) active.scrollIntoView({ block: 'nearest' });
  } else if (state.stage === 'batches') {
    main.innerHTML = banners + batchesHtml();
    bindBatchesInput();
    // The keypad lands here typing, so the input starts focused at the end
    // of its current value.
    const input = document.getElementById('t-batch-input');
    if (input) focusBatchInput();
  } else if (state.stage === 'weighing') {
    main.innerHTML = banners + resumeBanner() + terminalHtml();
    buildTerminalRefs();
    updateTerminal();
    // Text must fill the stretched boxes: fit once the new layout has been
    // laid out, then keep re-fitting while live readings change digit count.
    requestAnimationFrame(autoFitStageTexts);
    observeStageTextChanges();
  } else if (state.stage === 'between') {
    main.innerHTML = banners + betweenHtml();
  } else {
    main.innerHTML = banners + doneHtml();
  }
  refreshScalePanel();
}

function loadErrorBanner() {
  if (!state.loadError) return '';
  return `<div class="error-banner">Could not load data: ${escapeHtml(state.loadError)} <button class="btn btn-secondary btn-sm" data-action="reload-data">RETRY</button></div>`;
}

function resumeBanner() {
  if (!state.resumed || state.stage !== 'weighing') return '';
  return `<div class="error-banner resume-banner">This weighing was restored after the page reloaded. Lines already weighed are marked complete; check the queue, then carry on from the first line still to do. <button class="btn btn-secondary btn-sm" data-action="discard">DISCARD</button></div>`;
}

function selectHtml() {
  const formulas = state.formulas;
  // The keyboard highlight must always point at a real row, even after the
  // list shrinks between renders.
  const kbIndex = Math.min(state.kbIndex, Math.max(0, formulas.length - 1));
  state.kbIndex = kbIndex;
  let list;
  if (state.itemsLoading) {
    list = `<div class="panel-placeholder">Loading formulas\u2026</div>`;
  } else if (formulas.length === 0) {
    list = `<div class="panel-placeholder"><p>No formulas available. Create one in the admin portal first.</p><button class="btn btn-secondary btn-sm" data-action="reload-data">RELOAD FORMULAS</button></div>`;
  } else {
    list = formulas
      .map(
        (formula, index) => `
      <button class="staff-row${index === kbIndex ? ' kb-active' : ''}" data-action="select-formula" data-id="${formula.id}">
        <div class="staff-row-main">
          <div class="staff-row-name">${escapeHtml(formula.name)}</div>
          <div class="staff-row-meta">${formula.itemCount} item${formula.itemCount === 1 ? '' : 's'} \u00B7 ${fmtWeight(formula.totalWeight)}</div>
        </div>
        <span class="staff-row-action">START</span>
      </button>`,
      )
      .join('');
  }
  return `
    <section class="stage staff-select">
      <div class="staff-select-intro">
        <div class="screen-title">STAFF WEIGHING TERMINAL</div>
        <div class="screen-sub">Load a formula and weigh each item to its exact target.</div>
      </div>
      <div class="staff-select-grid single">
        <div class="panel staff-panel staff-panel-formula">
          <div class="panel-title">
            <span class="panel-num">1</span>
            <span>LOAD A FORMULA</span>
            ${formulas.length > 0 ? `<span class="panel-count">${formulas.length}</span>` : ''}
          </div>
          <div class="staff-panel-sub">Weigh a pre-set combination exactly. The next item unlocks only once the target is met.</div>
          ${formulas.length > 0 ? '<div class="kb-hint">\u2191 \u2193 CHOOSE \u00B7 ENTER START</div>' : ''}
          <div class="staff-list-scroll">${list}</div>
        </div>
      </div>
    </section>`;
}

// The step between picking a formula and weighing: the operator sets how many
// times the queue is repeated. Arrows change the count, Enter starts — and the
// count is typable too, so a large number does not mean tapping ↑ fifty times.
function batchesHtml() {
  const formula = state.batchFormula;
  return `
    <section class="stage staff-batches">
      <div class="panel staff-batch-card">
        <div class="screen-title">NUMBER OF BATCHES</div>
        <div class="staff-batch-formula">${escapeHtml(formula ? formula.name : '\u2014')}</div>
        <div class="staff-batch-count">
          <button class="stepper-btn" data-action="batch-down" ${state.batchTotal <= 1 ? 'disabled' : ''} aria-label="Fewer batches">\u2212</button>
          <input class="staff-batch-number" id="t-batch-input" type="text" inputmode="numeric"
                 autocomplete="off" maxlength="3" aria-label="Number of batches"
                 value="${state.batchTotal}" />
          <button class="stepper-btn" data-action="batch-up" ${state.batchTotal >= MAX_BATCHES ? 'disabled' : ''} aria-label="More batches">+</button>
        </div>
        <div class="staff-batch-note" aria-live="polite">${state.batchTotal === 1 ? 'Weigh the formula once.' : `The formula is weighed ${state.batchTotal} times \u2014 each round is its own batch.`}</div>
        <div class="kb-hint">\u2191 MORE \u00B7 \u2193 LESS \u00B7 OR TYPE THE NUMBER \u00B7 ENTER START</div>
        <button class="btn btn-primary btn-lg" data-action="confirm-batches">START WEIGHING</button>
      </div>
    </section>`;
}

// Keep the batches view (number, note, stepper states) in sync without a full
// re-render — re-rendering would rebuild the input and drop the operator's
// focus while typing.
function batchNoteText() {
  return state.batchTotal === 1
    ? 'Weigh the formula once.'
    : `The formula is weighed ${state.batchTotal} times \u2014 each round is its own batch.`;
}

function syncBatchesView() {
  const input = document.getElementById('t-batch-input');
  if (input && document.activeElement !== input) input.value = String(state.batchTotal);
  const note = document.querySelector('.staff-batch-note');
  if (note) note.textContent = batchNoteText();
  const down = document.querySelector('.staff-batch-count [data-action="batch-down"]');
  const up = document.querySelector('.staff-batch-count [data-action="batch-up"]');
  if (down) down.disabled = state.batchTotal <= 1;
  if (up) up.disabled = state.batchTotal >= MAX_BATCHES;
}

// Read the typed value, clamp it to 1..MAX_BATCHES and write it back.
function clampBatchInput() {
  const input = document.getElementById('t-batch-input');
  const digits = String(input?.value ?? '').replace(/\D/g, '');
  const value = Number(digits);
  state.batchTotal = Number.isFinite(value) && value > 0 ? Math.min(MAX_BATCHES, value) : 1;
  if (input) input.value = String(state.batchTotal);
  syncBatchesView();
}

// The batch number input: focus it and select its whole value, so the keypad
// replaces the number with the first keystroke instead of appending.
function focusBatchInput() {
  const input = document.getElementById('t-batch-input');
  if (!input) return;
  input.focus();
  input.select();
}

// Typing events for the numeric input on the batches screen.
function bindBatchesInput() {
  const input = document.getElementById('t-batch-input');
  if (!input) return;
  input.addEventListener('input', () => {
    // Digits only, no leading zeros.
    let digits = input.value.replace(/\D/g, '').replace(/^0+(?=\d)/, '').slice(0, 3);
    if (digits !== input.value) input.value = digits;
    if (digits === '') return;
    const value = Number(digits);
    if (value > MAX_BATCHES) {
      digits = String(MAX_BATCHES);
      input.value = digits;
    }
    state.batchTotal = Number(digits);
    syncBatchesView();
  });
}

// The weighing screen follows the operator's sketch: one clean stack of
// labelled boxes — formula, item (with the next one named), target, running
// readouts and, at the bottom, the verdict. The queue, the top bar and the
// manual SKIP/CANCEL buttons are gone; the alerts toggle lives in the app
// header now, and the auto-advance countdown is the only way a line moves on.
function terminalHtml() {
  const item = activeItem();
  if (!item) return '';
  const next = state.cart[state.activeIndex + 1] || null;
  return `
    <section class="stage terminal">
      <div class="terminal-layout">
        <div class="panel scale-panel">
          <div class="sketch-block">
            <div class="scale-caption">Formula Name</div>
            <div class="current-item-names">
              <div class="current-formula">${escapeHtml(item.formulaName || '\u2014')}</div>
              <div class="next-item-hint batch-hint">BATCH: ${state.batchIndex} OF ${state.batchTotal}</div>
            </div>
          </div>
          <div class="sketch-block">
            <div class="scale-caption">Item Name</div>
            <div class="current-item-names">
              <div class="current-item-name">${escapeHtml(item.name.toUpperCase())}</div>
              <div class="next-item-hint">${next ? `NEXT ITEM: <b>${escapeHtml(next.name.toUpperCase())}</b>` : 'LAST ITEM'}</div>
            </div>
          </div>
          <div class="sketch-block">
            <div class="scale-caption">Target Weight</div>
            <div class="sketch-target-value">${escapeHtml(fmtWeightNoUnit(item.required))}<span class="sketch-target-unit">kg</span></div>
          </div>
          <div class="scale-wrap">
            <div class="scale">
              <div class="scale-caption">Running Weight</div>
              <div class="scale-lcd">
                <span class="scale-reading" id="t-lcd" data-status="transit">\u2014.\u2014\u2014\u2014</span>
                <span class="scale-lcd-unit">kg</span>
              </div>
              <div class="device-error" id="t-noreading-error" hidden></div>
              <div class="scale-cumulative">
                <div class="scale-cumulative-label">Cumulative Weight</div>
                <div class="scale-cumulative-lcd">
                  <span class="scale-cumulative-value" id="t-cumulative">\u2014.\u2014\u2014\u2014</span>
                  <span class="scale-cumulative-unit">kg</span>
                </div>
              </div>
            </div>
          </div>
        </div>
        <aside class="panel input-panel">
          <div class="status-box status-device" id="t-loadremoved" role="alert" hidden>
            <div class="status-title">LOAD REMOVED</div>
            <div class="status-detail" id="t-loadremoved-detail"></div>
          </div>
          <div class="status-box status-auto-advance" id="t-advance" role="status" aria-live="polite" hidden>
            <div class="status-title" id="t-advance-title">TARGET REACHED</div>
            <div class="status-detail" id="t-advance-detail"></div>
          </div>
        </aside>
      </div>
    </section>`;
}

const REF_IDS = [
  't-alerts', 't-lcd', 't-cumulative', 't-noreading-error',
  't-loadremoved', 't-loadremoved-detail', 't-advance', 't-advance-title',
  't-advance-detail',
];

function buildTerminalRefs() {
  const refs = {};
  for (const id of REF_IDS) refs[id] = document.getElementById(id);
  terminalRefs = refs;
  scaleLcd = new ScaleLcd(refs['t-lcd']);
  voiceKey = null;
  updateAlertsToggle();
}

// ---------------------------------------------------------------------------
// Live terminal update (runs on every scale frame and every action)
// ---------------------------------------------------------------------------

function updateTerminal() {
  const refs = terminalRefs;
  const item = activeItem();
  if (!refs || !item) return;
  // No audio is stopped here. This runs on every scale frame, and clearing the
  // alert loop / name loop at the top would make the later setAlertLoop() see a
  // fresh band on every frame and replay the tones at the scale frame rate. The
  // loop itself decides when to (re)arm: setAlertLoop() no-ops while the band is
  // unchanged, and stopAlertLoop() is called when alerts are muted.

  const accumulated = scale.getReading();
  // A scale that sits below zero with an empty pan says so in its very first
  // reading. Taking that as the zero point keeps a line from recording less
  // than the operator actually poured.
  tare.adoptEmptyPan(accumulated);
  const net = tare.net(accumulated);
  const loadRemoved = tare.underBase(accumulated);
  const status = evaluateReading(item.required, net);
  const device = scale.getDevice();
  const live = scale.getLive();
  const connected = Boolean(device.connected);
  const offline = !connected;
  const scaleLabel = deviceStateLabel(device);
  const noReading = connected && net == null;

  // Terminal bar. The status word is kept short on purpose: the bar is a single
  // row at 1080px, and "AWAITING DEVICE" beside "Scale: OFFLINE" both said the
  // same thing while pushing the title past the width available. "WAITING" is
  // unambiguous next to the scale line and leaves the title intact.
  if (refs['t-status']) {
    refs['t-status'].textContent = offline ? 'WAITING' : 'READY';
    refs['t-status'].className = offline ? 'b-warn' : 'b-ready';
  }
  if (refs['t-scale']) {
    refs['t-scale'].className = `terminal-item terminal-scale terminal-scale-${scaleLabel.toLowerCase()}`;
    refs['t-scale'].innerHTML = `Scale: <b>${escapeHtml(scaleLabel)}</b>`;
  }

  // Big readout: the reading rounded to whole kilograms exactly like the target.
  const shown = net == null ? null : roundOffWeight(net);
  if (scaleLcd) scaleLcd.set(shown, live ? live.stable ?? null : null);

  // Cumulative readout: the raw figure the scale is putting out right now.
  if (refs['t-cumulative']) {
    refs['t-cumulative'].textContent = accumulated == null ? '\u2014.\u2014\u2014\u2014' : accumulated.toFixed(3);
  }

  // Zero point metric
  const zeroAt = tare.baseValue();
  const established = tare.isEstablished();
  if (refs['t-zero-label']) {
    refs['t-zero-label'].textContent =
      zeroAt > 0 ? 'Already On The Scale (zero point)' : zeroAt < 0 ? 'Scale Reads Low By (zero point)' : 'Zero Point';
  }
  if (refs['t-zero-value']) {
    refs['t-zero-value'].textContent = established ? fmtWeight(zeroAt) : 'not set yet';
  }

  // Scale trouble line: only for the case where the port is open but no valid
  // weight frames are arriving. A fully offline device stays quiet — the dashes
  // on the readouts say enough, and the server's own "Scale not available"
  // wording is not relayed here.
  const panTotal = accumulated == null ? null : roundOffWeight(accumulated);
  if (refs['t-noreading-error']) {
    refs['t-noreading-error'].hidden = !noReading;
    if (noReading) {
      const bytes = device.bytesReceived ?? 0;
      refs['t-noreading-error'].textContent = `${
        bytes > 0
          ? `Port is open and ${bytes} bytes have arrived, but none are valid YH-T7E weight frames.`
          : 'Port is open but the scale has sent no data at all.'
      } Check the RS232 cable (TX/RX swapped, or a TTL cable instead of RS232) and the baud rate.`;
    }
  }

  // Load removed
  if (refs['t-loadremoved']) {
    refs['t-loadremoved'].hidden = !(loadRemoved && !offline);
    if (refs['t-loadremoved-detail']) {
      refs['t-loadremoved-detail'].textContent = `The scale is reading below the ${fmtWeight(zeroAt)} it was zeroed at, so something came off the pan. Put it back, or clear the pan and press ZERO HERE. This line cannot be finished until the zero point matches the pan again.`;
    }
  }

  // Auto-advance box + next button
  const countingDown = advanceRemaining > 0;
  if (refs['t-advance']) {
    const show = status.correct && !offline;
    refs['t-advance'].hidden = !show;
    if (show) {
      if (refs['t-advance-title']) {
        refs['t-advance-title'].textContent = countingDown
          ? `TARGET REACHED \u2014 NEXT IN ${secondsLeft(advanceRemaining)}`
          : 'TARGET REACHED';
      }
      if (refs['t-advance-detail']) {
        refs['t-advance-detail'].textContent = countingDown
          ? 'Moving on by itself. Leave this item on the scale and add the next one on top.'
          : 'Moving on by itself in a moment.';
      }
    }
  }
  const nextEnabled = status.correct;
  if (refs['t-next']) refs['t-next'].hidden = !(nextEnabled && !offline);
  if (refs['t-blocked']) {
    const reason = loadRemoved
      ? 'Material came off the scale. Clear the pan and press ZERO HERE, or put the weight back on.'
      : null;
    const show = !nextEnabled && reason && !offline;
    refs['t-blocked'].hidden = !show;
    if (show) refs['t-blocked'].textContent = reason;
  }
  // With the verdict box gone, the side panel only ever carries the
  // LOAD REMOVED warning and the TARGET REACHED countdown. Hide the panel
  // entirely while neither is on the screen so no empty card remains.
  const sidePanel = document.querySelector('.terminal-layout .input-panel');
  if (sidePanel) {
    const showPanel =
      (refs['t-loadremoved'] && !refs['t-loadremoved'].hidden) ||
      (refs['t-advance'] && !refs['t-advance'].hidden);
    sidePanel.style.display = showPanel ? '' : 'none';
  }

  // Voice: only when a scale is actually connected and alerts are switched on.
  // The ALERTS toggle mutes everything here, tones and speech alike.
  const voiceOn = connected && alerts.alertsEnabled();
  const vKey = `${item.uid}:${status.type}:${voiceOn ? 'on' : 'off'}`;
  if (vKey !== voiceKey) {
    voiceKey = vKey;
    if (voiceOn && status.type !== 'underweight') {
      tts.stopNameLoop();
      tts.speakItem(item, voiceLang);
    }
  }
  // Announce the name repeatedly until the target weight is reached: keep it up
  // while the line is under target or has no usable reading yet.
  if (voiceOn && (status.type === 'underweight' || status.type === 'neutral')) {
    tts.startNameLoop(item, tts.orderLangs(voiceLang));
  } else {
    tts.stopNameLoop();
  }

  // Audible verdict cue
  if (alerts.alertsEnabled()) alerts.setAlertLoop(status.type);
  else alerts.stopAlertLoop();

  // Auto-advance countdown
  const token = `${state.activeIndex}:${item.uid}:${item.required}`;
  if (status.correct) {
    if (advanceToken !== token) startAutoAdvance(token);
  } else {
    stopAutoAdvance();
  }
  updateAlertsToggle();
}

function updateAlertsToggle() {
  const btn = document.getElementById('t-alerts');
  if (!btn) return;
  const on = alerts.alertsEnabled();
  btn.className = `alert-toggle ${on ? 'on' : 'off'}`;
  btn.setAttribute('aria-pressed', String(on));
  btn.title = on
    ? 'Weight alerts on \u2014 rings continuously while under or over target'
    : 'Weight alerts muted \u2014 turn the tones back on';
  btn.textContent = on ? '\uD83D\uDD14 ALERTS ON' : '\uD83D\uDD15 ALERTS MUTED';
}

// ---------------------------------------------------------------------------
// Auto-advance
// ---------------------------------------------------------------------------

const ADVANCE_TICK_MS = 200;

function secondsLeft(remainingMs) {
  if (remainingMs <= 0) return 0;
  return Math.ceil(remainingMs / 1000);
}

function startAutoAdvance(token) {
  stopAutoAdvance();
  advanceToken = token;
  advanceRemaining = AUTO_ADVANCE_MS;
  const startedAt = Date.now();
  advanceTimer = setTimeout(() => {
    advanceTimer = null;
    if (advanceTick !== null) {
      clearInterval(advanceTick);
      advanceTick = null;
    }
    advanceRemaining = 0;
    handleNext();
  }, AUTO_ADVANCE_MS);
  advanceTick = setInterval(() => {
    advanceRemaining = Math.max(0, AUTO_ADVANCE_MS - (Date.now() - startedAt));
    const title = document.getElementById('t-advance-title');
    if (title && !document.getElementById('t-advance')?.hidden) {
      title.textContent = `TARGET REACHED \u2014 NEXT IN ${secondsLeft(advanceRemaining)}`;
    }
  }, ADVANCE_TICK_MS);
}

function stopAutoAdvance() {
  if (advanceTimer !== null) {
    clearTimeout(advanceTimer);
    advanceTimer = null;
  }
  if (advanceTick !== null) {
    clearInterval(advanceTick);
    advanceTick = null;
  }
  advanceToken = null;
  advanceRemaining = 0;
}

// ---------------------------------------------------------------------------
// Weighing actions
// ---------------------------------------------------------------------------

// Keyboard-only flow, step 2: the formula is chosen, now the operator sets how
// many batches to run. Arrows change the count on the batches screen; Enter
// there starts the weighing.
function openBatchEntry(formula) {
  state.batchFormula = formula;
  state.batchTotal = 1;
  state.batchIndex = 1;
  state.stage = 'batches';
  renderStage();
}

function startFormula(formula) {
  state.batchFormula = null;
  const lines = formula.lines
    .map((line) => {
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
  if (typeof alerts?.stopAlertLoop === 'function') alerts.stopAlertLoop();
  if (typeof tts?.stopSpeaking === 'function') tts.stopSpeaking();
  if (typeof tts?.stopNameLoop === 'function') tts.stopNameLoop();
  stopAutoAdvance();
  state.cart = lines;
  state.activeIndex = 0;
  state.batchIndex = 1;
  // Whatever the pan carries when the batch starts is not part of the batch.
  tare.zeroAt(scale.getReading());
  advancedUid = null;
  state.resumed = false;
  store.clearStoredCart();
  store.saveCart(lines, formula.id, batchState());
  state.stage = 'weighing';
  renderStage();
}

function cancelWeighing() {
  if (state.cart.length > 0) {
    const completed = state.cart.filter((line) => line.status === 'completed').length;
    const discard = window.confirm(
      completed > 0
        ? `Cancel this weighing? ${completed} completed line${completed === 1 ? '' : 's'} will be discarded and nothing will be recorded.`
        : 'Cancel this weighing and clear the list?',
    );
    if (!discard) return;
  }
  // Flip the stage first so any in-flight scale frame can no longer re-arm the
  // alert loop / TTS through updateTerminal() (it guards on 'weighing').
  state.stage = 'select';
  terminalRefs = null;
  // Stop all audio (tones + TTS) and timers the moment we cancel.
  if (typeof alerts?.stopAlertLoop === 'function') alerts.stopAlertLoop();
  if (typeof tts?.stopSpeaking === 'function') tts.stopSpeaking();
  if (typeof tts?.stopNameLoop === 'function') tts.stopNameLoop();
  if (typeof stopAutoAdvance === 'function') stopAutoAdvance();
  if (shutdownTimer) {
    clearTimeout(shutdownTimer);
    shutdownTimer = null;
    shutdownState = 'idle';
  }
  state.cart = [];
  state.activeIndex = 0;
  state.batchTotal = 1;
  state.batchIndex = 1;
  state.kbIndex = 0;
  state.batchFormula = null;
  tare.reset();
  advancedUid = null;
  state.resumed = false;
  store.clearStoredCart();
  renderStage();
}

function handleNext() {
  const item = activeItem();
  if (!item) return;
  if (advancedUid === item.uid) return;
  const reading = scale.getReading();
  const current = tare.net(reading);
  // The same verdict the operator is looking at: a 51 kg target is accepted
  // from 51.000 up to 51.999, because the reading is rounded down to whole
  // kilograms the way the target is.
  const live = evaluateReading(item.required, current);
  if (current == null || !live.correct) return;
  advancedUid = item.uid;
  const actual = round3(current);
  const completed = state.cart.map((line, index) =>
    index === state.activeIndex ? { ...line, status: 'completed', actual } : line,
  );
  state.cart = completed;
  store.saveCart(completed, null, batchState());
  // Move to the next item. Stop the current announcement loop first so the
  // previous item's name doesn't keep playing over the next one.
  if (typeof tts?.stopNameLoop === 'function') tts.stopNameLoop();
  if (typeof tts?.stopSpeaking === 'function') tts.stopSpeaking();
  // Nothing is taken off the scale between lines, so the total now on the pan
  // becomes the zero the next line is measured against.
  tare.carry(reading);
  if (state.activeIndex < state.cart.length - 1) {
    state.activeIndex += 1;
    renderStage();
  } else {
    completeWeighing();
  }
}

function completeWeighing() {
  // Data logging is gone: the weighing simply ends here. Nothing is saved to
  // the server; the summary screens are built from the cart itself.
  if (typeof alerts?.stopAlertLoop === 'function') alerts.stopAlertLoop();
  if (typeof tts?.stopSpeaking === 'function') tts.stopSpeaking();
  if (typeof tts?.stopNameLoop === 'function') tts.stopNameLoop();
  stopAutoAdvance();
  store.clearStoredCart();
  // More rounds to go? Hold on the batch summary until the operator starts the
  // next one, so the pan can be cleared first.
  state.stage = state.batchIndex < state.batchTotal ? 'between' : 'done';
  renderStage();
}

// Reset the formula to "pending" and weigh it again as the next batch.
function startNextBatch() {
  if (state.batchIndex >= state.batchTotal) return;
  if (typeof alerts?.stopAlertLoop === 'function') alerts.stopAlertLoop();
  if (typeof tts?.stopSpeaking === 'function') tts.stopSpeaking();
  if (typeof tts?.stopNameLoop === 'function') tts.stopNameLoop();
  stopAutoAdvance();
  state.batchIndex += 1;
  state.cart = state.cart.map((line) => ({ ...line, status: 'pending', actual: null }));
  state.activeIndex = 0;
  advancedUid = null;
  state.resumed = false;
  store.saveCart(state.cart, null, batchState());
  // Clear the pan; whatever is left on it becomes the new zero.
  tare.zeroAt(scale.getReading());
  state.stage = 'weighing';
  renderStage();
}

// Abandon the rounds still to go and finish on the batch just completed.
function stopBatches() {
  if (state.batchIndex >= state.batchTotal) return;
  state.batchTotal = state.batchIndex;
  state.stage = 'done';
  renderStage();
}

function startNew() {
  if (typeof alerts?.stopAlertLoop === 'function') alerts.stopAlertLoop();
  if (typeof tts?.stopSpeaking === 'function') tts.stopSpeaking();
  if (typeof tts?.stopNameLoop === 'function') tts.stopNameLoop();
  if (typeof stopAutoAdvance === 'function') stopAutoAdvance();
  state.cart = [];
  state.activeIndex = 0;
  state.batchTotal = 1;
  state.batchIndex = 1;
  state.kbIndex = 0;
  state.batchFormula = null;
  tare.reset();
  advancedUid = null;
  state.resumed = false;
  store.clearStoredCart();
  state.stage = 'select';
  renderStage();
}

// The batch/done summaries are built from the cart itself — data logging is
// gone, so there is no bill record to read facts from.
function doneFacts() {
  const items = state.cart.length;
  const total = state.cart.reduce((sum, line) => sum + (line.actual || 0), 0);
  return `
    <div class="staff-done-facts">
      <div class="staff-done-fact"><span class="staff-done-label">Items Weighed</span><span class="staff-done-value">${items}</span></div>
      <div class="staff-done-fact"><span class="staff-done-label">Total Weight</span><span class="staff-done-value">${fmtWeight(total)}</span></div>
    </div>`;
}

function betweenHtml() {
  return `
    <section class="stage staff-done">
      <div class="panel staff-done-card">
        <div class="staff-done-icon">\u2714</div>
        <div class="screen-title">BATCH ${state.batchIndex} OF ${state.batchTotal} COMPLETE</div>
        ${doneFacts()}
        <div class="staff-done-hint">Clear everything off the scale, then start the next batch.</div>
        <button class="btn btn-primary btn-lg" data-action="start-next-batch">START BATCH ${state.batchIndex + 1}</button>
        <button class="btn btn-secondary" data-action="stop-batches">STOP</button>
      </div>
    </section>`;
}

function doneHtml() {
  return `
    <section class="stage staff-done">
      <div class="panel staff-done-card">
        <div class="staff-done-icon">\u2714</div>
        <div class="screen-title">WEIGHING COMPLETE</div>
        ${doneFacts()}
        <button class="btn btn-primary btn-lg" data-action="weigh-another">WEIGH ANOTHER</button>
      </div>
    </section>`;
}

// ---------------------------------------------------------------------------
// Scale callbacks, header chip and popover
// ---------------------------------------------------------------------------

function scaleLinkState() {
  if (scale.getDeviceError()) return 'error';
  if (scale.getDevice().connected) return 'online';
  return 'offline';
}

function scaleLinkLabel() {
  const err = scale.getDeviceError();
  const device = scale.getDevice();
  if (err) return `SCALE ERROR: ${err}`;
  if (device.connected) return `SCALE ONLINE (${device.port ?? 'connected'})`;
  return 'SCALE OFFLINE';
}

function onScaleChange() {
  const dot = document.querySelector('.scale-settings-dot');
  if (dot) dot.className = `scale-settings-dot ${scaleLinkState()}`;
  const btn = document.querySelector('.scale-settings-btn');
  if (btn) btn.title = scaleLinkLabel();
  if (state.stage === 'weighing' && terminalRefs) updateTerminal();
  refreshScalePanel();
}

function scalePanelOpen() {
  const panel = document.getElementById('scale-panel');
  return panel && !panel.classList.contains('hidden');
}

function openScalePanel() {
  const panel = document.getElementById('scale-panel');
  const btn = document.querySelector('.scale-settings-btn');
  const info = scale.getScaleInfo();
  const device = scale.getDevice();
  const shownPort = device.port || info.port || '/dev/ttyS1';
  const connected = Boolean(device.connected);
  const rates = info.baudRates.length ? info.baudRates : [9600];
  panel.innerHTML = `
    <div class="scale-conn">
      <div class="scale-conn-body">
        <span class="scale-port-fixed" title="The scale is read from this port">${escapeHtml(shownPort)}</span>
        <select class="scale-baud-select" data-action="baud" aria-label="Baud rate">
          ${rates.map((rate) => `<option value="${rate}">${rate}</option>`).join('')}
        </select>
        <button class="btn ${connected ? 'btn-danger' : 'btn-primary'} btn-sm" data-action="scale-connect" id="sc-connect" ${info.deviceBusy ? 'disabled' : ''}>${connected ? 'DISCONNECT' : 'CONNECT'}</button>
        <span class="scale-conn-status" id="sc-status"></span>
      </div>
      <span class="mode-badge" id="sc-mode"></span>
    </div>`;
  const select = panel.querySelector('.scale-baud-select');
  if (select) select.value = String(device.baudRate || rates[0]);
  panel.classList.remove('hidden');
  if (btn) btn.setAttribute('aria-expanded', 'true');
  refreshScalePanel();
}

function closeScalePanel() {
  const panel = document.getElementById('scale-panel');
  const btn = document.querySelector('.scale-settings-btn');
  if (panel) panel.classList.add('hidden');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

function refreshScalePanel() {
  if (!scalePanelOpen()) return;
  const status = document.getElementById('sc-status');
  const mode = document.getElementById('sc-mode');
  const connectBtn = document.getElementById('sc-connect');
  const device = scale.getDevice();
  const info = scale.getScaleInfo();
  const connected = Boolean(device.connected);
  if (status) {
    if (scale.getDeviceError()) {
      status.innerHTML = `<b class="err">${escapeHtml(scale.getDeviceError())}</b>`;
    } else if (connected) {
      const rate = device.baudRate ? ` @ ${device.baudRate} baud` : '';
      status.textContent = `Connected to ${device.port}${rate}`;
    } else {
      status.textContent = device.message || 'Not connected';
    }
  }
  if (mode) {
    mode.innerHTML = `${connected ? 'SCALE ONLINE' : 'SCALE OFFLINE'}<span class="mode-dot${connected ? ' on' : ' err'}"></span>`;
  }
  if (connectBtn) {
    connectBtn.disabled = Boolean(info.deviceBusy);
    connectBtn.textContent = connected ? 'DISCONNECT' : info.deviceBusy ? 'CONNECTING\u2026' : 'CONNECT';
    connectBtn.className = `btn ${connected ? 'btn-danger' : 'btn-primary'} btn-sm`;
  }
}

// ---------------------------------------------------------------------------
// Panel switch: Ctrl+Alt+A hands over to the admin portal
// ---------------------------------------------------------------------------

function onStaffTerminal() {
  const path = window.location.pathname;
  return path === '/staff' || path.startsWith('/staff/');
}

function otherTerminalUrl() {
  const stamp = Date.now().toString(36);
  return `${onStaffTerminal() ? '/' : '/staff/'}?panel=${stamp}`;
}

function installPanelSwitch() {
  // Ctrl+Alt+A hands a staff station over to the admin kiosk (app.js, the
  // side that owns REPORTS / ITEM MASTER). This module only runs on /staff/,
  // so the switch is deliberately one-way: the admin page has no combo back.
  window.addEventListener('keydown', (event) => {
    if (!event.ctrlKey || !event.altKey) return;
    if (event.key.toLowerCase() !== 'a' && event.code !== 'KeyA') return;
    event.preventDefault();
    window.location.replace(otherTerminalUrl());
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) window.location.reload();
  });
}

// ---------------------------------------------------------------------------
// Keyboard-only operation (arrow keys + Enter)
// ---------------------------------------------------------------------------

// The operator's keypad has only the two arrow keys and Enter. Every screen
// therefore answers those three keys and nothing else:
//   select  — arrows move the formula highlight, Enter opens the batch count
//   batches — arrows change the count, Enter starts the weighing
//   weighing— the scale drives everything; keys are ignored on purpose
//   between — Enter starts the next batch
//   done    — Enter returns to the formula list
function installKeyboardNav() {
  window.addEventListener('keydown', (event) => {
    // Let the admin-switch combo (Ctrl+Alt+A) and browser shortcuts through.
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    // Fields in the maintenance panels (scale settings) keep their own keys.
    // The batch number input is the exception: the arrows still adjust the
    // count and Enter still starts while the operator is typing in it.
    const target = event.target instanceof Element ? event.target : null;
    const tag = target ? target.tagName : '';
    const isBatchInput = Boolean(target && target.id === 't-batch-input');
    if ((tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') && !isBatchInput) return;

    if (state.stage === 'select') {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (state.formulas.length === 0) return;
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        state.kbIndex = (state.kbIndex + delta + state.formulas.length) % state.formulas.length;
        renderStage();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        if (state.loadError) {
          void loadData();
          return;
        }
        const formula = state.formulas[state.kbIndex];
        if (formula) openBatchEntry(formula);
      }
    } else if (state.stage === 'batches') {
      const showBatchTotal = () => {
        const batchInput = document.getElementById('t-batch-input');
        if (batchInput) batchInput.value = String(state.batchTotal);
        syncBatchesView();
        focusBatchInput();
      };
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        clampBatchInput(); // settle anything typed so far (empty -> 1)
        state.batchTotal = Math.min(MAX_BATCHES, state.batchTotal + 1);
        showBatchTotal();
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        clampBatchInput();
        state.batchTotal = Math.max(1, state.batchTotal - 1);
        showBatchTotal();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        clampBatchInput();
        if (state.batchFormula) startFormula(state.batchFormula);
      }
    } else if (state.stage === 'between') {
      if (event.key === 'Enter') {
        event.preventDefault();
        startNextBatch();
      }
    } else if (state.stage === 'done') {
      if (event.key === 'Enter') {
        event.preventDefault();
        startNew();
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Shutdown (tap once to arm, tap again to confirm)
// ---------------------------------------------------------------------------

function renderShutdownButton() {
  const btn = document.querySelector('.shutdown-btn');
  if (!btn) return;
  const label =
    shutdownState === 'armed'
      ? '\u26A0 CONFIRM SHUTDOWN?'
      : shutdownState === 'sent'
        ? '\u23FB SHUTTING DOWN\u2026'
        : shutdownState === 'error'
          ? '\u2715 SHUTDOWN FAILED'
          : '\u23FB SHUTDOWN';
  btn.textContent = label;
  btn.classList.toggle('armed', shutdownState === 'armed');
  btn.disabled = shutdownState === 'sent';
}

function shutdownLater(ms) {
  if (shutdownTimer) clearTimeout(shutdownTimer);
  shutdownTimer = setTimeout(() => {
    shutdownState = 'idle';
    renderShutdownButton();
  }, ms);
}

async function onShutdown() {
  if (shutdownState === 'armed') {
    shutdownState = 'sent';
    renderShutdownButton();
    try {
      await api.shutdown();
      document.body.innerHTML = '<div class="shutdown-screen">Shutting down\u2026</div>';
    } catch {
      shutdownState = 'error';
      renderShutdownButton();
      shutdownLater(5000);
    }
    return;
  }
  shutdownState = 'armed';
  renderShutdownButton();
  shutdownLater(6000);
}

// ---------------------------------------------------------------------------
// Font scale
// ---------------------------------------------------------------------------

function moveFontScale(delta) {
  const idx = Math.max(0, FONT_SCALE_STEPS.findIndex((s) => s.id === currentFontStepId()));
  const next = Math.min(FONT_SCALE_STEPS.length - 1, Math.max(0, idx + delta));
  if (next === idx) return;
  store.setRaw(store.FONT_SCALE_KEY, FONT_SCALE_STEPS[next].id);
  applyFontScale();
  renderHeaderControls();
  // The rem baseline moved, so the per-box text fit must be redone.
  scheduleStageFit();
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function onClick(event) {
  const target = event.target.closest('[data-action]');
  if (!target) {
    if (scalePanelOpen() && !event.target.closest('#scale-settings')) closeScalePanel();
    return;
  }
  const action = target.dataset.action;

  // A tap anywhere is enough to unlock the browser audio context.
  if (action === 'toggle-alerts') alerts.primeAlertAudio();

  switch (action) {
    case 'font-down':
      moveFontScale(-1);
      break;
    case 'font-up':
      moveFontScale(1);
      break;
    case 'toggle-scale':
      if (scalePanelOpen()) closeScalePanel();
      else openScalePanel();
      break;
    case 'scale-connect': {
      const select = document.querySelector('.scale-baud-select');
      const baudRate = select ? Number(select.value) : undefined;
      const info = scale.getScaleInfo();
      const device = scale.getDevice();
      if (device.connected) void scale.disconnect();
      else void scale.connect({ port: device.port || info.port, baudRate });
      break;
    }
    case 'shutdown':
      void onShutdown();
      break;
    case 'reload-data':
      void loadData();
      break;
    case 'batch-down':
    case 'batch-up': {
      clampBatchInput(); // settle anything typed so far (empty -> 1)
      const delta = action === 'batch-up' ? 1 : -1;
      state.batchTotal = Math.min(MAX_BATCHES, Math.max(1, state.batchTotal + delta));
      syncBatchesView();
      focusBatchInput();
      break;
    }
    case 'select-formula': {
      const formula = state.formulas.find((f) => f.id === Number(target.dataset.id));
      // Mouse/touch path lands on the same batch-count step as the keyboard.
      if (formula) openBatchEntry(formula);
      break;
    }
    case 'confirm-batches':
      if (state.batchFormula) {
        clampBatchInput();
        startFormula(state.batchFormula);
      }
      break;
    case 'replay-name': {
      const item = activeItem();
      if (item) {
        alerts.primeAlertAudio();
        tts.speakItem(item, voiceLang);
      }
      break;
    }
    case 'terminal-zero':
      tare.zeroAt(scale.getReading());
      updateTerminal();
      break;
    case 'terminal-next':
      handleNext();
      break;
    case 'terminal-cancel':
      cancelWeighing();
      break;
    case 'toggle-alerts':
      alerts.toggleAlertsEnabled();
      updateAlertsToggle();
      updateTerminal();
      break;
    case 'weigh-another':
      startNew();
      break;
    case 'start-next-batch':
      startNextBatch();
      break;
    case 'stop-batches':
      stopBatches();
      break;
    case 'discard':
      cancelWeighing();
      break;
    default:
      break;
  }
}

function onChange(event) {
  const target = event.target.closest('[data-action]');
  if (target && target.dataset.action === 'baud') {
    // Only the CONNECT click reads the value; nothing to persist.
  }
}

boot();

export { renderStage };
