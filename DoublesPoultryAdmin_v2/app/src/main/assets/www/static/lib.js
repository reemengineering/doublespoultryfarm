// Shared browser modules for the REEM weighing terminal.
//
// One module for both front ends (the admin kiosk in app.js and the staff
// station in staff.js): constants, helpers, weight maths, tare, storage,
// alerts, speech, photos, the API client and the live scale source. The page
// scripts import only this file.


// ---------------------------------------------------------------------------
// Shared constants  (was config.js)
// ---------------------------------------------------------------------------

// Shared frontend constants.

const BRAND = 'DOUBLES POULTRY FARM';

const LOGO_SRC = '/static/img/reman-logo.jpeg';

const LANG_CODES = ['en', 'hi'];

// The languages spoken item names cycle through. English and Hindi only.
const nameLoopLangs = [
  { code: 'en', label: 'English' },
  { code: 'hi', label: 'Hindi / हिन्दी' },
];

const FONT_SCALE_STEPS = [
  { id: 'md', scale: 1.2, label: 'Normal' },
  { id: 'lg', scale: 1.5, label: 'Large' },
  { id: 'xl', scale: 1.75, label: 'Extra large' },
  { id: 'xxl', scale: 2, label: 'Huge' },
];

const DEFAULT_PORT = 3001;
const AUTO_ADVANCE_MS = 4000;
const MAX_TARGET_KG = 1000;

// ---------------------------------------------------------------------------
// Small shared helpers  (was util.js)
// ---------------------------------------------------------------------------

// Small shared helpers. No framework: the terminal only needs a few primitives.

/** Generate a client reference for a bill. Must satisfy ^[A-Za-z0-9_-]{8,64}$. */
function uid() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(36).padStart(2, '0'))
    .join('')
    .slice(0, 20);
}

/** Escape text before it goes into an innerHTML template. */
function escapeHtml(value) {
  if (value == null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Build an element from a tag, attributes and children. */
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'dataset') {
      Object.assign(node.dataset, value);
    } else {
      node.setAttribute(key, value === true ? '' : String(value));
    }
  }
  for (const child of [].concat(children)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function qs(sel, root = document) {
  return root.querySelector(sel);
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  return String(iso).replace('T', ' ');
}

function fmtDateTimeLocal(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

function todayParts(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return {
    year: d.getFullYear(),
    month: d.getMonth() + 1,
    day: p(d.getDate()),
    date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
  };
}

function monthName(index) {
  return [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ][index] || '';
}

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// ---------------------------------------------------------------------------
// Weight maths (mirrors reem/domain.py)  (was weights.js)
// ---------------------------------------------------------------------------

// Weight maths. Mirrors reem/weights.py so the client and server agree exactly.

const MIN_TARGET_KG = 1;

/** Replicate JavaScript's Math.round, matching the server's js_round(). */
function jsRound(value) {
  return Math.floor(value + 0.5);
}

function round3(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return jsRound(n * 1000) / 1000;
}

/** Round a weight DOWN to the whole kilogram below it. */
function roundOffWeight(kg) {
  const n = Number(kg);
  if (!Number.isFinite(n)) return 0;
  const scaled = jsRound(n * 1000);
  if (!Number.isFinite(scaled)) return 0;
  const whole = scaled / 1000;
  return (whole < 0 ? Math.ceil(whole) : Math.floor(whole)) + 0;
}

function roundTargetWeight(kg) {
  const n = Number(kg);
  if (!Number.isFinite(n)) return MIN_TARGET_KG;
  return Math.max(MIN_TARGET_KG, roundOffWeight(n));
}

function formatTarget(kg) {
  return Number.isInteger(kg) ? String(kg) : kg.toFixed(1);
}

function targetRoundingNote(kg) {
  const n = Number(kg);
  if (!Number.isFinite(n) || n <= 0) return null;
  const rounded = roundTargetWeight(n);
  if (rounded === n) return null;
  return `${formatTarget(n)} will be weighed as ${formatTarget(rounded)} kg`;
}

function fmtWeight(weight) {
  return `${Number(weight).toFixed(3)} kg`;
}

function fmtWeightNoUnit(weight) {
  return Number(weight).toFixed(3);
}

function fmtSignedValue(diff) {
  return `${diff > 0 ? '+' : ''}${Number(diff).toFixed(3)}`;
}

function fmtSignedDiff(diff) {
  return `${fmtSignedValue(diff)} kg`;
}

/** Parses a weight typed by hand; rejects blanks, junk and negatives. */
function parseWeight(raw) {
  if (raw == null) return null;
  const text = String(raw).trim();
  if (text === '') return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}

/** Compare a reading against the required weight and describe the gap. */
function evaluateReading(required, current) {
  if (current == null) {
    return {
      type: 'neutral',
      title: 'AWAITING INPUT',
      detail: 'Enter the current weight',
      difference: null,
      correct: false,
    };
  }
  const difference = round3(roundOffWeight(current) - required);
  if (difference === 0) {
    return { type: 'accepted', title: 'WEIGHT ACCEPTED', detail: 'ON TARGET', difference, correct: true };
  }
  if (difference < 0) {
    return {
      type: 'underweight',
      title: 'UNDERWEIGHT',
      detail: `Add ${fmtWeight(round3(-difference))}`,
      difference,
      correct: false,
    };
  }
  return {
    type: 'overweight',
    title: 'OVERWEIGHT',
    detail: `Remove ${fmtWeight(difference)}`,
    difference,
    correct: false,
  };
}

// ---------------------------------------------------------------------------
// Tare zero point (mirrors reem/domain.py)  (was tare.js)
// ---------------------------------------------------------------------------

// Turns the scale's running total into the weight of the item being weighed.
// Mirrors reem/tare_baseline.py.

class TareBaseline {
  constructor(dropTolerance = 0.5) {
    this.base = 0;
    this.established = false;
    this.dropTolerance = dropTolerance;
  }

  zeroAt(current) {
    if (current == null) {
      this.established = false;
      return;
    }
    this.base = round3(current);
    this.established = true;
  }

  adoptEmptyPan(current) {
    if (this.established || current == null || current > 0) return false;
    this.zeroAt(current);
    return true;
  }

  isEstablished() {
    return this.established;
  }

  net(current) {
    if (current == null) return null;
    return Math.max(0, round3(round3(current) - this.base));
  }

  underBase(current) {
    if (current == null || !this.established) return false;
    return round3(current) - this.base < -this.dropTolerance;
  }

  carry(accumulated) {
    if (accumulated == null) return;
    this.base = round3(accumulated);
    this.established = true;
  }

  reset() {
    this.base = 0;
    this.established = false;
  }

  baseValue() {
    return this.base;
  }
}

// ---------------------------------------------------------------------------
// localStorage persistence (cart, pending bill, preferences)  (was storage.js)
// ---------------------------------------------------------------------------

// localStorage persistence for the cart, a failed bill, and small preferences.
// Mirrors shared/cartStorage.ts, with the namespace renamed to reem.*.


const PREFIX = 'reem';
const CART_KEY = `${PREFIX}.cart`;
const ALERTS_KEY = `${PREFIX}.alertsEnabled`;
const FONT_SCALE_KEY = `${PREFIX}.fontScale`;
const SERVER_URL_KEY = `${PREFIX}.serverUrl`;

const MAX_CART_AGE_MS = 12 * 60 * 60 * 1000;

function storage() {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function saveCart(cart, formulaId, batch) {
  const store = storage();
  if (!store) return;
  try {
    const first = cart.find((line) => line.formulaId != null);
    const payload = {
      formulaId: first?.formulaId ?? formulaId ?? null,
      formulaName: first?.formulaName ?? null,
      // How many times this queue is meant to be weighed, and which round the
      // operator is on. Persisted so a reload keeps the batch position.
      batchTotal: batch && batch.total ? batch.total : 1,
      batchIndex: batch && batch.index ? batch.index : 1,
      savedAt: Date.now(),
      lines: cart.map((line) => ({
        uid: line.uid,
        id: line.id,
        slug: line.slug,
        name: line.name,
        imagePath: line.imagePath ?? null,
        required: roundTargetWeight(line.required),
        status: line.status,
        actual: line.actual ?? null,
        formulaName: line.formulaName ?? null,
        formulaId: line.formulaId ?? null,
      })),
    };
    store.setItem(CART_KEY, JSON.stringify(payload));
  } catch {
    // Weighing still works; it just will not survive a reload.
  }
}

function loadCart() {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(CART_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.lines) || parsed.lines.length === 0) return null;
    if (!Number.isFinite(parsed.savedAt)) return null;
    if (Date.now() - parsed.savedAt > MAX_CART_AGE_MS) {
      clearStoredCart();
      return null;
    }
    const bad = parsed.lines.some(
      (line) =>
        !line ||
        typeof line.uid !== 'string' ||
        !line.name ||
        !Number.isFinite(line.required) ||
        (line.status !== 'pending' && line.status !== 'active' && line.status !== 'completed'),
    );
    if (bad) return null;
    return parsed;
  } catch {
    return null;
  }
}

function clearStoredCart() {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(CART_KEY);
  } catch {
    // nothing to clear
  }
}

// -- small preferences -------------------------------------------------------

function getRaw(key) {
  const store = storage();
  try {
    return store ? store.getItem(key) : null;
  } catch {
    return null;
  }
}

function setRaw(key, value) {
  const store = storage();
  try {
    store?.setItem(key, value);
  } catch {
    // storage disabled
  }
}

// ---------------------------------------------------------------------------
// Audible weight-band alerts  (was alerts.js)
// ---------------------------------------------------------------------------

// Audible weight-band alerts. Mirrors shared/alerts.ts.
//
// Tones are synthesised with the Web Audio API rather than shipped as files, so
// they start with zero latency and do not cancel the item name that tts.js is
// playing. Under and over keep ringing for as long as the weight sits in that
// band; reaching the target silences the loop and confirms with a chime.


const SOUNDS = {
  underweight: [
    { freq: 784, at: 0, duration: 0.1, peak: 0.2 },
    { freq: 988, at: 0.12, duration: 0.14, peak: 0.2 },
  ],
  overweight: [
    { freq: 220, at: 0, duration: 0.16, peak: 0.34 },
    { freq: 176, at: 0.18, duration: 0.24, peak: 0.4 },
  ],
  accepted: [
    { freq: 659, at: 0, duration: 0.11, peak: 0.18 },
    { freq: 880, at: 0.1, duration: 0.11, peak: 0.18 },
    { freq: 1175, at: 0.2, duration: 0.26, peak: 0.18 },
  ],
};

const LOOP_MS = 1000;
const BAND_SWITCH_MIN_MS = 600;

let ctx = null;
let master = null;
let gestureBound = false;
let loopTimer = null;
let loopKind = 'neutral';
let lastSoundedAt = 0;
let desiredKind = 'neutral';
let currentKind = 'neutral';
let pausedForHidden = false;

function alertsEnabled() {
  return getRaw(ALERTS_KEY) !== 'off';
}

function setAlertsEnabled(on) {
  if (on) {
    setRaw(ALERTS_KEY, 'on');
    if (desiredKind !== 'neutral' && desiredKind !== 'accepted') {
      currentKind = 'neutral';
      setAlertLoop(desiredKind);
    }
    return true;
  }
  stopAlertLoop();
  setRaw(ALERTS_KEY, 'off');
  return false;
}

function toggleAlertsEnabled() {
  return setAlertsEnabled(!alertsEnabled());
}

function clearLoopTimer() {
  if (loopTimer === null) return;
  window.clearTimeout(loopTimer);
  loopTimer = null;
}

function stopAlertLoop() {
  clearLoopTimer();
  loopKind = 'neutral';
}

function armLoop(kind) {
  clearLoopTimer();
  loopTimer = window.setTimeout(() => {
    loopTimer = null;
    if (loopKind !== kind) return;
    playAlert(kind);
    armLoop(kind);
  }, LOOP_MS);
}

function setAlertLoop(kind) {
  desiredKind = kind;
  const changed = kind !== currentKind;
  currentKind = kind;

  if (!alertsEnabled() || kind === 'neutral') {
    stopAlertLoop();
    return;
  }
  if (kind === 'accepted') {
    stopAlertLoop();
    if (changed) {
      lastSoundedAt = Date.now();
      playAlert('accepted');
    }
    return;
  }
  if (loopKind === kind) return;
  const switchingBand = loopKind !== 'neutral';
  const now = Date.now();
  stopAlertLoop();
  loopKind = kind;
  if (switchingBand && now - lastSoundedAt < BAND_SWITCH_MIN_MS) {
    armLoop(kind);
    return;
  }
  lastSoundedAt = now;
  playAlert(kind);
  armLoop(kind);
}

function ensureContext() {
  bindPageHooks();
  if (ctx) return ctx;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
    master = ctx.createGain();
    master.gain.value = 1;
    master.connect(ctx.destination);
  } catch {
    ctx = null;
    master = null;
  }
  return ctx;
}

/** Call from a click/keydown handler to unlock alerts up front. */
function primeAlertAudio() {
  const context = ensureContext();
  if (!context) return;
  if (context.state === 'running') return;
  void context.resume().catch(() => {});
  if (gestureBound) return;
  gestureBound = true;
  for (const type of ['pointerdown', 'keydown', 'touchstart']) {
    window.addEventListener(type, () => primeAlertAudio(), { passive: true });
  }
}

function onVisibilityChange() {
  if (document.hidden) {
    pausedForHidden = loopKind !== 'neutral';
    stopAlertLoop();
    return;
  }
  if (!pausedForHidden) return;
  pausedForHidden = false;
  if (desiredKind !== 'neutral') setAlertLoop(desiredKind);
}

let pageHooksBound = false;
function bindPageHooks() {
  if (pageHooksBound) return;
  pageHooksBound = true;
  document.addEventListener('visibilitychange', onVisibilityChange);
}

function scheduleTone(kind, context, out, tone) {
  const start = context.currentTime + tone.at;
  const osc = context.createOscillator();
  const gain = context.createGain();
  osc.type = kind === 'overweight' ? 'square' : 'triangle';
  osc.frequency.setValueAtTime(tone.freq, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(tone.peak, start + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + tone.duration);
  osc.connect(gain).connect(out);
  osc.start(start);
  osc.stop(start + tone.duration + 0.03);
}

function playAlert(kind) {
  if (kind === 'neutral') return;
  if (!alertsEnabled()) return;
  const context = ensureContext();
  if (!context || !master) return;
  if (context.state !== 'running') {
    primeAlertAudio();
    return;
  }
  for (const tone of SOUNDS[kind]) scheduleTone(kind, context, master, tone);
}

// ---------------------------------------------------------------------------
// Spoken item names  (was tts.js)
// ---------------------------------------------------------------------------

const VOICE_LANGS = nameLoopLangs;

// Spoken item names. Mirrors src/lib/tts.ts and shared/multilingualName.ts.
//
// Each name is available as a downloaded MP3 under /tts/<lang>/<slug>.mp3. When
// that clip is missing the browser's own voice is used, and either way the
// attempt is bounded so a clip that never reports its end cannot freeze the
// multilingual repeat loop halfway through.


const TTS_LANG_TAGS = { en: 'en-US', hi: 'hi-IN', bn: 'bn-IN', ta: 'ta-IN' };
const CLIP_TIMEOUT_MS = 8000;
const LANG_GAP_MS = 320;

let ttsClipBase = '/tts';

function setTtsBase(base) {
  ttsClipBase = base || '/tts';
}

const audioCache = new Map();
let currentAudio = null;
let speakTimer = null;
let pendingDone = null;

function clearSpeakTimer() {
  if (speakTimer !== null) {
    clearTimeout(speakTimer);
    speakTimer = null;
  }
}

/** Finish the current utterance exactly once. */
function finish() {
  const done = pendingDone;
  pendingDone = null;
  clearSpeakTimer();
  currentAudio = null;
  if (done) {
    try {
      done();
    } catch {
      // a throwing callback must not wedge the loop
    }
  }
}

function stopSpeaking() {
  clearSpeakTimer();
  try {
    if (currentAudio) {
      currentAudio.pause();
      currentAudio.currentTime = 0;
    }
  } catch {
    // nothing to stop
  }
  currentAudio = null;
  try {
    window.speechSynthesis?.cancel();
  } catch {
    // nothing to cancel
  }
  pendingDone = null;
}

function localizedName(item, lang) {
  return (item?.names && item.names[lang]) || item?.name || '';
}

function clipUrl(slug, lang) {
  const safe = String(slug || '').replace(/[^a-z0-9-]/gi, '');
  return `${ttsClipBase}/${lang}/${safe}.mp3`;
}

function speakWithBrowser(text, lang) {
  const synth = window.speechSynthesis;
  if (!synth || !text) {
    finish();
    return;
  }
  try {
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = TTS_LANG_TAGS[lang] || 'en-US';
    utter.onend = () => finish();
    utter.onerror = () => finish();
    synth.speak(utter);
  } catch {
    finish();
  }
}

/**
 * Speak one item's name in one language. `onDone` is always called exactly
 * once, whether the clip plays, fall back to speech, or times out.
 */
function speakItem(item, lang, onDone) {
  stopSpeaking();
  pendingDone = onDone;
  const slug = item?.slug;
  const text = localizedName(item, lang);

  if (spokenLangListener) {
    try {
      spokenLangListener(lang, item);
    } catch {
      // A display listener must never break the announcement.
    }
  }

  speakTimer = window.setTimeout(() => finish(), CLIP_TIMEOUT_MS);

  if (!slug) {
    speakWithBrowser(text, lang);
    return;
  }

  let audio = audioCache.get(`${lang}/${slug}`);
  if (!audio) {
    audio = new Audio(clipUrl(slug, lang));
    audio.preload = 'auto';
    audioCache.set(`${lang}/${slug}`, audio);
  }
  currentAudio = audio;
  audio.onended = () => finish();
  audio.onerror = () => {
    // A missing clip is normal; fall back to the browser voice.
    if (pendingDone === onDone) speakWithBrowser(text, lang);
  };
  try {
    audio.currentTime = 0;
    const played = audio.play();
    if (played && typeof played.catch === 'function') {
      played.catch(() => {
        if (pendingDone === onDone) speakWithBrowser(text, lang);
      });
    }
  } catch {
    speakWithBrowser(text, lang);
  }
}

/** Warm the clip cache for the whole item master. */
function preloadAll(items, langs = VOICE_LANGS) {
  for (const item of items) {
    for (const { code } of langs) {
      if (!item.slug) continue;
      const key = `${code}/${item.slug}`;
      if (audioCache.has(key)) continue;
      try {
        const audio = new Audio(clipUrl(item.slug, code));
        audio.preload = 'auto';
        audioCache.set(key, audio);
      } catch {
        // preloading is best-effort
      }
    }
  }
}

// -- the underweight name loop ----------------------------------------------

function orderLangs(selected, all = VOICE_LANGS) {
  const codes = all.map((entry) => (typeof entry === 'string' ? entry : entry.code));
  const rest = codes.filter((code) => code !== selected);
  return [selected, ...rest];
}

let activeItem = null;
let activeLangs = [];
let index = 0;
let gapTimer = null;
let generation = 0;
let loopActive = false;

// Optional observer the terminals use to mirror whichever language is being
// announced on screen (e.g. show the translation opposite the English name).
let spokenLangListener = null;

function setSpokenLangListener(fn) {
  spokenLangListener = typeof fn === 'function' ? fn : null;
}

function clearGapTimer() {
  if (gapTimer === null) return;
  clearTimeout(gapTimer);
  gapTimer = null;
}

function speakCurrent() {
  const lang = activeLangs[index];
  if (lang == null || activeItem == null) return;
  const mine = generation;
  speakItem(activeItem, lang, () => {
    if (mine !== generation) return;
    index = (index + 1) % activeLangs.length;
    clearGapTimer();
    gapTimer = setTimeout(() => {
      gapTimer = null;
      speakCurrent();
    }, LANG_GAP_MS);
  });
}

function startNameLoop(item, langs) {
  const sameItem = item === activeItem && loopActive;
  const sameOrder =
    sameItem && langs.length === activeLangs.length && langs.every((l, i) => l === activeLangs[i]);
  if (sameOrder) return;

  stopNameLoop();
  if (item == null || langs.length === 0) return;

  activeItem = item;
  activeLangs = [...langs];
  index = 0;
  generation += 1;
  loopActive = true;
  speakCurrent();
}

function stopNameLoop() {
  generation += 1;
  clearGapTimer();
  activeItem = null;
  activeLangs = [];
  index = 0;
  loopActive = false;
  stopSpeaking();
}

// Stop the voice when the page is hidden or unloaded: Web Speech keeps speaking
// after the terminal unmounts unless every pending utterance is cancelled.
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => stopSpeaking());
}

// ---------------------------------------------------------------------------
// Client-side item photo handling  (was images.js)
// ---------------------------------------------------------------------------

// Client-side picture handling for item photos. Mirrors src/lib/itemImage.ts.
//
// The phone produces files of several megabytes and the screen only ever shows a
// thumbnail, so the image is resized in the browser before upload.

const MAX_EDGE = 640;
const QUALITY = 0.82;
const MAX_INPUT_BYTES = 20 * 1024 * 1024;

class ImageTooLargeError extends Error {}

const ACCEPTED_TYPES = [
  'image/*',
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.heic',
  '.heif',
];

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('That file could not be read as an image'));
    };
    image.src = url;
  });
}

/** Resize and re-encode a picked file into a data: URL ready for upload. */
async function fileToDataUrl(file) {
  if (file.size > MAX_INPUT_BYTES) throw new ImageTooLargeError('Image is larger than 20 MB');
  const image = await loadImage(file);

  const longest = Math.max(image.width, image.height) || MAX_EDGE;
  const ratio = longest > MAX_EDGE ? MAX_EDGE / longest : 1;
  const width = Math.max(1, Math.round(image.width * ratio));
  const height = Math.max(1, Math.round(image.height * ratio));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  // A transparent PNG flattened onto white so the JPEG has no black edges.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(image, 0, 0, width, height);
  return canvas.toDataURL('image/jpeg', QUALITY);
}

// ---------------------------------------------------------------------------
// HTTP client for the weighing API  (was api.js)
// ---------------------------------------------------------------------------

// HTTP client for the weighing API. Mirrors src/api.ts.
//
// On a desktop browser the whole app is served by the same server, so a
// same-origin relative URL is correct and needs no configuration. An optional
// stored server address overrides it for a client on another machine.


class ApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
    this.name = 'ApiError';
  }

  describe() {
    return this.status ? `${this.message} (HTTP ${this.status})` : this.message;
  }
}

/** The stored server origin, or '' for same-origin. */
function getServerOrigin() {
  return getRaw(SERVER_URL_KEY) || '';
}

function needsServerAddress() {
  return false; // Desktop build is always served by the weighing server.
}

function setServerAddress(origin) {
  const trimmed = String(origin || '').trim().replace(/\/+$/, '');
  if (trimmed) setRaw(SERVER_URL_KEY, trimmed);
  else setRaw(SERVER_URL_KEY, '');
  return trimmed;
}

/** Normalise a typed address into an origin, e.g. 192.168.1.5 -> http://192.168.1.5:3001 */
function normalizeAddress(input) {
  let value = String(input || '').trim();
  if (!value) return '';
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`;
  try {
    const url = new URL(value);
    if (!url.port) url.port = String(DEFAULT_PORT);
    return `${url.protocol}//${url.host}`;
  } catch {
    return '';
  }
}

function apiBase() {
  const origin = getServerOrigin();
  return origin ? `${origin}/api` : '/api';
}

function ttsBase() {
  const origin = getServerOrigin();
  return origin ? `${origin}/tts` : '/tts';
}

function itemImagesBase() {
  const origin = getServerOrigin();
  return origin ? `${origin}/item-images` : '/item-images';
}

const DEFAULT_TIMEOUT_MS = 15000;

async function request(path, { method = 'GET', body, timeout = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let response;
  try {
    response = await fetch(`${apiBase()}${path}`, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err?.name === 'AbortError') {
      throw new ApiError('The server took too long to answer. Check the connection and try again.');
    }
    throw new ApiError('Could not reach the weighing server.');
  }
  clearTimeout(timer);

  let data = null;
  const text = await response.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!response.ok) {
    const message = data?.error || `Request failed (${response.status})`;
    throw new ApiError(message, response.status);
  }
  return data;
}

const api = {
  health: () => request('/health'),

  getItems: () => request('/items'),
  createItem: (payload) => request('/items', { method: 'POST', body: payload }),
  updateItem: (id, payload) => request(`/items/${id}`, { method: 'PUT', body: payload }),
  regenerateItem: (id) => request(`/items/${id}/regenerate`, { method: 'POST' }),
  setItemImage: (id, dataUrl) => request(`/items/${id}/image`, { method: 'POST', body: { dataUrl }, timeout: 30000 }),
  deleteItemImage: (id) => request(`/items/${id}/image`, { method: 'DELETE' }),
  deleteItem: (id) => request(`/items/${id}`, { method: 'DELETE' }),

  getFormulas: () => request('/formulas'),
  createFormula: (payload) => request('/formulas', { method: 'POST', body: payload }),
  updateFormula: (id, payload) => request(`/formulas/${id}`, { method: 'PUT', body: payload }),
  deleteFormula: (id) => request(`/formulas/${id}`, { method: 'DELETE' }),

  getScalePorts: () => request('/scale/ports'),
  getScaleStatus: () => request('/scale/status'),
  connectScale: (payload) => request('/scale/connect', { method: 'POST', body: payload || {} }),
  disconnectScale: () => request('/scale/disconnect', { method: 'POST' }),

  shutdown: () => request('/shutdown', { method: 'POST', body: { confirm: true } }),
};

// ---------------------------------------------------------------------------
// The live weight source (SSE)  (was scale.js)
// ---------------------------------------------------------------------------

// The single source of the current weight. Mirrors src/lib/weightSource.ts.
//
// The reading is streamed from the serial scale over SSE. A reading is only
// trustworthy for as long as the machine keeps sending: the server polls at
// 100ms, so a frame this old means the link has wedged and the number on screen
// is a leftover rather than a live weight.


const READING_STALE_MS = 2000;

let live = null;
let device = {
  connected: false,
  status: 'stopped',
  port: null,
  baudRate: 0,
  message: null,
  since: null,
  bytesReceived: 0,
};
let baudRates = [9600];
let port = '/dev/ttyS1';
let ports = [];
let deviceBusy = false;
let deviceError = '';

let source = null;
let expireTimer = null;
const listeners = new Set();

function notify() {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      // a broken listener must not stop the others
    }
  }
}

function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function fromStatus(status) {
  return {
    connected: status?.status === 'connected',
    status: status?.status || 'stopped',
    port: status?.port ?? null,
    baudRate: status?.baudRate ?? 0,
    message: status?.message ?? null,
    since: status?.since ?? null,
    bytesReceived: status?.bytesReceived ?? 0,
  };
}

function isReadingStale(reading, now = Date.now()) {
  if (!reading) return true;
  const at = Date.parse(reading.receivedAt);
  if (!Number.isFinite(at)) return true;
  return now - at > READING_STALE_MS;
}

function getReading() {
  return live && !isReadingStale(live) ? live.weight : null;
}

function getLive() {
  return live;
}

function getDevice() {
  return device;
}

function getDeviceError() {
  return deviceError;
}

function getScaleInfo() {
  return { port, ports, baudRates, deviceBusy, deviceError };
}

function startStream() {
  if (source) source.close();
  source = new EventSource(`${apiBase()}/scale/stream`);

  source.addEventListener('status', (event) => {
    let next = null;
    try {
      next = JSON.parse(event.data);
    } catch {
      return;
    }
    device = fromStatus(next);
    deviceError = '';
    if (next?.status !== 'connected') live = null;
    notify();
  });

  source.addEventListener('reading', (event) => {
    let next = null;
    try {
      next = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!Number.isFinite(next?.weight)) return;
    if (isReadingStale(next)) return;
    live = next;
    notify();
  });

  source.onerror = () => {
    live = null;
    device = { ...device, connected: false, status: 'stopped', message: 'Lost connection to the scale service' };
    notify();
  };

  if (expireTimer) clearInterval(expireTimer);
  expireTimer = setInterval(() => {
    if (live && isReadingStale(live)) {
      live = null;
      notify();
    }
  }, 500);
}

async function refreshScaleInfo() {
  try {
    const data = await api.getScalePorts();
    if (typeof data?.port === 'string' && data.port.trim()) port = data.port;
    if (Array.isArray(data?.ports)) ports = data.ports;
    if (Array.isArray(data?.baudRates) && data.baudRates.length) baudRates = data.baudRates;
    deviceError = '';
  } catch (err) {
    deviceError = err?.message || String(err);
  }
  notify();
}

async function initScale() {
  try {
    const status = await api.getScaleStatus();
    device = fromStatus(status);
  } catch (err) {
    deviceError = err?.message || String(err);
  }
  await refreshScaleInfo();
  startStream();
  notify();
}

async function connect(options = {}) {
  if (deviceBusy) return false;
  deviceBusy = true;
  deviceError = '';
  notify();
  try {
    const status = await api.connectScale({ port: options.port ?? port, baudRate: options.baudRate });
    device = fromStatus(status);
    return true;
  } catch (err) {
    deviceError = err?.message || String(err);
    return false;
  } finally {
    deviceBusy = false;
    notify();
  }
}

async function disconnect() {
  if (deviceBusy) return;
  deviceBusy = true;
  deviceError = '';
  notify();
  try {
    const status = await api.disconnectScale();
    device = fromStatus(status);
    live = null;
  } catch (err) {
    deviceError = err?.message || String(err);
  } finally {
    deviceBusy = false;
    notify();
  }
}

// ---------------------------------------------------------------------------
// Animated scale readout
//
// Shared by the staff and admin weighing terminals so the big weight figure
// tweens and settles identically on both. The value is animated over a short
// tween so a moving reading does not jump, and `stable()` reports whether the
// tween has settled (which drives the green "on target" colour).
// ---------------------------------------------------------------------------

const LCD_TWEEN_MS = 120;
const LCD_SETTLE_MS = 420;

const lcdEaseOut = (t) => 1 - Math.pow(1 - t, 3);

export class ScaleLcd {
  constructor(el) {
    this.el = el;
    this.displayed = 0;
    this.hasReading = false;
    this.liveStable = null;
    this.settled = false;
    this.raf = null;
    this.settlingTimer = null;
    this.fallbackTimer = null;
  }

  set(value, liveStable) {
    this.hasReading = value != null && Number.isFinite(value);
    this.liveStable = liveStable == null ? null : liveStable;
    const to = this.hasReading ? value : 0;
    const from = this.displayed;

    if (this.raf !== null) cancelAnimationFrame(this.raf);
    if (this.settlingTimer !== null) clearTimeout(this.settlingTimer);
    if (this.fallbackTimer !== null) clearTimeout(this.fallbackTimer);
    this.settled = false;

    let start = null;
    const step = (time) => {
      if (start === null) start = time;
      const progress = Math.min((time - start) / LCD_TWEEN_MS, 1);
      const next = from + (to - from) * lcdEaseOut(progress);
      this.displayed = next;
      this.paint();
      if (progress < 1) {
        this.raf = requestAnimationFrame(step);
      } else {
        this.raf = null;
        this.settlingTimer = setTimeout(() => {
          this.settlingTimer = null;
          this.settled = true;
          this.paint();
        }, LCD_SETTLE_MS);
      }
    };
    this.raf = requestAnimationFrame(step);
    // A hidden or throttled window suspends animation frames, and the readout
    // must still land on the true weight rather than freeze mid-tween. This
    // timer is a no-op while frames are flowing.
    this.fallbackTimer = setTimeout(() => {
      this.fallbackTimer = null;
      if (this.raf !== null) {
        cancelAnimationFrame(this.raf);
        this.raf = null;
      }
      if (this.settlingTimer !== null) {
        clearTimeout(this.settlingTimer);
        this.settlingTimer = null;
      }
      this.displayed = to;
      this.settled = true;
      this.paint();
    }, LCD_TWEEN_MS + LCD_SETTLE_MS + 40);
  }

  stable() {
    if (!this.hasReading) return false;
    if (this.liveStable !== null && this.liveStable !== undefined) return Boolean(this.liveStable);
    return this.settled;
  }

  paint() {
    if (!this.el) return;
    this.el.textContent = this.hasReading ? fmtWeightNoUnit(this.displayed) : '\u2014.\u2014\u2014\u2014';
    this.el.dataset.status = this.stable() ? 'on' : 'transit';
  }
}

// ---------------------------------------------------------------------------
// Screen-fit text scaling
// ---------------------------------------------------------------------------
// The whole UI is sized in rem off ONE root font size (html, app.css:
// `16 * --font-scale * --screen-fit`). Layout boxes track the viewport, so the
// text must track it too — otherwise bigger screens get box-sized gaps.
//
// Reference design viewport depends on orientation — that is the layout the
// CSS was hand-tuned against and where fit must land exactly on 1:
//   landscape 1280x800, portrait 1080x1920 (the 32" kiosk).
// Picking the smaller ratio tracks the dimension that actually limits the
// text budget (width in landscape, height in portrait) so boxes and text
// grow together — e.g. a 2160x3840 portrait panel gets 2.0, a 1440x2560
// portrait panel gets 1.333. Screens at/below the reference keep the exact
// designed look (fit = 1); small-screen CSS overrides (--screen-fit media
// rules, marked !important) still win over this value.

const FIT_LANDSCAPE = { w: 1280, h: 800 };
const FIT_PORTRAIT = { w: 1080, h: 1920 };
const FIT_MIN = 1;
const FIT_MAX = 2;

function computeScreenFit() {
  const portrait = window.innerHeight > window.innerWidth;
  const ref = portrait ? FIT_PORTRAIT : FIT_LANDSCAPE;
  const w = window.innerWidth / ref.w;
  const h = window.innerHeight / ref.h;
  return Math.min(FIT_MAX, Math.max(FIT_MIN, Math.min(w, h)));
}

function applyScreenFit() {
  document.documentElement.style.setProperty(
    '--screen-fit', computeScreenFit().toFixed(4)
  );
}

function installScreenFit() {
  applyScreenFit();
  window.addEventListener('resize', applyScreenFit, { passive: true });
  window.addEventListener('orientationchange', applyScreenFit, { passive: true });
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export {
  // api
  api, apiBase, ApiError, getServerOrigin, needsServerAddress, setServerAddress,
  normalizeAddress, ttsBase, itemImagesBase,
  // live weight source / alerts / voice / storage, also grouped below
  READING_STALE_MS, subscribe, isReadingStale, getReading, getLive, getDevice,
  getDeviceError, getScaleInfo, startStream, refreshScaleInfo, initScale,
  connect, disconnect,
  // constants
  BRAND, LOGO_SRC, LANG_CODES, nameLoopLangs, FONT_SCALE_STEPS, DEFAULT_PORT,
  AUTO_ADVANCE_MS, MAX_TARGET_KG,
  // helpers
  uid, escapeHtml, el, qs, clear, fmtDateTime, fmtDateTimeLocal, todayParts,
  monthName, debounce, installScreenFit, applyScreenFit,
  // weights
  MIN_TARGET_KG, jsRound, round3, roundOffWeight, roundTargetWeight,
  targetRoundingNote, fmtWeight, fmtWeightNoUnit, fmtSignedValue, fmtSignedDiff, parseWeight,
  evaluateReading,
  // tare + images
  TareBaseline, ImageTooLargeError, ACCEPTED_TYPES, fileToDataUrl,
  // storage keys
  ALERTS_KEY, FONT_SCALE_KEY, SERVER_URL_KEY,
};

// Grouped views so the page scripts can keep calling e.g. scale.getReading().
export const scale = {
  READING_STALE_MS, subscribe, isReadingStale, getReading, getLive, getDevice,
  getDeviceError, getScaleInfo, startStream, refreshScaleInfo, initScale,
  connect, disconnect,
};

export const alerts = {
  alertsEnabled, setAlertsEnabled,
  toggleAlertsEnabled, stopAlertLoop, setAlertLoop, primeAlertAudio, playAlert,
};

export const tts = {
  setTtsBase, stopSpeaking, localizedName, speakItem, preloadAll, orderLangs,
  startNameLoop, stopNameLoop, setSpokenLangListener,
};

export const store = {
  ALERTS_KEY, FONT_SCALE_KEY, SERVER_URL_KEY,
  saveCart, loadCart, clearStoredCart, getRaw, setRaw,
};

