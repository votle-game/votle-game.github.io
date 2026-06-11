// ============================================================
// VOTLE – Main Application
// ============================================================

const VOTE = { NO: 0, YES: 1, ABSTAIN: 2, ABSENT: 3 };
const VOTE_KEY = { 0: 'no', 1: 'yes', 2: 'abstain', 3: 'absent' };
const VOTE_SYMBOL = { 0: '−', 1: '+', 2: '×', 3: '•' };

// Historical entities that voted in the UN but no longer exist as map shapes.
// Guessing ANY of their listed successor states counts as guessing the
// historical entity, and vice versa – guessing the historical code (if it
// somehow appears as a "no" voter) is satisfied by any successor.
const SUCCESSOR_MAP = {
  YU: ['RS', 'ME', 'HR', 'SI', 'MK', 'BA'], // Yugoslavia / Serbia & Montenegro -> ex-Yugoslav states
  CS: ['CZ', 'SK', 'RS', 'ME'],             // Czechoslovakia & Serbia/Montenegro share this code in the data
  DD: ['DE'],                               // East Germany -> Germany
  YD: ['YE'],                               // South Yemen -> Yemen
};

const state = {
  resolutions: [],
  countryMeta: {},
  countries: [],          // [{id,name,path,centroid}]
  countryById: {},
  theme: 'light',
  user: null,             // {username, token}
  authMode: 'login',
  hints: new Set(), // category names with hints enabled (can't be disabled once on)

  // game session
  session: null,
  timerInterval: null,
};

// ---------- Theme ----------
function initTheme() {
  const saved = localStorage.getItem('votle-theme');
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  state.theme = saved || (prefersDark ? 'dark' : 'light');
  applyTheme();
}
function applyTheme() {
  document.documentElement.classList.toggle('dark', state.theme === 'dark');
}
function toggleTheme() {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('votle-theme', state.theme);
  applyTheme();
}

// ---------- Toast ----------
let toastTimer = null;
function toast(msg, ms = 2600) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

// ---------- Data loading ----------
async function loadData() {
  const base = VOTLE_CONFIG.DATA_BASE;
  const [resResp, metaResp, mapResp] = await Promise.all([
    fetch(`${base}/resolutions.json`),
    fetch(`${base}/country_meta.json`),
    fetch(`${base}/countries-50m.json`),
  ]);
  state.resolutions = await resResp.json();
  state.countryMeta = await metaResp.json();
  const topo = await mapResp.json();
  state.countries = GeoEngine.build(topo).filter(c => c.path && c.id && state.countryMeta[c.id]);
  state.countryById = {};
  state.countries.forEach(c => state.countryById[c.id] = c);

  // Some map geometries share an ISO code with a separate territory (e.g. Australia /
  // Ashmore and Cartier Islands both use "AU") – dedupe by id for search/autocomplete.
  const seen = new Set();
  state.searchableCountries = state.countries.filter(c => {
    if (seen.has(c.id)) return false;
    seen.add(c.id);
    return true;
  });

  document.getElementById('poolCount').textContent =
    `${state.resolutions.length.toLocaleString()} resolutions in the archive – 1946 to 2019.`;
}

// ---------- Helpers ----------
function fmtTime(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function flagUrl(alpha2) {
  // flagcdn.com – free, no auth, ISO 3166-1 alpha-2 (lowercase).
  // w40 gives a properly proportioned flag (not cropped/distorted at the edges).
  const code = alpha2.toLowerCase();
  return `https://flagcdn.com/w40/${code}.png`;
}

function countryName(code) {
  const m = state.countryMeta[code];
  return m ? m.name : code;
}

// ============================================================
// SETUP SCREEN
// ============================================================

const setup = {
  difficulty: { value: 'standard', mult: 1.5 },
  era: 'any',
  topic: 'any',
};

function initSetupScreen() {
  // Difficulty / Era / Topic – single-select rows
  document.querySelectorAll('[data-group="difficulty"], [data-group="era"], [data-group="topic"]').forEach(row => {
    row.addEventListener('click', e => {
      const btn = e.target.closest('.choice');
      if (!btn) return;
      const group = row.dataset.group;
      // Topic is split across multiple rows – clear active state in all of them.
      const rows = group === 'topic'
        ? document.querySelectorAll('[data-group="topic"]')
        : [row];
      rows.forEach(r => r.querySelectorAll('.choice').forEach(b => b.classList.remove('is-active')));
      btn.classList.add('is-active');
      if (group === 'difficulty') {
        setup.difficulty = { value: btn.dataset.value, mult: parseFloat(btn.dataset.mult) };
      } else if (group === 'era') {
        setup.era = btn.dataset.value;
      } else if (group === 'topic') {
        setup.topic = btn.dataset.value;
      }
      updatePoolCount();
    });
  });

  document.getElementById('startBtn').addEventListener('click', startSession);

  // Settings overlay
  document.getElementById('settingsBtn').addEventListener('click', () => {
    document.getElementById('settingsOverlay').hidden = false;
  });
  document.getElementById('settingsClose').addEventListener('click', () => {
    document.getElementById('settingsOverlay').hidden = true;
  });
  document.getElementById('settingsOverlay').addEventListener('click', e => {
    if (e.target.id === 'settingsOverlay') document.getElementById('settingsOverlay').hidden = true;
  });
}

// Hints escalate: off -> level 1 (summary) -> level 2 (detailed). Once enabled,
// a hint can't be turned back off – pressing again upgrades it to a better hint.
// Hints can be turned on but not back off – this keeps the challenge fair
// for everyone (no toggling a hint on briefly then off to "peek").
function toggleHint(val) {
  if (state.hints.has(val)) return; // already on, nothing to do
  state.hints.add(val);
  syncHintControls();
  if (state.session && state.session.status === 'playing') {
    renderHints();
  }
}

function syncHintControls() {
  document.querySelectorAll('#hintsToggleRow .hint-chip').forEach(chip => {
    const on = state.hints.has(chip.dataset.value);
    chip.classList.toggle('is-active', on);
    chip.textContent = on ? `${chip.dataset.label}: On` : chip.dataset.label;
  });
}

function initInGameHints() {
  document.getElementById('hintsToggleRow').addEventListener('click', e => {
    const chip = e.target.closest('.hint-chip');
    if (!chip) return;
    toggleHint(chip.dataset.value);
  });
}

function eraRange(era) {
  if (era === 'cold-war') return ['1946-01-01', '1991-12-31'];
  if (era === 'modern') return ['1992-01-01', '2019-12-31'];
  return ['1946-01-01', '2019-12-31'];
}

function getPool() {
  const [start, end] = eraRange(setup.era);
  return state.resolutions.filter(r => {
    if (r.date < start || r.date > end) return false;
    if (setup.topic !== 'any' && !r.issues.includes(setup.topic)) return false;
    return true;
  });
}

function updatePoolCount() {
  const pool = getPool();
  document.getElementById('poolCount').textContent =
    `${pool.length.toLocaleString()} resolutions match your filters.`;
  document.getElementById('startBtn').disabled = pool.length === 0;
}

// ============================================================
// GAME SESSION
// ============================================================

function pickResolution() {
  const pool = getPool();
  // Bias slightly toward resolutions with at least 2 "no" votes for playability,
  // but allow strict difficulty on 1-no resolutions too.
  return pool[Math.floor(Math.random() * pool.length)];
}

function buildSession(resolution, difficultyMultOverride) {
  const allCodes = Object.keys(state.countryMeta);
  const votes = resolution.votes;

  const noCountries = [];
  const yesCountries = [];
  const abstainCountries = [];
  const absentCountries = [];

  allCodes.forEach(code => {
    const v = votes[code];
    if (v === VOTE.NO) noCountries.push(code);
    else if (v === VOTE.YES) yesCountries.push(code);
    else if (v === VOTE.ABSTAIN) abstainCountries.push(code);
    else absentCountries.push(code);
  });

  // Build the list of "claims" the player needs to satisfy. A normal "no"
  // voter is its own claim, satisfiable only by clicking that country.
  // A historical entity (e.g. Yugoslavia, "YU") that no longer has a map
  // shape becomes a claim satisfiable by clicking ANY of its modern
  // successor states – and vice versa, clicking a successor state resolves
  // the historical claim it descends from.
  const noClaims = noCountries.map(code => {
    const successors = SUCCESSOR_MAP[code];
    return {
      key: code,
      satisfiedBy: successors ? new Set(successors) : new Set([code]),
      isHistorical: !!successors,
    };
  });

  // Reverse lookup: clickable map code -> claim(s) it can satisfy
  const claimsByCode = {};
  noClaims.forEach(claim => {
    claim.satisfiedBy.forEach(code => {
      (claimsByCode[code] = claimsByCode[code] || []).push(claim);
    });
  });

  const noCount = noClaims.length;
  const mult = difficultyMultOverride != null ? difficultyMultOverride : setup.difficulty.mult;
  const maxGuesses = Math.max(noCount, Math.ceil(noCount * mult));

  return {
    resolution,
    votes,
    noCountries: new Set(noCountries),
    noClaims,
    claimsByCode,
    yesCountries,
    abstainCountries,
    absentCountries,
    maxGuesses,
    guessesUsed: 0,
    guessedCorrect: new Set(),  // claim keys correctly identified
    guessedWrong: [],           // codes guessed but not "no"
    paintedCodes: new Set(),    // map codes painted as correct (for successor cases)
    startTime: null,
    elapsed: 0,
    status: 'playing', // playing | won | lost
    feed: [],
  };
}

// Simple deterministic string hash -> 32-bit int, for seeding the daily pick.
function hashString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function todayId() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

// Pick today's daily resolution – same for everyone, deterministic by date.
// Restricted to resolutions with 2-6 "no" votes for a fair, bounded challenge.
function pickDailyResolution() {
  const pool = state.resolutions.filter(r => {
    const noCount = Object.values(r.votes).filter(v => v === VOTE.NO).length;
    return noCount >= 2 && noCount <= 6;
  });
  if (!pool.length) return null;
  const idx = hashString('votle-daily-' + todayId()) % pool.length;
  return pool[idx];
}

function startSession(options) {
  if (!state.resolutions.length) return;
  const opts = options || {};
  const isDaily = !!opts.dailyId;
  const resolution = opts.resolution || pickResolution();
  // Daily challenge always uses standard difficulty, regardless of the
  // player's current settings.
  state.session = buildSession(resolution, isDaily ? 1.5 : null);
  state.session.startTime = Date.now();
  state.session.dailyId = opts.dailyId || null;
  state.hints = new Set(); // hints reset each session

  document.getElementById('setupScreen').hidden = true;
  document.getElementById('gameScreen').hidden = false;
  document.getElementById('resultsOverlay').hidden = true;

  renderBallot();
  syncHintControls();
  renderHints();
  renderMap();
  resetMapView();
  updateHud();
  startTimer();
}

function endSession(won) {
  const s = state.session;
  s.status = won ? 'won' : 'lost';
  stopTimer();
  revealAll();
  updateHud();
  showResults();
  submitResult();
  if (s.dailyId) {
    localStorage.setItem('votle-daily-played', s.dailyId);
  }
}

// ---------- Timer ----------
function startTimer() {
  stopTimer();
  state.timerInterval = setInterval(() => {
    const s = state.session;
    if (!s || s.status !== 'playing') return;
    s.elapsed = Math.floor((Date.now() - s.startTime) / 1000);
    document.getElementById('timer').textContent = fmtTime(s.elapsed);
  }, 250);
}
function stopTimer() {
  if (state.timerInterval) clearInterval(state.timerInterval);
  state.timerInterval = null;
}

// ---------- HUD ----------
function updateHud() {
  const s = state.session;
  document.getElementById('timer').textContent = fmtTime(s.elapsed);
  document.getElementById('guessesLeft').textContent = s.maxGuesses - s.guessesUsed;
}

// ============================================================
// BALLOT PANEL
// ============================================================

function renderBallot() {
  const { resolution, yesCountries, abstainCountries, noCountries, absentCountries, maxGuesses } = state.session;

  document.getElementById('resTitle').textContent = resolution.title || `Roll Call #${resolution.id}`;
  document.getElementById('resShort').textContent = toTitleCase(resolution.short || resolution.descr || 'Untitled Resolution');
  const descEl = document.getElementById('resDescr');
  descEl.textContent = recapDescription(resolution);
  descEl.classList.toggle('is-placeholder', isPlaceholderDescr(resolution));
  document.getElementById('resDate').textContent = formatDate(resolution.date);
  document.getElementById('resTopic').textContent = resolution.issues.length
    ? resolution.issues.join(', ')
    : 'General';

  const learnMore = document.getElementById('resLearnMore');
  const docSymbol = unDocSymbol(resolution.title);
  if (docSymbol) {
    learnMore.href = `https://digitallibrary.un.org/search?p=${encodeURIComponent(docSymbol)}`;
    learnMore.hidden = false;
  } else {
    learnMore.hidden = true;
  }

  document.getElementById('countYes').textContent = yesCountries.length;
  document.getElementById('countAbstain').textContent = abstainCountries.length;
  document.getElementById('countNo').textContent = `0 / ${noCountries.size}`;
  document.getElementById('countAbsent').textContent = absentCountries.length;

  updateTallyBar();

  const status = document.getElementById('ballotStatus');
  status.hidden = true;
  status.className = 'ballot-status';
}

function updateTallyBar() {
  const s = state.session;
  const total = s.yesCountries.length + s.abstainCountries.length + s.noCountries.size + s.absentCountries.length;
  const bar = document.getElementById('tallyBar');
  const pct = n => (n / total * 100).toFixed(2) + '%';
  bar.innerHTML = `
    <span class="seg-yes" style="width:${pct(s.yesCountries.length)}"></span>
    <span class="seg-abstain" style="width:${pct(s.abstainCountries.length)}"></span>
    <span class="seg-no" style="width:${pct(s.noCountries.size)}"></span>
    <span class="seg-absent" style="width:${pct(s.absentCountries.length)}"></span>
  `;
}

function toTitleCase(str) {
  if (!str) return '';
  const lower = str.toLowerCase();
  return lower.replace(/(^|\s|[-/(])([a-z])/g, (m, sep, ch) => sep + ch.toUpperCase());
}

function formatDate(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

// Convert this dataset's title format ("R/60/251") into the official UN
// document symbol ("A/RES/60/251") for linking to the UN Digital Library.
function unDocSymbol(title) {
  if (!title) return null;
  const m = title.match(/^R\/(\d+)\/(\S+)$/);
  if (!m) return null;
  return `A/RES/${m[1]}/${m[2]}`;
}

// ============================================================
// HINTS
// ============================================================

function renderHints() {
  const panel = document.getElementById('hintsPanel');
  panel.innerHTML = '';
  if (!state.hints.size) return;

  const s = state.session;
  const noCodes = [...s.noCountries];

  if (state.hints.has('geography')) {
    panel.appendChild(buildHintBlock('Geography of Dissent', noCodes, c => state.countryMeta[c].region));
  }
  if (state.hints.has('religion')) {
    panel.appendChild(buildHintBlock('Majority Faith of Dissent', noCodes, c => state.countryMeta[c].religion));
  }
  if (state.hints.has('language')) {
    panel.appendChild(buildHintBlock('Primary Language of Dissent', noCodes, c => state.countryMeta[c].language));
  }
}

// Aggregate counts across all "no" voters (e.g. "Europe 1/30") – the found
// count updates live as the player correctly identifies countries in that
// group.
function buildHintBlock(title, codes, getValue) {
  const s = state.session;
  const groups = {}; // value -> { total, found }
  codes.forEach(code => {
    const v = getValue(code);
    if (!groups[v]) groups[v] = { total: 0, found: 0 };
    groups[v].total += 1;
    if (s.guessedCorrect.has(code)) groups[v].found += 1;
  });
  const tags = Object.entries(groups)
    .sort((a, b) => b[1].total - a[1].total)
    .map(([k, g]) => `<span class="hint-tag">${k}: ${g.found}/${g.total}</span>`)
    .join('');
  const block = document.createElement('div');
  block.className = 'hint-block';
  block.innerHTML = `<p class="hint-title">${title}</p><div class="hint-tags">${tags}</div>`;
  return block;
}

// ============================================================
// MAP
// ============================================================

const BASE_W = 960, BASE_H = 500;

const mapView = {
  x: 0, y: 0,
  w: BASE_W, h: BASE_H,
  minW: 80,    // most-zoomed-in viewBox width (≈12x)
  maxW: BASE_W, // fully zoomed out
};

let svgEl, viewportEl, tooltipEl;
let labelCache = [];
let viewportRect = null;

function renderMap() {
  svgEl = document.getElementById('mapSvg');
  viewportEl = document.getElementById('mapViewport');
  tooltipEl = document.getElementById('mapTooltip');

  svgEl.innerHTML = '';
  svgEl.setAttribute('viewBox', `0 0 ${BASE_W} ${BASE_H}`);

  const shapesGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  shapesGroup.setAttribute('id', 'shapesGroup');
  const labelsGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  labelsGroup.setAttribute('id', 'labelsGroup');

  state.countries.forEach(c => {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', c.path);
    path.setAttribute('class', 'country-shape');
    path.dataset.code = c.id;
    shapesGroup.appendChild(path);

    if (c.centroid) {
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', c.centroid[0]);
      text.setAttribute('y', c.centroid[1]);
      text.setAttribute('class', 'country-label');
      text.dataset.code = c.id;
      text.dataset.area = c.area || 0;
      text.textContent = c.name || c.id;
      text.setAttribute('text-anchor', 'middle');
      labelsGroup.appendChild(text);
    }
  });

  // Event delegation: one listener per interaction type instead of one per
  // country (240+ shapes) – much cheaper to set up and keeps mousemove
  // handling lightweight.
  shapesGroup.addEventListener('click', e => {
    const code = e.target.dataset && e.target.dataset.code;
    if (code) onCountryClick(code);
  });
  shapesGroup.addEventListener('mousemove', e => {
    const code = e.target.dataset && e.target.dataset.code;
    if (!code) { hideTooltip(); return; }
    const country = state.countryById[code];
    if (country) showTooltip(e, country);
  });
  shapesGroup.addEventListener('mouseleave', hideTooltip);
  shapesGroup.addEventListener('touchstart', e => {
    const code = e.target.dataset && e.target.dataset.code;
    if (!code) return;
    const country = state.countryById[code];
    if (country) showTooltip(e.touches[0], country);
  }, { passive: true });

  svgEl.appendChild(shapesGroup);
  svgEl.appendChild(labelsGroup);

  // Cache label geometry once – avoids repeated getAttribute/parseFloat calls
  // on every pan/zoom frame.
  labelCache = [];
  labelsGroup.querySelectorAll('.country-label').forEach(el => {
    labelCache.push({
      el,
      cx: parseFloat(el.getAttribute('x')),
      cy: parseFloat(el.getAttribute('y')),
      textLen: el.textContent.length,
      area: parseFloat(el.dataset.area) || 0,
    });
  });
  viewportRect = viewportEl.getBoundingClientRect();
  window.addEventListener('resize', () => { viewportRect = viewportEl.getBoundingClientRect(); });

  applyGuessedStyles();
  attachPanZoom();
  updateLabelVisibility();
}

function showTooltip(evt, country) {
  const rect = viewportRect || viewportEl.getBoundingClientRect();
  const x = (evt.clientX !== undefined ? evt.clientX : evt.pageX) - rect.left;
  const y = (evt.clientY !== undefined ? evt.clientY : evt.pageY) - rect.top;
  tooltipEl.style.left = x + 'px';
  tooltipEl.style.top = y + 'px';
  tooltipEl.textContent = country.name || country.id;
  tooltipEl.hidden = false;
}
function hideTooltip() {
  tooltipEl.hidden = true;
}

// ---------- Pan / Zoom (viewBox-based – no per-element restyling) ----------
function attachPanZoom() {
  let dragging = false;
  let lastX, lastY;
  let pinchDist = null;
  let rafPending = false;
  let dragDistance = 0;
  const DRAG_THRESHOLD = 4; // px – beyond this, treat as a pan, not a click

  // Suppress the click on country shapes if the mouse moved more than the
  // threshold between mousedown and mouseup (i.e. the user was panning,
  // not clicking a country).
  svgEl.addEventListener('click', e => {
    if (dragDistance > DRAG_THRESHOLD) {
      e.stopPropagation();
      e.preventDefault();
    }
  }, true);

  let labelUpdateTimer = null;
  function scheduleApply() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      svgEl.setAttribute('viewBox', `${mapView.x.toFixed(2)} ${mapView.y.toFixed(2)} ${mapView.w.toFixed(2)} ${mapView.h.toFixed(2)}`);
      rafPending = false;
      // Label overlap recalculation is the expensive part – debounce it so
      // rapid wheel/drag events don't trigger it on every single frame.
      clearTimeout(labelUpdateTimer);
      labelUpdateTimer = setTimeout(updateLabelVisibility, 80);
    });
  }

  viewportEl.onwheel = e => {
    e.preventDefault();
    const rect = viewportEl.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1 / 1.15 : 1.15;
    zoomAt(cx, cy, rect, factor);
    scheduleApply();
  };

  viewportEl.onmousedown = e => {
    dragging = true;
    dragDistance = 0;
    lastX = e.clientX; lastY = e.clientY;
    viewportEl.classList.add('grabbing');
  };
  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    dragDistance += Math.abs(dx) + Math.abs(dy);
    pan(dx, dy);
    scheduleApply();
  });
  window.addEventListener('mouseup', () => {
    dragging = false;
    viewportEl.classList.remove('grabbing');
  });

  // Touch: pan + pinch zoom
  viewportEl.addEventListener('touchstart', e => {
    if (e.touches.length === 1) {
      dragging = true;
      dragDistance = 0;
      lastX = e.touches[0].clientX; lastY = e.touches[0].clientY;
    } else if (e.touches.length === 2) {
      pinchDist = touchDist(e.touches);
    }
  }, { passive: true });

  viewportEl.addEventListener('touchmove', e => {
    if (e.touches.length === 1 && dragging) {
      const dx = e.touches[0].clientX - lastX;
      const dy = e.touches[0].clientY - lastY;
      lastX = e.touches[0].clientX; lastY = e.touches[0].clientY;
      dragDistance += Math.abs(dx) + Math.abs(dy);
      pan(dx, dy);
      scheduleApply();
    } else if (e.touches.length === 2 && pinchDist != null) {
      const newDist = touchDist(e.touches);
      const factor = pinchDist / newDist;
      pinchDist = newDist;
      const rect = viewportEl.getBoundingClientRect();
      const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left;
      const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top;
      dragDistance += DRAG_THRESHOLD + 1; // pinch is never a tap
      zoomAt(cx, cy, rect, factor);
      scheduleApply();
    }
  }, { passive: true });

  viewportEl.addEventListener('touchend', () => { dragging = false; pinchDist = null; });

  document.getElementById('zoomInBtn').onclick = () => {
    const rect = viewportEl.getBoundingClientRect();
    zoomAt(rect.width / 2, rect.height / 2, rect, 1 / 1.4);
    scheduleApply();
  };
  document.getElementById('zoomOutBtn').onclick = () => {
    const rect = viewportEl.getBoundingClientRect();
    zoomAt(rect.width / 2, rect.height / 2, rect, 1.4);
    scheduleApply();
  };
  document.getElementById('resetViewBtn').onclick = resetMapView;
}

function touchDist(touches) {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

// Pan by screen-space pixel delta – convert to viewBox units using current scale.
function pan(dxScreen, dyScreen) {
  const rect = viewportEl.getBoundingClientRect();
  const scaleX = mapView.w / rect.width;
  const scaleY = mapView.h / rect.height;
  mapView.x -= dxScreen * scaleX;
  mapView.y -= dyScreen * scaleY;
  clampView();
}

// Zoom toward a screen-space point (cx, cy) by `factor` (>1 = zoom out, <1 = zoom in)
function zoomAt(cx, cy, rect, factor) {
  const newW = Math.min(mapView.maxW, Math.max(mapView.minW, mapView.w * factor));
  const realFactor = newW / mapView.w;
  const newH = mapView.h * realFactor;

  // Point under cursor, in viewBox coords, before zoom
  const px = mapView.x + (cx / rect.width) * mapView.w;
  const py = mapView.y + (cy / rect.height) * mapView.h;

  mapView.w = newW;
  mapView.h = newH;
  mapView.x = px - (cx / rect.width) * newW;
  mapView.y = py - (cy / rect.height) * newH;
  clampView();
}

function clampView() {
  // Don't allow panning past the map edges
  mapView.x = Math.min(Math.max(mapView.x, -mapView.w * 0.15), BASE_W - mapView.w * 0.85);
  mapView.y = Math.min(Math.max(mapView.y, -mapView.h * 0.4), BASE_H - mapView.h * 0.6);
}

function resetMapView() {
  mapView.w = BASE_W;
  mapView.h = BASE_H;
  mapView.x = 0;
  mapView.y = 0;
  applyViewBox();
}

function applyViewBox() {
  svgEl.setAttribute('viewBox', `${mapView.x.toFixed(2)} ${mapView.y.toFixed(2)} ${mapView.w.toFixed(2)} ${mapView.h.toFixed(2)}`);
  updateLabelVisibility();
}

// Show country labels only when zoomed in enough that names won't overlap.
function updateLabelVisibility() {
  const zoomRatio = BASE_W / mapView.w; // >1 means zoomed in
  const threshold = 2.2; // require more zoom before any labels appear
  if (zoomRatio < threshold) {
    if (labelsHiddenAll) return;
    labelCache.forEach(item => item.el.classList.remove('visible'));
    labelsHiddenAll = true;
    return;
  }
  labelsHiddenAll = false;

  const rect = viewportRect || viewportEl.getBoundingClientRect();
  const vw = rect.width, vh = rect.height;

  // Font size is fixed at 6px in CSS regardless of zoom (non-scaling), so
  // estimate on-screen text width directly from font size, not from zoomRatio.
  const FONT_PX = 6;
  const CHAR_W = FONT_PX * 0.6;

  const visible = [];
  labelCache.forEach(item => {
    const screenX = (item.cx - mapView.x) / mapView.w * vw;
    const screenY = (item.cy - mapView.y) / mapView.h * vh;
    if (screenX < -50 || screenX > vw + 50 || screenY < -20 || screenY > vh + 20) {
      item.el.classList.remove('visible');
      return;
    }
    visible.push({
      el: item.el, x: screenX, y: screenY,
      w: item.textLen * CHAR_W,
      area: item.area,
    });
  });

  // Larger countries (by land area) get priority – a smaller country's
  // label is suppressed if it overlaps a bigger country's label by any
  // amount.
  visible.sort((a, b) => b.area - a.area);
  const placed = [];
  visible.forEach(item => {
    const overlaps = placed.some(p =>
      Math.abs(p.x - item.x) < (p.w + item.w) / 2 + 4 &&
      Math.abs(p.y - item.y) < 12
    );
    if (overlaps) {
      item.el.classList.remove('visible');
    } else {
      item.el.classList.add('visible');
      placed.push(item);
    }
  });
}
let labelsHiddenAll = false;

// ============================================================
// GUESSING LOGIC
// ============================================================

function onCountryClick(code) {
  const s = state.session;
  if (!s || s.status !== 'playing') return;
  if (s.paintedCodes.has(code)) return; // already painted (correct or wrong)
  if (s.guessedWrong.includes(code)) return; // already tried

  // Does this code satisfy any not-yet-found claim (its own "no" vote, or a
  // historical entity it's a successor of)?
  const candidateClaims = s.claimsByCode[code] || [];
  const claim = candidateClaims.find(c => !s.guessedCorrect.has(c.key));

  if (claim) {
    // Correct guess – doesn't cost a guess, even at 0 remaining.
    s.guessedCorrect.add(claim.key);
    s.paintedCodes.add(code);
    paintCountry(code, 'no', true);
    s.feed.push({ code, result: 'correct', actual: VOTE.NO });
  } else {
    const actual = s.votes[code]; // 0=no,1=yes,2=abstain, undefined=absent
    const actualKey = actual === undefined ? VOTE.ABSENT : actual;
    s.guessesUsed++;
    s.guessedWrong.push(code);
    s.paintedCodes.add(code);
    paintCountry(code, VOTE_KEY[actualKey], true);
    s.feed.push({ code, result: 'wrong', actual: actualKey });
  }

  renderGuessFeed();
  updateBallotCounts();
  updateHud();
  if (state.hints.size) renderHints();

  if (s.guessedCorrect.size >= s.noClaims.length) {
    endSession(true);
  } else if (s.guessesUsed > s.maxGuesses) {
    endSession(false);
  }
}

function paintCountry(code, voteKey, flash) {
  const paths = svgEl.querySelectorAll(`.country-shape[data-code="${code}"]`);
  if (!paths.length) return; // some historical codes have no map shape
  paths.forEach(path => {
    path.classList.remove('flash');
    // force reflow to restart animation
    void path.offsetWidth;
    path.classList.add(`guessed-${voteKey}`);
    if (flash) path.classList.add('flash');
  });
}

function applyGuessedStyles() {
  const s = state.session;
  if (!s) return;
  s.feed.forEach(item => {
    const voteKey = item.result === 'correct' ? 'no' : VOTE_KEY[item.actual];
    paintCountry(item.code, voteKey, false);
  });
}

function revealAll() {
  const s = state.session;
  s.noClaims.forEach(claim => {
    if (s.guessedCorrect.has(claim.key)) return;
    // Reveal every map-clickable successor (or the country itself) that
    // wasn't already painted from a wrong guess.
    claim.satisfiedBy.forEach(code => {
      if (s.paintedCodes.has(code)) return;
      svgEl.querySelectorAll(`.country-shape[data-code="${code}"]`).forEach(path => {
        path.classList.add('revealed-no');
      });
    });
  });
}

function updateBallotCounts() {
  const s = state.session;
  document.getElementById('countNo').textContent = `${s.guessedCorrect.size} / ${s.noClaims.length}`;
}

// ---------- Guess feed ----------
function renderGuessFeed() {
  const feedEl = document.getElementById('guessFeed');
  feedEl.innerHTML = '';
  const recent = state.session.feed.slice(-8);
  recent.forEach(item => {
    const div = document.createElement('div');
    div.className = 'guess-item';
    const iconClass = `gi-${VOTE_KEY[item.actual]}`;
    const symbol = VOTE_SYMBOL[item.actual];
    div.innerHTML = `
      <img src="${flagUrl(item.code)}" alt="">
      <span>${countryName(item.code)}</span>
      <span class="gi-icon ${iconClass}">${symbol}</span>
    `;
    feedEl.appendChild(div);
  });
}

// ============================================================
// RESULTS
// ============================================================

function showResults() {
  const s = state.session;
  const won = s.status === 'won';
  const accuracy = s.guessesUsed + s.guessedCorrect.size > 0
    ? Math.round((s.guessedCorrect.size / (s.guessedCorrect.size + s.guessedWrong.length)) * 100)
    : 0;

  document.getElementById('resultsEyebrow').textContent = won ? 'Session Complete' : 'Session Over';
  document.getElementById('resultsTitle').textContent = won
    ? 'You found every dissenting vote.'
    : 'Out of guesses.';
  document.getElementById('resultAccuracy').textContent = `${accuracy}%`;
  document.getElementById('resultFound').textContent = `${s.guessedCorrect.size} / ${s.noClaims.length}`;
  document.getElementById('resultTime').textContent = fmtTime(s.elapsed);
  document.getElementById('resultGuesses').textContent = `${s.guessesUsed} / ${s.maxGuesses}`;

  const status = document.getElementById('ballotStatus');
  status.hidden = false;
  status.classList.add(won ? 'win' : 'lose');
  status.textContent = won
    ? `Found all ${s.noClaims.length} dissenting votes with ${s.maxGuesses - s.guessesUsed} wrong guesses to spare.`
    : `${s.guessedCorrect.size} of ${s.noClaims.length} dissenters found before running out of guesses.`;

  renderResultsRecap(s, won);

  const playAgainBtn = document.getElementById('playAgainBtn');
  const shareBtn = document.getElementById('shareResultBtn');
  if (s.dailyId) {
    playAgainBtn.textContent = 'Back to Menu';
    shareBtn.hidden = false;
  } else {
    playAgainBtn.textContent = 'Play Again';
    shareBtn.hidden = true;
  }

  if (won) {
    launchConfetti();
  }

  document.getElementById('resultsOverlay').hidden = false;
}

// Display name for a "no" claim – historical entities are shown by name with
// their modern successor states listed alongside.
function claimDisplayName(claim) {
  if (!claim.isHistorical) return countryName(claim.key);
  const meta = state.countryMeta[claim.key];
  const successors = [...claim.satisfiedBy].map(c => countryName(c)).join(' / ');
  return `${meta ? meta.name : claim.key} (${successors})`;
}
function claimFlagCode(claim) {
  if (!claim.isHistorical) return claim.key;
  return [...claim.satisfiedBy][0];
}

function renderResultsRecap(s, won) {
  const recap = document.getElementById('resultsRecap');
  const { resolution, noClaims, guessedCorrect } = s;

  let html = `
    <h3 class="results-recap-title">${toTitleCase(resolution.short || resolution.descr || 'Untitled Resolution')}</h3>
    <p class="results-recap-meta">${formatDate(resolution.date)} · ${resolution.issues.length ? resolution.issues.join(', ') : 'General'}</p>
    <p class="results-recap-desc${isPlaceholderDescr(resolution) ? ' is-placeholder' : ''}">${recapDescription(resolution)}</p>
  `;

  const missed = noClaims.filter(claim => !guessedCorrect.has(claim.key));
  if (!won && missed.length) {
    html += `<div class="recap-missed"><span class="recap-missed-label">Countries You Missed</span>`;
    missed.forEach(claim => {
      html += `<span class="recap-chip"><img src="${flagUrl(claimFlagCode(claim))}" alt="">${claimDisplayName(claim)}</span>`;
    });
    html += `</div>`;
  }

  recap.innerHTML = html;
}

// Many archive entries have no real description – just a repeat of the
// catalogue title (e.g. "Human Rights Council: resolution / adopted by the
// General Assembly"). Detect that and fall back to a useful summary built
// from the resolution's topic/date instead of showing the unhelpful text.
function isPlaceholderDescr(resolution) {
  const d = (resolution.descr || '').trim().toLowerCase();
  const s = (resolution.short || '').trim().toLowerCase();
  if (!d) return true;
  if (d === s) return true;
  if (d.startsWith('resolution / adopted') || d.startsWith('resolution adopted')) return true;
  if (d.length < 25) return true;
  return false;
}

function recapDescription(resolution) {
  if (!isPlaceholderDescr(resolution)) return toTitleCase(resolution.descr);
  const topic = resolution.issues && resolution.issues.length ? resolution.issues.join(', ') : 'general business';
  return `No detailed description is available for this resolution in the archive. ` +
    `Based on its catalogue entry, it concerns ${topic.toLowerCase()} and was adopted on ${formatDate(resolution.date)}. ` +
    `Use the vote breakdown on the left as your main clue.`;
}

const HINT_LABELS = { geography: 'Geography', religion: 'Religion', language: 'Language' };

// Build a Wordle-style share summary for the daily challenge: a row of
// squares for each guess (correct / wrong-but-informative), plus key stats
// and which hints were used, and a link back to the site.
async function shareResult() {
  const s = state.session;
  if (!s) return;

  const squares = s.feed.map(item => {
    if (item.result === 'correct') return '🟩';
    if (item.actual === VOTE.YES) return '🟦';
    if (item.actual === VOTE.ABSTAIN) return '🟨';
    return '⬛'; // absent
  }).join('');

  const accuracy = s.guessedCorrect.size + s.guessedWrong.length > 0
    ? Math.round((s.guessedCorrect.size / (s.guessedCorrect.size + s.guessedWrong.length)) * 100)
    : 0;

  const hintsLine = state.hints.size
    ? `Hints used: ${[...state.hints].map(h => HINT_LABELS[h] || h).join(', ')}`
    : 'Hints used: none';

  const lines = [
    `Votle – ${todayId()}`,
    s.status === 'won' ? 'Solved!' : 'Did not solve',
    `${s.guessedCorrect.size}/${s.noClaims.length} found · ${accuracy}% accuracy · ${fmtTime(s.elapsed)}`,
    squares,
    hintsLine,
    VOTLE_CONFIG.SITE_URL,
  ];
  const text = lines.join('\n');

  if (navigator.share) {
    try {
      await navigator.share({ text });
      return;
    } catch (err) {
      // User cancelled or share failed – fall back to clipboard
    }
  }

  try {
    await navigator.clipboard.writeText(text);
    toast('Result copied to clipboard.');
  } catch (err) {
    toast('Could not copy automatically – select and copy the text manually.');
  }
}

// ---------- Confetti ----------
function launchConfetti() {
  const colors = ['#2BB3A3', '#FF8A5B', '#3FAE63', '#F0B429', '#4FA8D8'];
  const container = document.createElement('div');
  container.className = 'confetti-container';
  const pieceCount = 80;
  for (let i = 0; i < pieceCount; i++) {
    const piece = document.createElement('div');
    piece.className = 'confetti-piece';
    piece.style.left = Math.random() * 100 + 'vw';
    piece.style.background = colors[Math.floor(Math.random() * colors.length)];
    piece.style.animationDuration = (2.2 + Math.random() * 1.6) + 's';
    piece.style.animationDelay = (Math.random() * 0.4) + 's';
    piece.style.transform = `rotate(${Math.random() * 360}deg)`;
    container.appendChild(piece);
  }
  document.body.appendChild(container);
  setTimeout(() => container.remove(), 4200);
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('reviewMapBtn').addEventListener('click', () => {
    document.getElementById('resultsOverlay').hidden = true;
  });
  document.getElementById('playAgainBtn').addEventListener('click', () => {
    document.getElementById('resultsOverlay').hidden = true;
    if (state.session && state.session.dailyId) {
      backToSetup();
    } else {
      startSession();
    }
  });
  document.getElementById('shareResultBtn').addEventListener('click', shareResult);
  document.getElementById('quitBtn').addEventListener('click', () => {
    if (!state.session || state.session.status !== 'playing') {
      backToSetup();
      return;
    }
    if (confirm('End this session early? Your progress will be lost.')) {
      stopTimer();
      backToSetup();
    }
  });
});

function backToSetup() {
  document.getElementById('gameScreen').hidden = true;
  document.getElementById('setupScreen').hidden = false;
  document.getElementById('resultsOverlay').hidden = true;
  state.session = null;
  updatePoolCount();
  refreshDailyCard();
}

// ============================================================
// AUTH
// ============================================================

function initAuth() {
  const token = localStorage.getItem('votle-token');
  const username = localStorage.getItem('votle-username');
  if (token && username) {
    state.user = { username, token };
    updateAccountUI();
  }

  document.getElementById('accountBtn').addEventListener('click', () => {
    if (state.user) {
      // signed in -> sign out
      if (confirm(`Sign out of ${state.user.username}?`)) {
        signOut();
      }
    } else {
      openAuth('login');
    }
  });

  document.getElementById('authClose').addEventListener('click', closeAuth);
  document.getElementById('authOverlay').addEventListener('click', e => {
    if (e.target.id === 'authOverlay') closeAuth();
  });

  document.querySelectorAll('.auth-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('is-active'));
      tab.classList.add('is-active');
      state.authMode = tab.dataset.tab;
      document.getElementById('authSubmit').textContent = state.authMode === 'login' ? 'Sign In' : 'Create Account';
      document.getElementById('authError').hidden = true;
      const pwInput = document.getElementById('authPassword');
      pwInput.autocomplete = state.authMode === 'login' ? 'current-password' : 'new-password';
    });
  });

  document.getElementById('authForm').addEventListener('submit', async e => {
    e.preventDefault();
    const username = document.getElementById('authUsername').value.trim();
    const password = document.getElementById('authPassword').value;
    const errEl = document.getElementById('authError');
    errEl.hidden = true;

    if (username.length < 3 || password.length < 6) {
      errEl.textContent = 'Username must be 3+ characters and password 6+ characters.';
      errEl.hidden = false;
      return;
    }

    const endpoint = state.authMode === 'login' ? '/login' : '/register';
    try {
      const resp = await fetch(VOTLE_CONFIG.WORKER_URL + endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        errEl.textContent = data.error || 'Something went wrong.';
        errEl.hidden = false;
        return;
      }
      state.user = { username, token: data.token };
      localStorage.setItem('votle-token', data.token);
      localStorage.setItem('votle-username', username);
      updateAccountUI();
      closeAuth();
      toast(state.authMode === 'login' ? `Welcome back, ${username}.` : `Account created. Welcome, ${username}.`);
      refreshDailyCard();
    } catch (err) {
      errEl.textContent = 'Could not reach the server. Try again later.';
      errEl.hidden = false;
    }
  });
}

function openAuth(mode) {
  state.authMode = mode;
  document.querySelectorAll('.auth-tab').forEach(t => t.classList.toggle('is-active', t.dataset.tab === mode));
  document.getElementById('authSubmit').textContent = mode === 'login' ? 'Sign In' : 'Create Account';
  document.getElementById('authError').hidden = true;
  document.getElementById('authForm').reset();
  document.getElementById('authOverlay').hidden = false;
}
function closeAuth() {
  document.getElementById('authOverlay').hidden = true;
}

function signOut() {
  state.user = null;
  localStorage.removeItem('votle-token');
  localStorage.removeItem('votle-username');
  updateAccountUI();
  toast('Signed out.');
  refreshDailyCard();
}

function updateAccountUI() {
  const label = document.getElementById('accountLabel');
  label.textContent = state.user ? state.user.username : 'Sign In';
}

// ---------- Submit results ----------
async function submitResult() {
  if (!state.user) return;
  const s = state.session;
  const payload = {
    resolutionId: String(s.resolution.id),
    won: s.status === 'won',
    accuracy: s.guessedCorrect.size + s.guessedWrong.length > 0
      ? Math.round((s.guessedCorrect.size / (s.guessedCorrect.size + s.guessedWrong.length)) * 100)
      : 0,
    timeSeconds: s.elapsed,
    guessesUsed: s.guessesUsed,
    maxGuesses: s.maxGuesses,
    found: s.guessedCorrect.size,
    total: s.noClaims.length,
    difficulty: s.dailyId ? 'standard' : setup.difficulty.value,
    era: s.dailyId ? 'any' : setup.era,
    topic: s.dailyId ? 'any' : setup.topic,
    hints: [...state.hints],
    dailyId: s.dailyId || undefined,
    date: new Date().toISOString(),
  };
  try {
    await fetch(VOTLE_CONFIG.WORKER_URL + '/result', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + state.user.token,
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    // Non-fatal – stats just won't sync this round
    console.warn('Could not save result', err);
  }
}

// ============================================================
// STATS
// ============================================================

function initStats() {
  document.getElementById('statsBtn').addEventListener('click', openStats);
  document.getElementById('statsClose').addEventListener('click', () => {
    document.getElementById('statsOverlay').hidden = true;
  });
  document.getElementById('statsOverlay').addEventListener('click', e => {
    if (e.target.id === 'statsOverlay') document.getElementById('statsOverlay').hidden = true;
  });
}

async function openStats() {
  const overlay = document.getElementById('statsOverlay');
  const signedOut = document.getElementById('statsSignedOut');
  const content = document.getElementById('statsContent');

  if (!state.user) {
    signedOut.hidden = false;
    content.hidden = true;
    overlay.hidden = false;
    return;
  }

  signedOut.hidden = true;
  content.hidden = false;
  content.innerHTML = '<p class="stats-signed-out">Loading your record…</p>';
  overlay.hidden = false;

  try {
    const resp = await fetch(VOTLE_CONFIG.WORKER_URL + '/stats', {
      headers: { 'Authorization': 'Bearer ' + state.user.token },
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to load stats');
    renderStats(data);
  } catch (err) {
    content.innerHTML = `<p class="stats-signed-out">Could not load your stats. ${err.message || ''}</p>`;
  }
}

function renderStats(data) {
  const content = document.getElementById('statsContent');
  if (!data.gamesPlayed) {
    content.innerHTML = '<p class="stats-signed-out">No games recorded yet – play a session to start building your record.</p>';
    return;
  }

  const winRate = Math.round((data.wins / data.gamesPlayed) * 100);
  const avgAccuracy = Math.round(data.avgAccuracy);
  const fastest = data.fastestTime != null ? fmtTime(data.fastestTime) : '–';

  let html = `
    <div class="stats-headline">
      <div class="result-stat"><span class="result-stat-value">${data.gamesPlayed}</span><span class="result-stat-label">Games Played</span></div>
      <div class="result-stat"><span class="result-stat-value">${winRate}%</span><span class="result-stat-label">Win Rate</span></div>
      <div class="result-stat"><span class="result-stat-value">${avgAccuracy}%</span><span class="result-stat-label">Avg Accuracy</span></div>
      <div class="result-stat"><span class="result-stat-value">${fastest}</span><span class="result-stat-label">Fastest Win</span></div>
    </div>

    <div class="stats-headline">
      <div class="result-stat"><span class="result-stat-value">${data.bestStreak}</span><span class="result-stat-label">Best Streak</span></div>
      <div class="result-stat"><span class="result-stat-value">${data.currentStreak}</span><span class="result-stat-label">Current Streak</span></div>
      <div class="result-stat"><span class="result-stat-value">${data.totalFound}</span><span class="result-stat-label">Dissenters Found</span></div>
      <div class="result-stat"><span class="result-stat-value">${data.totalGuesses}</span><span class="result-stat-label">Total Guesses</span></div>
    </div>

    <div class="stats-headline">
      <div class="result-stat"><span class="result-stat-value">${data.dailyStreak || 0}</span><span class="result-stat-label">Daily Streak</span></div>
      <div class="result-stat"><span class="result-stat-value">${data.dailyPlayed || 0}</span><span class="result-stat-label">Dailies Played</span></div>
      <div class="result-stat"><span class="result-stat-value">${data.noHintWins || 0}</span><span class="result-stat-label">Wins w/o Hints</span></div>
      <div class="result-stat"><span class="result-stat-value">${data.flawlessWins || 0}</span><span class="result-stat-label">Flawless Wins</span></div>
    </div>
  `;

  if (data.timeline && data.timeline.length >= 2) {
    html += `<div class="stats-section"><h3>Accuracy Over Time</h3>${renderAccuracyChart(data.timeline)}</div>`;
    html += `<div class="stats-section"><h3>Dissenters Found vs Total</h3>${renderFoundChart(data.timeline)}</div>`;
  }

  if (data.byDifficulty && data.byDifficulty.length) {
    html += `<div class="stats-section"><h3>By Difficulty</h3>${renderBreakdownTable(data.byDifficulty, 'difficulty')}</div>`;
  }
  if (data.byEra && data.byEra.length) {
    html += `<div class="stats-section"><h3>By Era</h3>${renderBreakdownTable(data.byEra, 'era')}</div>`;
  }
  if (data.byTopic && data.byTopic.length) {
    html += `<div class="stats-section"><h3>By Topic</h3>${renderBreakdownTable(data.byTopic, 'topic')}</div>`;
  }

  content.innerHTML = html;
}

// Simple SVG line chart of accuracy% across the most recent games.
function renderAccuracyChart(timeline) {
  if (!timeline.length) return '<p class="chart-empty">No data yet.</p>';
  const W = 600, H = 180, PAD = 28;
  const n = timeline.length;
  const xStep = n > 1 ? (W - PAD * 2) / (n - 1) : 0;
  const points = timeline.map((g, i) => {
    const x = PAD + i * xStep;
    const y = PAD + (1 - g.accuracy / 100) * (H - PAD * 2);
    return { x, y, won: g.won, accuracy: g.accuracy };
  });

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const areaPath = linePath + ` L${points[points.length - 1].x.toFixed(1)},${H - PAD} L${points[0].x.toFixed(1)},${H - PAD} Z`;

  const dots = points.map(p =>
    `<circle class="chart-dot${p.won ? '' : ' lost'}" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2.5"><title>${p.accuracy}%</title></circle>`
  ).join('');

  return `
    <div class="chart-block">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
        <line x1="${PAD}" y1="${PAD}" x2="${PAD}" y2="${H - PAD}" stroke="var(--line)" stroke-width="1"/>
        <line x1="${PAD}" y1="${H - PAD}" x2="${W - PAD}" y2="${H - PAD}" stroke="var(--line)" stroke-width="1"/>
        <text class="chart-axis-label" x="4" y="${PAD + 4}">100%</text>
        <text class="chart-axis-label" x="4" y="${H - PAD}">0%</text>
        <path class="chart-area" d="${areaPath}"/>
        <path class="chart-line" d="${linePath}"/>
        ${dots}
      </svg>
    </div>
  `;
}

// Bar chart of dissenters found vs total per game (most recent games).
function renderFoundChart(timeline) {
  if (!timeline.length) return '<p class="chart-empty">No data yet.</p>';
  const W = 600, H = 180, PAD = 28;
  const n = timeline.length;
  const slot = (W - PAD * 2) / n;
  const barW = Math.max(2, Math.min(14, slot * 0.6));
  const maxTotal = Math.max(...timeline.map(g => g.total), 1);

  let bars = '';
  timeline.forEach((g, i) => {
    const cx = PAD + slot * i + slot / 2;
    const totalH = (g.total / maxTotal) * (H - PAD * 2);
    const foundH = (g.found / maxTotal) * (H - PAD * 2);
    const baseY = H - PAD;
    bars += `<rect x="${(cx - barW / 2).toFixed(1)}" y="${(baseY - totalH).toFixed(1)}" width="${barW.toFixed(1)}" height="${totalH.toFixed(1)}" fill="var(--line)"/>`;
    bars += `<rect x="${(cx - barW / 2).toFixed(1)}" y="${(baseY - foundH).toFixed(1)}" width="${barW.toFixed(1)}" height="${foundH.toFixed(1)}" fill="${g.won ? 'var(--accent)' : 'var(--vote-no)'}"><title>${g.found} / ${g.total}</title></rect>`;
  });

  return `
    <div class="chart-block">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
        <line x1="${PAD}" y1="${H - PAD}" x2="${W - PAD}" y2="${H - PAD}" stroke="var(--line)" stroke-width="1"/>
        ${bars}
      </svg>
    </div>
  `;
}

function renderBreakdownTable(rows, keyName) {
  const labelMap = {
    'cold-war': 'Cold War', 'modern': 'Modern Era', 'any': 'Any Era',
    'generous': 'Generous', 'standard': 'Standard', 'strict': 'Strict',
  };
  let rowsHtml = rows.map(r => {
    const label = labelMap[r[keyName]] || r[keyName];
    const winRate = r.played ? Math.round((r.wins / r.played) * 100) : 0;
    return `<tr>
      <td>${label}</td>
      <td class="num">${r.played}</td>
      <td class="num">${winRate}%</td>
      <td class="num">${Math.round(r.avgAccuracy)}%</td>
    </tr>`;
  }).join('');
  return `<table class="stats-table">
    <thead><tr><th>${keyName === 'difficulty' ? 'Difficulty' : keyName === 'era' ? 'Era' : 'Topic'}</th><th class="num">Played</th><th class="num">Win Rate</th><th class="num">Accuracy</th></tr></thead>
    <tbody>${rowsHtml}</tbody>
  </table>`;
}

// ============================================================
// DAILY CHALLENGE
// ============================================================

function initDailyChallenge() {
  document.getElementById('dailyBtn').addEventListener('click', async () => {
    const resolution = pickDailyResolution();
    if (!resolution) return;
    const dailyId = todayId();

    if (state.user) {
      // Double-check with the server in case of multiple devices/tabs.
      try {
        const resp = await fetch(`${VOTLE_CONFIG.WORKER_URL}/daily-status?id=${dailyId}`, {
          headers: { 'Authorization': 'Bearer ' + state.user.token },
        });
        const data = await resp.json();
        if (data.played) {
          toast("You've already played today's challenge – come back tomorrow.");
          return;
        }
      } catch (err) {
        // Non-fatal – fall through and let them play; server will just record another attempt.
      }
    } else if (localStorage.getItem('votle-daily-played') === dailyId) {
      toast("You've already played today's challenge – come back tomorrow.");
      return;
    }

    startSession({ resolution, dailyId });
  });
}

async function refreshDailyCard() {
  const statusEl = document.getElementById('dailyStatus');
  const btn = document.getElementById('dailyBtn');
  statusEl.innerHTML = '';
  btn.disabled = false;
  btn.textContent = "Play Today's Challenge";

  if (!state.user) {
    if (localStorage.getItem('votle-daily-played') === todayId()) {
      statusEl.innerHTML = `<p class="daily-status-line played">You've completed today's challenge.</p>`;
      btn.disabled = true;
      btn.textContent = 'Completed – Come Back Tomorrow';
    }
    return;
  }

  try {
    const resp = await fetch(`${VOTLE_CONFIG.WORKER_URL}/daily-status?id=${todayId()}`, {
      headers: { 'Authorization': 'Bearer ' + state.user.token },
    });
    const data = await resp.json();
    if (!resp.ok) return;
    if (data.played) {
      const verb = data.won ? 'Solved' : 'Attempted';
      statusEl.innerHTML = `<p class="daily-status-line played">${verb} today – ${data.found} / ${data.total} found, ${data.accuracy}% accuracy.</p>`;
      btn.disabled = true;
      btn.textContent = 'Completed – Come Back Tomorrow';
    }
  } catch (err) {
    // Non-fatal
  }
}

// ============================================================
// GAME HISTORY
// ============================================================

function initHistory() {
  document.getElementById('historyBtn').addEventListener('click', openHistory);
  document.getElementById('historyClose').addEventListener('click', () => {
    document.getElementById('historyOverlay').hidden = true;
  });
  document.getElementById('historyOverlay').addEventListener('click', e => {
    if (e.target.id === 'historyOverlay') document.getElementById('historyOverlay').hidden = true;
  });
}

let historyOffset = 0;
const HISTORY_PAGE_SIZE = 20;

async function openHistory() {
  const overlay = document.getElementById('historyOverlay');
  const signedOut = document.getElementById('historySignedOut');
  const content = document.getElementById('historyContent');

  if (!state.user) {
    signedOut.hidden = false;
    content.hidden = true;
    overlay.hidden = false;
    return;
  }

  signedOut.hidden = true;
  content.hidden = false;
  content.innerHTML = '<p class="stats-signed-out">Loading your history…</p>';
  overlay.hidden = false;
  historyOffset = 0;

  await loadHistoryPage(true);
}

async function loadHistoryPage(reset) {
  const content = document.getElementById('historyContent');
  try {
    const resp = await fetch(`${VOTLE_CONFIG.WORKER_URL}/history?limit=${HISTORY_PAGE_SIZE}&offset=${historyOffset}`, {
      headers: { 'Authorization': 'Bearer ' + state.user.token },
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to load history');

    if (reset) content.innerHTML = '<div class="history-list" id="historyList"></div>';
    const list = document.getElementById('historyList');

    if (!data.items.length && reset) {
      content.innerHTML = '<p class="stats-signed-out">No games played yet – your history will show up here once you finish a session.</p>';
      return;
    }

    data.items.forEach(item => list.appendChild(buildHistoryItem(item)));

    historyOffset += data.items.length;

    const existingMore = content.querySelector('.history-load-more');
    if (existingMore) existingMore.remove();
    if (historyOffset < data.total) {
      const more = document.createElement('button');
      more.className = 'btn-secondary btn-block history-load-more';
      more.textContent = 'Load More';
      more.addEventListener('click', () => loadHistoryPage(false));
      content.appendChild(more);
    }
  } catch (err) {
    content.innerHTML = `<p class="stats-signed-out">Could not load history. ${err.message || ''}</p>`;
  }
}

const ERA_LABELS = { 'cold-war': 'Cold War', 'modern': 'Modern Era', 'any': 'Any Era' };
const DIFFICULTY_LABELS = { 'generous': 'Generous', 'standard': 'Standard', 'strict': 'Strict' };

function buildHistoryItem(item) {
  const div = document.createElement('div');
  div.className = 'history-item';
  const dailyTag = item.dailyId ? `<span class="history-daily-tag">Daily</span>` : '';
  const date = new Date(item.playedAt || item.createdAt);
  const dateStr = isNaN(date.getTime()) ? '' : date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  div.innerHTML = `
    <div class="history-result ${item.won ? 'win' : 'loss'}">${item.won ? 'W' : 'L'}</div>
    <div class="history-info">
      <div class="history-title">Resolution #${item.resolutionId}${dailyTag}</div>
      <div class="history-meta">${dateStr} · ${DIFFICULTY_LABELS[item.difficulty] || item.difficulty} · ${ERA_LABELS[item.era] || item.era}</div>
    </div>
    <div class="history-stats">
      <div class="found">${item.found} / ${item.total}</div>
      <div>${item.accuracy}% · ${fmtTime(item.timeSeconds)}</div>
    </div>
  `;
  return div;
}

// ============================================================
// ACHIEVEMENTS
// ============================================================

const ACHIEVEMENTS = [
  {
    id: 'first-win',
    name: 'First Resolution',
    desc: 'Win your first session.',
    check: s => s.wins >= 1,
  },
  {
    id: 'ten-wins',
    name: 'Seasoned Delegate',
    desc: 'Win 10 sessions.',
    check: s => s.wins >= 10,
  },
  {
    id: 'fifty-wins',
    name: 'Veteran Diplomat',
    desc: 'Win 50 sessions.',
    check: s => s.wins >= 50,
  },
  {
    id: 'streak-3',
    name: 'On a Roll',
    desc: 'Win 3 sessions in a row.',
    check: s => s.bestStreak >= 3,
  },
  {
    id: 'streak-7',
    name: 'Week of Consensus',
    desc: 'Win 7 sessions in a row.',
    check: s => s.bestStreak >= 7,
  },
  {
    id: 'no-hints-win',
    name: 'Unaided Insight',
    desc: 'Win a session without using any hints.',
    check: s => s.noHintWins >= 1,
  },
  {
    id: 'flawless-win',
    name: 'Flawless Vote',
    desc: 'Win a session with no incorrect guesses.',
    check: s => s.flawlessWins >= 1,
  },
  {
    id: 'perfect-accuracy-5',
    name: 'Sharp Eye',
    desc: 'Achieve 100% accuracy in 5 different sessions.',
    check: s => s.perfectAccuracyWins >= 5,
  },
  {
    id: 'fast-win',
    name: 'Speed Reader',
    desc: 'Win a session in under a minute.',
    check: s => s.fastWins >= 1,
  },
  {
    id: 'big-resolution',
    name: 'Major Dissent',
    desc: 'Win a session with 8 or more "no" votes to find.',
    check: s => s.bigWins >= 1,
  },
  {
    id: 'daily-streak-3',
    name: 'Daily Habit',
    desc: 'Complete the daily challenge 3 days in a row.',
    check: s => s.dailyStreak >= 3,
  },
  {
    id: 'daily-streak-7',
    name: 'Weekly Regular',
    desc: 'Complete the daily challenge 7 days in a row.',
    check: s => s.dailyStreak >= 7,
  },
  {
    id: 'daily-30',
    name: 'Calendar Filled',
    desc: 'Complete 30 daily challenges in total.',
    check: s => s.dailyPlayed >= 30,
  },
  {
    id: 'centurion',
    name: 'Centurion',
    desc: 'Play 100 sessions in total.',
    check: s => s.gamesPlayed >= 100,
  },
];

function initAchievements() {
  document.getElementById('achievementsBtn').addEventListener('click', openAchievements);
  document.getElementById('achievementsClose').addEventListener('click', () => {
    document.getElementById('achievementsOverlay').hidden = true;
  });
  document.getElementById('achievementsOverlay').addEventListener('click', e => {
    if (e.target.id === 'achievementsOverlay') document.getElementById('achievementsOverlay').hidden = true;
  });
}

async function openAchievements() {
  const overlay = document.getElementById('achievementsOverlay');
  const signedOut = document.getElementById('achievementsSignedOut');
  const content = document.getElementById('achievementsContent');

  if (!state.user) {
    signedOut.hidden = false;
    content.hidden = true;
    overlay.hidden = false;
    return;
  }

  signedOut.hidden = true;
  content.hidden = false;
  content.innerHTML = '<p class="stats-signed-out">Loading achievements…</p>';
  overlay.hidden = false;

  try {
    const resp = await fetch(`${VOTLE_CONFIG.WORKER_URL}/stats`, {
      headers: { 'Authorization': 'Bearer ' + state.user.token },
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to load achievements');
    renderAchievements(data);
  } catch (err) {
    content.innerHTML = `<p class="stats-signed-out">Could not load achievements. ${err.message || ''}</p>`;
  }
}

function renderAchievements(data) {
  const content = document.getElementById('achievementsContent');
  const stats = data.gamesPlayed ? data : {
    gamesPlayed: 0, wins: 0, bestStreak: 0, noHintWins: 0, flawlessWins: 0,
    perfectAccuracyWins: 0, fastWins: 0, bigWins: 0, dailyStreak: 0, dailyPlayed: 0,
  };

  const unlocked = ACHIEVEMENTS.filter(a => a.check(stats));
  const locked = ACHIEVEMENTS.filter(a => !a.check(stats));

  let html = `<p class="results-recap-meta">${unlocked.length} / ${ACHIEVEMENTS.length} unlocked</p>`;
  html += '<div class="achievements-grid">';
  [...unlocked, ...locked].forEach(a => {
    const isUnlocked = a.check(stats);
    html += `
      <div class="achievement-card ${isUnlocked ? 'is-unlocked' : 'is-locked'}">
        <span class="achievement-name">${a.name}</span>
        <span class="achievement-desc">${a.desc}</span>
        <span class="achievement-status">${isUnlocked ? 'Unlocked' : 'Locked'}</span>
      </div>
    `;
  });
  html += '</div>';

  content.innerHTML = html;
}



document.addEventListener('DOMContentLoaded', async () => {
  initTheme();
  document.getElementById('themeBtn').addEventListener('click', toggleTheme);

  initAuth();
  initStats();
  initSetupScreen();
  initInGameHints();
  initCountrySearch();

  initHistory();
  initAchievements();
  initDailyChallenge();

  document.getElementById('brandBtn').addEventListener('click', () => {
    if (state.session && state.session.status === 'playing') {
      if (!confirm('End this session early? Your progress will be lost.')) return;
      stopTimer();
    }
    backToSetup();
  });

  try {
    await loadData();
    updatePoolCount();
    refreshDailyCard();
  } catch (err) {
    document.getElementById('poolCount').textContent = 'Could not load the resolution archive. Please refresh.';
    console.error(err);
  }
});

// ============================================================
// COUNTRY SEARCH / AUTOCOMPLETE
// ============================================================

function initCountrySearch() {
  const input = document.getElementById('countrySearch');
  const results = document.getElementById('searchResults');

  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    if (!q) { results.hidden = true; results.innerHTML = ''; return; }

    const s = state.session;
    const matches = state.searchableCountries
      .filter(c => state.countryMeta[c.id])
      .filter(c => {
        if (s) {
          if (s.paintedCodes.has(c.id)) return false;
        }
        return countryName(c.id).toLowerCase().includes(q);
      })
      .sort((a, b) => countryName(a.id).localeCompare(countryName(b.id)))
      .slice(0, 8);

    if (!matches.length) {
      results.innerHTML = '<div class="search-result-empty">No matching countries</div>';
    } else {
      results.innerHTML = matches.map(c => `
        <div class="search-result" data-code="${c.id}">
          <img src="${flagUrl(c.id)}" alt="">
          <span>${countryName(c.id)}</span>
        </div>
      `).join('');
    }
    results.hidden = false;
  });

  results.addEventListener('click', e => {
    const item = e.target.closest('.search-result[data-code]');
    if (!item) return;
    const code = item.dataset.code;
    onCountryClick(code);
    input.value = '';
    results.hidden = true;
    results.innerHTML = '';
  });

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const first = results.querySelector('.search-result[data-code]');
      if (first) {
        onCountryClick(first.dataset.code);
        input.value = '';
        results.hidden = true;
        results.innerHTML = '';
      }
    } else if (e.key === 'Escape') {
      results.hidden = true;
    }
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('.search-wrap')) results.hidden = true;
  });
}
