// ============================================================
// VOTLE — Main Application
// ============================================================

const VOTE = { NO: 0, YES: 1, ABSTAIN: 2, ABSENT: 3 };
const VOTE_KEY = { 0: 'no', 1: 'yes', 2: 'abstain', 3: 'absent' };
const VOTE_SYMBOL = { 0: '−', 1: '+', 2: '×', 3: '•' };

// Historical entities that voted in the UN but no longer exist as map shapes.
// Guessing ANY of their listed successor states counts as guessing the
// historical entity, and vice versa — guessing the historical code (if it
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
  hints: new Map(), // category -> level (1 = summary, 2 = detailed)

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
  // Ashmore and Cartier Islands both use "AU") — dedupe by id for search/autocomplete.
  const seen = new Set();
  state.searchableCountries = state.countries.filter(c => {
    if (seen.has(c.id)) return false;
    seen.add(c.id);
    return true;
  });

  document.getElementById('poolCount').textContent =
    `${state.resolutions.length.toLocaleString()} resolutions in the archive — 1946 to 2019.`;
}

// ---------- Helpers ----------
function fmtTime(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function flagUrl(alpha2) {
  // flagcdn.com — free, no auth, ISO 3166-1 alpha-2 (lowercase).
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
  // Difficulty / Era / Topic — single-select rows
  document.querySelectorAll('[data-group="difficulty"], [data-group="era"], [data-group="topic"]').forEach(row => {
    row.addEventListener('click', e => {
      const btn = e.target.closest('.choice');
      if (!btn) return;
      row.querySelectorAll('.choice').forEach(b => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      const group = row.dataset.group;
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

  // Hints — multi-select toggle row
  document.querySelectorAll('[data-group="hints"]').forEach(row => {
    row.addEventListener('click', e => {
      const btn = e.target.closest('.choice');
      if (!btn) return;
      toggleHint(btn.dataset.value);
    });
  });

  document.getElementById('startBtn').addEventListener('click', startSession);
}

// Hints escalate: off -> level 1 (summary) -> level 2 (detailed). Once enabled,
// a hint can't be turned back off — pressing again upgrades it to a better hint.
function toggleHint(val) {
  const current = state.hints.get(val) || 0;
  const next = current >= 2 ? 2 : current + 1;
  state.hints.set(val, next);
  syncHintControls();
  if (state.session && state.session.status === 'playing') {
    renderHints();
  }
}

function syncHintControls() {
  document.querySelectorAll('[data-group="hints"] .choice').forEach(btn => {
    const level = state.hints.get(btn.dataset.value) || 0;
    btn.classList.toggle('is-active', level > 0);
    btn.classList.toggle('is-maxed', level >= 2);
  });
  document.querySelectorAll('#hintsToggleRow .hint-chip').forEach(chip => {
    const level = state.hints.get(chip.dataset.value) || 0;
    chip.classList.toggle('is-active', level > 0);
    chip.classList.toggle('is-maxed', level >= 2);
    const base = chip.dataset.label;
    if (level === 0) chip.textContent = base;
    else if (level === 1) chip.textContent = `${base}: On (tap for more detail)`;
    else chip.textContent = `${base}: Detailed`;
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

function buildSession(resolution) {
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
  // successor states — and vice versa, clicking a successor state resolves
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
  const maxGuesses = Math.max(noCount, Math.ceil(noCount * setup.difficulty.mult));

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

function startSession() {
  if (!state.resolutions.length) return;
  const resolution = pickResolution();
  state.session = buildSession(resolution);
  state.session.startTime = Date.now();

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
  document.getElementById('guessesLeft').textContent = Math.max(0, s.maxGuesses - s.guessesUsed);
}

// ============================================================
// BALLOT PANEL
// ============================================================

function renderBallot() {
  const { resolution, yesCountries, abstainCountries, noCountries, absentCountries, maxGuesses } = state.session;

  document.getElementById('resTitle').textContent = resolution.title || `Roll Call #${resolution.id}`;
  document.getElementById('resShort').textContent = toTitleCase(resolution.short || resolution.descr || 'Untitled Resolution');
  document.getElementById('resDescr').textContent = toTitleCase(resolution.descr || '');
  document.getElementById('resDate').textContent = formatDate(resolution.date);
  document.getElementById('resTopic').textContent = resolution.issues.length
    ? resolution.issues.join(', ')
    : 'General';

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

// ============================================================
// HINTS
// ============================================================

function renderHints() {
  const panel = document.getElementById('hintsPanel');
  panel.innerHTML = '';
  if (!state.hints.size) return;

  const s = state.session;
  const noCodes = [...s.noCountries];

  const geoLevel = state.hints.get('geography') || 0;
  const relLevel = state.hints.get('religion') || 0;
  const langLevel = state.hints.get('language') || 0;

  if (geoLevel === 1) {
    panel.appendChild(buildHintBlock('Geography of Dissent', noCodes.map(c => state.countryMeta[c].region)));
  } else if (geoLevel >= 2) {
    panel.appendChild(buildDetailedHintBlock('Geography of Dissent — by Country', noCodes, c => state.countryMeta[c].region));
  }

  if (relLevel === 1) {
    panel.appendChild(buildHintBlock('Majority Faith of Dissent', noCodes.map(c => state.countryMeta[c].religion)));
  } else if (relLevel >= 2) {
    panel.appendChild(buildDetailedHintBlock('Majority Faith of Dissent — by Country', noCodes, c => state.countryMeta[c].religion));
  }

  if (langLevel === 1) {
    panel.appendChild(buildHintBlock('Primary Language of Dissent', noCodes.map(c => state.countryMeta[c].language)));
  } else if (langLevel >= 2) {
    panel.appendChild(buildDetailedHintBlock('Primary Language of Dissent — by Country', noCodes, c => state.countryMeta[c].language));
  }
}

// Level 1: aggregate counts across all "no" voters (e.g. "Asia ×4")
function buildHintBlock(title, values) {
  const counts = {};
  values.forEach(v => { counts[v] = (counts[v] || 0) + 1; });
  const tags = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<span class="hint-tag">${k}${v > 1 ? ` ×${v}` : ''}</span>`)
    .join('');
  const block = document.createElement('div');
  block.className = 'hint-block';
  block.innerHTML = `<p class="hint-title">${title}</p><div class="hint-tags">${tags}</div>`;
  return block;
}

// Level 2: a tag per "no" voter, naming each country alongside its attribute —
// only revealed for countries not yet correctly guessed, to keep some challenge.
function buildDetailedHintBlock(title, codes, getValue) {
  const s = state.session;
  const tags = codes
    .filter(code => !s.guessedCorrect.has(code))
    .map(code => `<span class="hint-tag">${countryName(code)}: ${getValue(code)}</span>`)
    .join('');
  const block = document.createElement('div');
  block.className = 'hint-block';
  block.innerHTML = `<p class="hint-title">${title}</p><div class="hint-tags">${tags || '<span class="hint-tag">All found</span>'}</div>`;
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
    path.addEventListener('click', () => onCountryClick(c.id));
    path.addEventListener('mousemove', e => showTooltip(e, c));
    path.addEventListener('mouseleave', hideTooltip);
    path.addEventListener('touchstart', e => { showTooltip(e.touches[0], c); }, { passive: true });
    shapesGroup.appendChild(path);

    if (c.centroid) {
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', c.centroid[0]);
      text.setAttribute('y', c.centroid[1]);
      text.setAttribute('class', 'country-label');
      text.dataset.code = c.id;
      text.textContent = c.name || c.id;
      text.setAttribute('text-anchor', 'middle');
      labelsGroup.appendChild(text);
    }
  });

  svgEl.appendChild(shapesGroup);
  svgEl.appendChild(labelsGroup);

  // Cache label geometry once — avoids repeated getAttribute/parseFloat calls
  // on every pan/zoom frame.
  labelCache = [];
  labelsGroup.querySelectorAll('.country-label').forEach(el => {
    labelCache.push({
      el,
      cx: parseFloat(el.getAttribute('x')),
      cy: parseFloat(el.getAttribute('y')),
      textLen: el.textContent.length,
    });
  });
  viewportRect = viewportEl.getBoundingClientRect();
  window.addEventListener('resize', () => { viewportRect = viewportEl.getBoundingClientRect(); });

  applyGuessedStyles();
  attachPanZoom();
  updateLabelVisibility();
}

function showTooltip(evt, country) {
  const rect = viewportEl.getBoundingClientRect();
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

// ---------- Pan / Zoom (viewBox-based — no per-element restyling) ----------
function attachPanZoom() {
  let dragging = false;
  let lastX, lastY;
  let pinchDist = null;
  let rafPending = false;

  let labelUpdateTimer = null;
  function scheduleApply() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      svgEl.setAttribute('viewBox', `${mapView.x.toFixed(2)} ${mapView.y.toFixed(2)} ${mapView.w.toFixed(2)} ${mapView.h.toFixed(2)}`);
      rafPending = false;
      // Label overlap recalculation is the expensive part — debounce it so
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
    lastX = e.clientX; lastY = e.clientY;
    viewportEl.classList.add('grabbing');
  };
  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
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
      pan(dx, dy);
      scheduleApply();
    } else if (e.touches.length === 2 && pinchDist != null) {
      const newDist = touchDist(e.touches);
      const factor = pinchDist / newDist;
      pinchDist = newDist;
      const rect = viewportEl.getBoundingClientRect();
      const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left;
      const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top;
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

// Pan by screen-space pixel delta — convert to viewBox units using current scale.
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
  const threshold = 1.6;
  if (zoomRatio < threshold) {
    if (labelsHiddenAll) return;
    labelCache.forEach(item => item.el.classList.remove('visible'));
    labelsHiddenAll = true;
    return;
  }
  labelsHiddenAll = false;

  const rect = viewportRect || viewportEl.getBoundingClientRect();
  const vw = rect.width, vh = rect.height;

  const visible = [];
  labelCache.forEach(item => {
    const screenX = (item.cx - mapView.x) / mapView.w * vw;
    const screenY = (item.cy - mapView.y) / mapView.h * vh;
    if (screenX < -50 || screenX > vw + 50 || screenY < -20 || screenY > vh + 20) {
      item.el.classList.remove('visible');
      return;
    }
    visible.push({ el: item.el, x: screenX, y: screenY, w: (item.textLen * 6.2 * zoomRatio / 6) });
  });

  visible.sort((a, b) => a.w - b.w);
  const placed = [];
  visible.forEach(item => {
    const overlaps = placed.some(p =>
      Math.abs(p.x - item.x) < (p.w + item.w) / 2 + 6 &&
      Math.abs(p.y - item.y) < 14
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
    // Correct guess — doesn't cost a guess, even at 0 remaining.
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

  if (s.guessedCorrect.size >= s.noClaims.length) {
    endSession(true);
  } else if (s.guessesUsed >= s.maxGuesses) {
    endSession(false);
  }
}

function paintCountry(code, voteKey, flash) {
  const path = svgEl.querySelector(`.country-shape[data-code="${code}"]`);
  if (!path) return; // some historical codes have no map shape
  path.classList.remove('flash');
  // force reflow to restart animation
  void path.offsetWidth;
  path.classList.add(`guessed-${voteKey}`);
  if (flash) path.classList.add('flash');
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
      const path = svgEl.querySelector(`.country-shape[data-code="${code}"]`);
      if (path) path.classList.add('revealed-no');
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

  document.getElementById('resultsOverlay').hidden = false;
}

// Display name for a "no" claim — historical entities are shown by name with
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

// Many archive entries have no real description — just a repeat of the
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

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('reviewMapBtn').addEventListener('click', () => {
    document.getElementById('resultsOverlay').hidden = true;
  });
  document.getElementById('playAgainBtn').addEventListener('click', () => {
    document.getElementById('resultsOverlay').hidden = true;
    startSession();
  });
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
    resolutionId: s.resolution.id,
    won: s.status === 'won',
    accuracy: s.guessedCorrect.size + s.guessedWrong.length > 0
      ? Math.round((s.guessedCorrect.size / (s.guessedCorrect.size + s.guessedWrong.length)) * 100)
      : 0,
    timeSeconds: s.elapsed,
    guessesUsed: s.guessesUsed,
    maxGuesses: s.maxGuesses,
    found: s.guessedCorrect.size,
    total: s.noCountries.size,
    difficulty: setup.difficulty.value,
    era: setup.era,
    topic: setup.topic,
    hints: [...state.hints],
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
    // Non-fatal — stats just won't sync this round
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
    content.innerHTML = '<p class="stats-signed-out">No games recorded yet — play a session to start building your record.</p>';
    return;
  }

  const winRate = Math.round((data.wins / data.gamesPlayed) * 100);
  const avgAccuracy = Math.round(data.avgAccuracy);
  const fastest = data.fastestTime != null ? fmtTime(data.fastestTime) : '—';

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
  `;

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
// BOOTSTRAP
// ============================================================

document.addEventListener('DOMContentLoaded', async () => {
  initTheme();
  document.getElementById('themeBtn').addEventListener('click', toggleTheme);

  initAuth();
  initStats();
  initSetupScreen();
  initInGameHints();
  initCountrySearch();

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
