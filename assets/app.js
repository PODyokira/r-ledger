/* R Ledger — local trading journal
   All data stays in this browser (localStorage + IndexedDB for uploaded images). */
(() => {
  'use strict';

  // ---------------------------------------------------------------- constants
  const STORAGE_KEY = 'rledger.local.journal.v1';
  const IMG_DB = 'rledger.local.images';
  const AUTO_NEXT_KEY = 'rledger.pref.autonextday.v1';
  const IMG_STORE = 'images';
  const LOG_PAGE_SIZE = 25;
  const GALLERY_PAGE_SIZE = 12;
  const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const KNOWN_STATUSES = ['TP', 'SL', 'BE', 'NO TRADE'];

  const PAGES = {
    overview: {
      title: 'Trading overview',
      subtitle: 'Track your execution, risk-reward, and screenshot history.'
    },
    trades: {
      title: 'Trade log',
      subtitle: 'Review each trade and open the original chart screenshots.'
    },
    gallery: {
      title: 'Screenshot gallery',
      subtitle: 'Your visual archive of setups and trading outcomes.'
    },
    calendar: {
      title: 'Trading calendar',
      subtitle: 'See daily execution and realized R over time.'
    }
  };

  // ---------------------------------------------------------------- state
  const state = {
    trades: [],
    meta: { importedFile: '', importedAt: null },
    page: 'overview',
    logPage: 0,
    galleryPage: 0,
    calMonth: null,
    filters: { year: 'all', month: 'all', outcome: 'all', search: '', blanks: false },
    lightbox: { items: [], index: 0 }
  };

  // ---------------------------------------------------------------- elements
  const $ = (id) => document.getElementById(id);
  const els = {};
  let searchTimer = null;
  let toastTimer = null;

  // ---------------------------------------------------------------- utilities
  const pad2 = (n) => String(n).padStart(2, '0');
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
  const numeric = (v) => typeof v === 'number' && Number.isFinite(v);
  const fmt = (n, dec = 1) => numeric(n)
    ? n.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec })
    : '—';
  const moneyR = (n, dec = 2) => numeric(n) ? `${n > 0 ? '+' : ''}${fmt(n, dec)}R` : '—';
  const plainR = (n, dec = 2) => numeric(n) ? `${fmt(n, dec)}R` : '—';
  const rrClass = (n) => !numeric(n) ? 'muted' : n > 0 ? 'rr-up' : n < 0 ? 'rr-down' : 'muted';
  const isBlank = (t) => !t.status && !numeric(t.rr) && !numeric(t.maxRR) && !t.screenshot;
  const outcome = (t) => KNOWN_STATUSES.includes(t.status) ? t.status : 'OTHER';
  const outcomeLabel = (t) => t.status || 'Unspecified';
  const chrono = (a, b) => a.date.localeCompare(b.date) || (Number(a.id) || 0) - (Number(b.id) || 0);
  const todayISO = () => {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  };
  const currentMonth = () => todayISO().slice(0, 7);

  function isoFromParts(y, m, d) {
    if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
    if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return null;
    const dt = new Date(y, m - 1, d, 12);
    if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
    return `${y}-${pad2(m)}-${pad2(d)}`;
  }

  function dateObj(iso) {
    const [y, m, d] = String(iso).split('-').map(Number);
    return new Date(y, m - 1, d, 12);
  }

  function addDaysISO(iso, days) {
    const d = dateObj(iso);
    d.setDate(d.getDate() + days);
    return isoFromParts(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }

  function dateNice(iso) {
    if (!iso) return '—';
    return dateObj(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function weekday(iso) {
    if (!iso) return '';
    return dateObj(iso).toLocaleDateString('en-US', { weekday: 'long' });
  }

  function monthLabel(key) {
    if (!key || !/^\d{4}-\d{2}$/.test(key)) return '—';
    const [y, m] = key.split('-').map(Number);
    return `${MONTHS_SHORT[m - 1]} ${y}`;
  }

  function shiftMonth(key, delta) {
    let [y, m] = key.split('-').map(Number);
    m += delta;
    while (m < 1) { m += 12; y -= 1; }
    while (m > 12) { m -= 12; y += 1; }
    return `${y}-${pad2(m)}`;
  }

  function parseDateValue(v) {
    if (v instanceof Date && !isNaN(v)) return isoFromParts(v.getFullYear(), v.getMonth() + 1, v.getDate());
    if (typeof v === 'number' && Number.isFinite(v)) {
      if (v < 20000) return null;
      const ms = Math.round((v - 25569) * 86400) * 1000;
      const d = new Date(ms);
      return isoFromParts(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    }
    if (typeof v === 'string') {
      const s = v.trim();
      if (!s) return null;
      let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/);
      if (m) return isoFromParts(+m[1], +m[2], +m[3]);
      m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
      if (m) {
        const a = +m[1], b = +m[2];
        let y = +m[3];
        if (y < 100) y += 2000;
        return a > 12 ? isoFromParts(y, b, a) : isoFromParts(y, a, b);
      }
      const d = new Date(s);
      if (!isNaN(d)) return isoFromParts(d.getFullYear(), d.getMonth() + 1, d.getDate());
    }
    return null;
  }

  function normalizeTime(v) {
    if (v === null || v === undefined || v === '') return null;
    if (v instanceof Date && !isNaN(v)) return `${pad2(v.getHours())}:${pad2(v.getMinutes())}`;
    if (typeof v === 'number' && Number.isFinite(v)) {
      let mins = v > 1 ? Math.round(v) : Math.round(v * 1440);
      mins = ((mins % 1440) + 1440) % 1440;
      return `${pad2(Math.floor(mins / 60))}:${pad2(mins % 60)}`;
    }
    if (typeof v === 'string') {
      const s = v.trim();
      if (!s) return null;
      const m = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)?$/i);
      if (m) {
        let h = +m[1];
        const mi = +m[2];
        const ap = (m[3] || '').toLowerCase();
        if (ap === 'pm' && h < 12) h += 12;
        if (ap === 'am' && h === 12) h = 0;
        if (h >= 0 && h < 24 && mi >= 0 && mi < 60) return `${pad2(h)}:${pad2(mi)}`;
      }
      if (/^\d+(\.\d+)?$/.test(s)) return normalizeTime(Number(s));
    }
    return null;
  }

  function numOrNull(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v !== 'string') return null;
    let s = v.trim().replace(/\s/g, '').replace(/R$/i, '').replace(/[−–—]/g, '-');
    if (!s) return null;
    if (/^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
    else if (/^[+-]?\d+,\d+$/.test(s)) s = s.replace(',', '.');
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

  function normalizeStatus(raw) {
    let s = String(raw ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
    if (!s) return '';
    if (['TP', 'TAKE PROFIT', 'TAKEPROFIT', 'WIN', 'TARGET', 'TARGET HIT'].includes(s)) return 'TP';
    if (['SL', 'STOP LOSS', 'STOPLOSS', 'LOSS', 'STOPPED', 'STOPPED OUT'].includes(s)) return 'SL';
    if (['BE', 'BREAK EVEN', 'BREAKEVEN', 'BREAK-EVEN', 'EVEN'].includes(s)) return 'BE';
    if (['NO TRADE', 'NOTRADE', 'NO-TRADE', 'NO SETUP', 'NOSETUP'].includes(s)) return 'NO TRADE';
    return s;
  }

  function parseShot(raw) {
    if (typeof raw !== 'string') return '';
    const s = raw.trim();
    if (!s) return '';
    if (/^https?:\/\//i.test(s)) return s;
    if (/^www\./i.test(s)) return `https://${s}`;
    if (/^[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(s)) return `https://${s}`;
    return '';
  }

  function pillClass(status) {
    if (status === 'TP') return 'tp';
    if (status === 'SL') return 'sl';
    if (status === 'BE') return 'be';
    if (status === 'NO TRADE') return 'no';
    return status ? 'other' : 'no';
  }

  function pill(t) {
    return `<span class="pill ${pillClass(t.status)}">${escapeHtml(outcomeLabel(t))}</span>`;
  }

  function timeText(t) {
    return t.time ? escapeHtml(t.time) : '<span class="muted">—</span>';
  }

  function toast(message, isError = false) {
    clearTimeout(toastTimer);
    els.toast.textContent = message;
    els.toast.classList.toggle('error', !!isError);
    els.toast.hidden = false;
    toastTimer = setTimeout(() => { els.toast.hidden = true; }, isError ? 6500 : 4200);
  }

  function download(content, filename, type) {
    const blob = new Blob([content], { type: type || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // ---------------------------------------------------------------- storage
  function normalizeTrade(raw) {
    const date = parseDateValue(raw && raw.date);
    if (!date) return null;
    const id = Number(raw.id);
    return {
      id: Number.isFinite(id) && id > 0 ? id : null,
      date,
      day: raw.day ? String(raw.day) : weekday(date),
      status: normalizeStatus(raw.status),
      rr: numOrNull(raw.rr),
      maxRR: numOrNull(raw.maxRR),
      time: normalizeTime(raw.time),
      screenshot: typeof raw.screenshot === 'string' ? raw.screenshot : '',
      note: typeof raw.note === 'string' ? raw.note : '',
      sheet: typeof raw.sheet === 'string' ? raw.sheet : '',
      excelRow: Number.isFinite(Number(raw.excelRow)) ? Number(raw.excelRow) : null
    };
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (Array.isArray(data.trades)) {
        const trades = data.trades.map(normalizeTrade).filter(Boolean);
        let next = 1;
        for (const t of trades) { if (!t.id) t.id = next++; else next = Math.max(next, t.id + 1); }
        state.trades = trades.sort(chrono);
      }
      if (data.meta && typeof data.meta === 'object') {
        state.meta = {
          importedFile: String(data.meta.importedFile || ''),
          importedAt: parseDateValue(data.meta.importedAt) || null
        };
      }
    } catch (err) {
      console.warn('Could not load saved journal', err);
    }
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        version: 1,
        savedAt: new Date().toISOString(),
        meta: state.meta,
        trades: state.trades
      }));
    } catch (err) {
      console.warn('Could not save journal', err);
      toast('Could not save locally — browser storage may be full. Export a backup.', true);
    }
  }

  // ---------------------------------------------------------------- image store
  let dbPromise = null;
  const imageUrls = new Map();
  let pendingPreviewUrl = null;

  function imgDb() {
    if (!('indexedDB' in window)) return Promise.reject(new Error('IndexedDB unavailable'));
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(IMG_DB, 1);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(IMG_STORE)) req.result.createObjectStore(IMG_STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('Could not open image store'));
      });
    }
    return dbPromise;
  }

  async function imgPut(key, blob) {
    const db = await imgDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IMG_STORE, 'readwrite');
      tx.objectStore(IMG_STORE).put(blob, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Could not save image'));
    });
  }

  async function imgGet(key) {
    const db = await imgDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IMG_STORE, 'readonly');
      const req = tx.objectStore(IMG_STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error || new Error('Could not read image'));
    });
  }

  async function imgDel(key) {
    try {
      const db = await imgDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(IMG_STORE, 'readwrite');
        tx.objectStore(IMG_STORE).delete(key);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    } catch (err) {
      console.warn('Could not delete image', err);
    }
  }

  async function imgClear() {
    for (const url of imageUrls.values()) URL.revokeObjectURL(url);
    imageUrls.clear();
    try {
      const db = await imgDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(IMG_STORE, 'readwrite');
        tx.objectStore(IMG_STORE).clear();
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    } catch (err) {
      console.warn('Could not clear image store', err);
    }
  }

  async function resolveShot(shot) {
    if (!shot) return '';
    if (shot.startsWith('img:')) {
      const key = shot.slice(4);
      if (imageUrls.has(key)) return imageUrls.get(key);
      try {
        const blob = await imgGet(key);
        if (!blob) return '';
        const url = URL.createObjectURL(blob);
        imageUrls.set(key, url);
        return url;
      } catch (err) {
        console.warn('Could not resolve image', err);
        return '';
      }
    }
    if (shot.startsWith('data:image/')) return shot;
    return shot;
  }

  function fileToDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error || new Error('Could not read file'));
      reader.readAsDataURL(file);
    });
  }

  async function storeUploadedImage(file) {
    const key = `img_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    try {
      await imgPut(key, file);
      return `img:${key}`;
    } catch (err) {
      console.warn('Falling back to embedded image', err);
      const dataUrl = await fileToDataURL(file);
      if (dataUrl.length > 4500000) throw new Error('This image is too large for browser storage. Try a smaller file.');
      return dataUrl;
    }
  }

  async function dropImageRef(ref) {
    if (!ref || !ref.startsWith('img:')) return;
    const key = ref.slice(4);
    const url = imageUrls.get(key);
    if (url) {
      URL.revokeObjectURL(url);
      imageUrls.delete(key);
    }
    await imgDel(key);
  }

  async function hydrateImages(root) {
    const nodes = root.querySelectorAll('img[data-imgref]');
    await Promise.all(Array.from(nodes).map(async (img) => {
      const media = img.closest('.shot-media');
      const ref = img.getAttribute('data-imgref');
      const fail = () => {
        if (media) {
          media.classList.add('broken');
          media.classList.remove('loading');
        }
      };
      try {
        const url = ref && ref.startsWith('img:') ? await resolveShot(ref) : ref;
        if (!url) { fail(); return; }
        img.addEventListener('load', () => {
          img.classList.add('loaded');
          if (media) media.classList.remove('loading');
        }, { once: true });
        img.addEventListener('error', fail, { once: true });
        img.src = url;
      } catch (err) {
        fail();
      }
    }));
  }

  // ---------------------------------------------------------------- filters + analysis
  function readFilters() {
    state.filters.year = els.year.value || 'all';
    state.filters.month = els.month.value || 'all';
    state.filters.outcome = els.status.value || 'all';
    state.filters.search = els.search.value.trim();
    state.filters.blanks = els.includeBlanks.checked;
  }

  function populateFilters() {
    const prevYear = els.year.value || 'all';
    const years = Array.from(new Set(state.trades.map((t) => t.date.slice(0, 4)))).sort().reverse();
    els.year.innerHTML = '<option value="all">All years</option>' +
      years.map((y) => `<option value="${y}">${y}</option>`).join('');
    els.year.value = years.includes(prevYear) ? prevYear : 'all';
    populateMonths(els.month.value || 'all');
  }

  function populateMonths(preferred) {
    const year = els.year.value;
    const months = Array.from(new Set(state.trades
      .filter((t) => year === 'all' || t.date.startsWith(year))
      .map((t) => t.date.slice(0, 7)))).sort().reverse();
    els.month.innerHTML = '<option value="all">All months</option>' +
      months.map((m) => `<option value="${m}">${monthLabel(m)}</option>`).join('');
    els.month.value = months.includes(preferred) ? preferred : 'all';
  }

  function resetFilterControls() {
    els.year.value = 'all';
    els.month.value = 'all';
    els.status.value = 'all';
    els.search.value = '';
    els.includeBlanks.checked = false;
  }

  function filtered() {
    const f = state.filters;
    const q = f.search.toLowerCase();
    return state.trades.filter((t) => {
      if (!f.blanks && isBlank(t)) return false;
      if (f.year !== 'all' && !t.date.startsWith(f.year)) return false;
      if (f.month !== 'all' && !t.date.startsWith(f.month)) return false;
      if (f.outcome !== 'all' && outcome(t) !== f.outcome) return false;
      if (!q) return true;
      const haystack = [t.date, dateNice(t.date), t.day, t.status, outcomeLabel(t), t.sheet, t.rr, t.maxRR, t.time, t.note];
      return haystack.some((v) => String(v ?? '').toLowerCase().includes(q));
    }).sort((a, b) => b.date.localeCompare(a.date) || (Number(b.id) || 0) - (Number(a.id) || 0));
  }

  function analysis(trades) {
    const done = trades.filter((t) => numeric(t.rr));
    const wins = trades.filter((t) => t.status === 'TP');
    const losses = trades.filter((t) => t.status === 'SL');
    const be = trades.filter((t) => t.status === 'BE');
    const noTrade = trades.filter((t) => t.status === 'NO TRADE');
    const unknown = trades.filter((t) => !KNOWN_STATUSES.includes(t.status));
    const scored = trades.filter((t) => t.status === 'TP' || t.status === 'SL');
    const total = done.reduce((sum, t) => sum + t.rr, 0);
    const vals = done.slice().sort(chrono);

    let peak = 0, running = 0, draw = 0;
    for (const row of vals) {
      running += row.rr;
      peak = Math.max(peak, running);
      draw = Math.max(draw, peak - running);
    }

    let winStreak = 0, lossStreak = 0, sw = 0, sl = 0;
    for (const row of scored.slice().sort(chrono)) {
      if (row.status === 'TP') { sw += 1; sl = 0; winStreak = Math.max(winStreak, sw); }
      else { sl += 1; sw = 0; lossStreak = Math.max(lossStreak, sl); }
    }

    return {
      done, wins, losses, be, noTrade, unknown, scored, total,
      winRate: scored.length ? (wins.length / scored.length) * 100 : null,
      avg: done.length ? total / done.length : null,
      draw, winStreak, lossStreak, vals
    };
  }

  function shotItems(trades) {
    return trades.filter((t) => t.screenshot).slice().sort(chrono);
  }

  // ---------------------------------------------------------------- render: shell
  function refreshSidebar() {
    const shots = state.trades.filter((t) => t.screenshot).length;
    els.sideCount.textContent = `${state.trades.length.toLocaleString()} dated rows · ${shots.toLocaleString()} image links`;
    if (state.trades.length && state.meta.importedFile) {
      const when = state.meta.importedAt ? ` · imported ${dateNice(state.meta.importedAt)}` : '';
      els.sourceInfo.textContent = `Source: ${state.meta.importedFile}${when} · stored locally`;
    } else {
      els.sourceInfo.textContent = 'Source: local dashboard · data stored in this browser';
    }
  }

  function showPage(name, syncHash = true) {
    if (!PAGES[name]) return;
    state.page = name;
    document.querySelectorAll('.page').forEach((el) => {
      el.hidden = el.id !== `page-${name}`;
    });
    document.querySelectorAll('.navbtn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.page === name);
    });
    els.pageTitle.textContent = PAGES[name].title;
    els.pageSubtitle.textContent = PAGES[name].subtitle;
    if (syncHash && location.hash !== `#${name}`) {
      history.replaceState(null, '', `#${name}`);
    }
    window.scrollTo({ top: 0, behavior: 'instant' });
    render();
  }

  function render() {
    readFilters();
    const data = filtered();
    refreshSidebar();
    renderOverview(data);
    renderTradeLog(data);
    renderGallery(data);
    renderCalendar(data);
  }

  // ---------------------------------------------------------------- render: overview
  function kpi(label, value, note, color = '') {
    return `<div class="kpi">
      <div class="label">${escapeHtml(label)}</div>
      <div class="big ${color}">${value}</div>
      <div class="note">${escapeHtml(note)}</div>
    </div>`;
  }

  function chartEmpty(title, subtitle) {
    return `<div class="chart-empty"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(subtitle)}</span></div>`;
  }

  function renderOverview(data) {
    const s = analysis(data);
    const hasTrades = data.length > 0;
    els.kpis.innerHTML =
      kpi('Recorded trades', s.scored.length.toLocaleString(), 'TP + SL outcomes') +
      kpi('Win rate', numeric(s.winRate) ? `${fmt(s.winRate, 1)}%` : '—', 'TP / (TP + SL)', numeric(s.winRate) ? 'green' : '') +
      kpi('Net realized R', s.done.length ? moneyR(s.total) : '—', `${s.done.length} numeric RR records`, s.total > 0 ? 'green' : s.total < 0 ? 'red' : '') +
      kpi('Average R / trade', numeric(s.avg) ? moneyR(s.avg) : '—', 'Numeric RR entries', numeric(s.avg) ? (s.avg > 0 ? 'green' : s.avg < 0 ? 'red' : '') : '') +
      kpi('Max R drawdown', s.vals.length ? `${fmt(s.draw, 2)}R` : '—', 'Based on recorded sequence', s.vals.length ? 'red' : '');

    renderEquity(s.vals);
    renderBreakdown(s, data);
    renderMonthly(data);
    renderScatter(data);

    const recent = data.slice(0, 8);
    const tableWrap = els.recentRows.closest('.table-wrap');
    tableWrap.hidden = recent.length === 0;
    els.recentEmpty.hidden = recent.length > 0;
    if (!recent.length) {
      els.recentEmpty.innerHTML = hasTrades
        ? '<strong>No trades match your filters.</strong>Try widening the year, month or outcome filters.'
        : '<strong>No trades recorded yet.</strong>Add your first trade or import an Excel/CSV journal to get started.<br><button type="button" class="btn primary" data-open-add>+ Add trade</button>';
    } else {
      els.recentRows.innerHTML = recent.map((t) => tradeRow(t)).join('');
    }
  }

  function tradeRow(t, withActions = false) {
    return `<tr>
      <td class="date-cell">${escapeHtml(dateNice(t.date))}</td>
      <td>${escapeHtml(t.day || weekday(t.date))}</td>
      <td>${pill(t)}</td>
      <td class="${rrClass(t.rr)}">${moneyR(t.rr)}</td>
      <td>${numeric(t.maxRR) ? plainR(t.maxRR) : '<span class="muted">—</span>'}</td>
      <td>${timeText(t)}</td>
      <td>${t.screenshot ? `<button type="button" class="link-btn" data-shot="${t.id}">View image ↗</button>` : '<span class="muted">—</span>'}</td>
      ${withActions ? `<td class="col-actions">
        <button type="button" class="action-btn" data-edit="${t.id}" title="Edit trade" aria-label="Edit trade">
          <svg viewBox="0 0 24 24"><path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3Z"/><path d="m14 7 3 3"/></svg>
        </button>
        <button type="button" class="action-btn del" data-del="${t.id}" title="Delete trade" aria-label="Delete trade">
          <svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13M10 11v6M14 11v6"/></svg>
        </button>
      </td>` : ''}
    </tr>`;
  }

  function renderEquity(rows) {
    const values = rows.map((t) => t.rr);
    const points = [{ date: null, value: 0, rr: null }];
    let running = 0;
    rows.forEach((t) => { running += t.rr; points.push({ date: t.date, value: running, rr: t.rr, status: t.status }); });

    if (!rows.length) {
      els.equityWrap.innerHTML = chartEmpty('No realized R yet', 'Add trades or import a workbook to see your cumulative R curve.');
      return;
    }

    const W = Math.max(300, Math.round(els.equityWrap.clientWidth || 720)), H = 270, PL = 54, PR = 16, PT = 14, PB = 34;
    const vals = points.map((p) => p.value);
    let lo = Math.min(0, ...vals);
    let hi = Math.max(0, ...vals);
    if (hi === lo) { hi = lo + 1; }
    const range = hi - lo;
    const n = points.length;
    const x = (i) => PL + (n === 1 ? 0 : i / (n - 1)) * (W - PL - PR);
    const y = (v) => PT + ((hi - v) / range) * (H - PT - PB);
    const ticks = Array.from({ length: 5 }, (_, i) => hi - (i * range) / 4);
    const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
    const area = `${path} L${x(n - 1).toFixed(1)},${H - PB} L${x(0).toFixed(1)},${H - PB} Z`;
    const axisDec = Math.max(Math.abs(lo), Math.abs(hi)) < 20 ? 1 : 0;

    const grid = ticks.map((v) => `
      <line class="gridline" x1="${PL}" x2="${W - PR}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>
      <text class="axis" x="${PL - 9}" y="${(y(v) + 3.5).toFixed(1)}" text-anchor="end">${fmt(v, axisDec)}</text>
    `).join('');

    els.equityWrap.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Cumulative realized R chart">
        <defs>
          <linearGradient id="equityFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#60dfc1" stop-opacity=".26"/>
            <stop offset="100%" stop-color="#60dfc1" stop-opacity="0"/>
          </linearGradient>
        </defs>
        ${grid}
        <path d="${area}" fill="url(#equityFill)"/>
        <path d="${path}" fill="none" stroke="#74ebca" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>
        <line class="crosshair" id="eqCross" x1="0" x2="0" y1="${PT}" y2="${H - PB}" hidden/>
        <circle class="chart-dot" id="eqDot" cx="0" cy="0" r="4" hidden/>
        <text class="axis" x="${PL}" y="${H - 10}" text-anchor="start">${escapeHtml(rows[0].date)}</text>
        <text class="axis" x="${W - PR}" y="${H - 10}" text-anchor="end">${escapeHtml(rows[rows.length - 1].date)}</text>
      </svg>
      <div class="chart-tip" id="eqTip" hidden></div>`;

    const svg = els.equityWrap.querySelector('svg');
    const tip = $('eqTip');
    const cross = $('eqCross');
    const dot = $('eqDot');

    svg.addEventListener('pointermove', (event) => {
      const rect = svg.getBoundingClientRect();
      const px = ((event.clientX - rect.left) / rect.width) * W;
      let i = Math.round(((px - PL) / (W - PL - PR)) * (n - 1));
      i = Math.max(0, Math.min(n - 1, i));
      const point = points[i];
      const px2 = x(i);
      const py = y(point.value);
      cross.hidden = false;
      cross.setAttribute('x1', px2);
      cross.setAttribute('x2', px2);
      dot.hidden = false;
      dot.setAttribute('cx', px2);
      dot.setAttribute('cy', py);
      tip.hidden = false;
      tip.style.left = `${(px2 / W) * 100}%`;
      tip.style.top = `${(py / H) * 100}%`;
      tip.innerHTML = point.date
        ? `<b>${moneyR(point.value)}</b><span>${escapeHtml(dateNice(point.date))} · trade ${moneyR(point.rr)}</span>`
        : '<b>0.00R</b><span>Start of journal</span>';
    });
    svg.addEventListener('pointerleave', () => {
      cross.hidden = true;
      dot.hidden = true;
      tip.hidden = true;
    });
  }

  function renderBreakdown(s, data) {
    const denominator = s.scored.length || 1;
    const bar = (label, count, color) => `
      <div class="barrow">
        <span class="barlabel">${escapeHtml(label)}</span>
        <span class="bartrack"><span class="barfill" style="width:${Math.min(100, (count / denominator) * 100)}%;background:${color}"></span></span>
        <b class="barval">${count}</b>
      </div>`;
    els.outcomeBreakdown.innerHTML =
      bar('Take profit', s.wins.length, 'var(--accent)') +
      bar('Stop loss', s.losses.length, 'var(--red)') +
      bar('Break-even', s.be.length, 'var(--yellow)') +
      bar('No trade', s.noTrade.length, '#8094a8') +
      bar('Other', s.unknown.length, '#7384b5');

    els.extraStats.innerHTML = `
      <div class="mini"><strong>${s.winStreak}</strong><span>Longest TP streak</span></div>
      <div class="mini"><strong>${s.lossStreak}</strong><span>Longest SL streak</span></div>
      <div class="mini"><strong>${s.vals.length}</strong><span>RR entries</span></div>
      <div class="mini"><strong>${data.filter((t) => t.screenshot).length}</strong><span>Screenshot links</span></div>`;
  }

  function renderMonthly(data) {
    const groups = new Map();
    for (const t of data) {
      if (!numeric(t.rr)) continue;
      const key = t.date.slice(0, 7);
      groups.set(key, (groups.get(key) || 0) + t.rr);
    }
    const rows = Array.from(groups.entries()).sort((a, b) => b[0].localeCompare(a[0]));
    if (!rows.length) {
      els.monthlyChart.innerHTML = chartEmpty('No monthly data yet', 'Monthly sums appear once trades have numeric RR values.');
      return;
    }
    const maxAbs = Math.max(...rows.map(([, v]) => Math.abs(v)), 1);
    els.monthlyChart.innerHTML = `<div class="monthly-scroll">` + rows.map(([key, value]) => {
      const width = Math.max(2, (Math.abs(value) / maxAbs) * 100);
      const color = value > 0 ? 'var(--accent)' : value < 0 ? 'var(--red)' : '#8094a8';
      const cls = value > 0 ? 'up' : value < 0 ? 'down' : 'zero';
      return `<div class="mrow" title="${escapeHtml(`${monthLabel(key)}: ${moneyR(value)}`)}">
        <span class="mlabel">${escapeHtml(monthLabel(key))}</span>
        <span class="mtrack"><span class="mfill" style="width:${width}%;background:${color}"></span></span>
        <span class="mval ${cls}">${moneyR(value)}</span>
      </div>`;
    }).join('') + '</div>';
  }

  function renderScatter(data) {
    const rows = data.filter((t) => numeric(t.rr) && numeric(t.maxRR));
    if (!rows.length) {
      els.scatterWrap.innerHTML = chartEmpty('No comparison data yet', 'Add Max RR values alongside realized RR to compare captured vs. maximum.');
      return;
    }
    const W = Math.max(300, Math.round(els.scatterWrap.clientWidth || 720)), H = 280, PL = 54, PR = 18, PT = 16, PB = 40;
    const maxX = Math.max(...rows.map((t) => t.maxRR), 1);
    let loY = Math.min(0, ...rows.map((t) => t.rr));
    let hiY = Math.max(0, ...rows.map((t) => t.rr));
    if (hiY === loY) hiY = loY + 1;
    const padX = Math.max(maxX * 0.04, 0.5);
    const xMax = maxX + padX;
    const yRange = hiY - loY;
    const x = (v) => PL + (v / xMax) * (W - PL - PR);
    const y = (v) => PT + ((hiY - v) / yRange) * (H - PT - PB);

    const yTicks = Array.from({ length: 5 }, (_, i) => hiY - (i * yRange) / 4);
    const xTicks = Array.from({ length: 5 }, (_, i) => (i * xMax) / 4);
    const grid = yTicks.map((v) => `
      <line class="gridline" x1="${PL}" x2="${W - PR}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>
      <text class="axis" x="${PL - 9}" y="${(y(v) + 3.5).toFixed(1)}" text-anchor="end">${fmt(v, 1)}</text>
    `).join('') + xTicks.map((v) => `
      <text class="axis" x="${x(v).toFixed(1)}" y="${H - 18}" text-anchor="middle">${fmt(v, v % 1 === 0 ? 0 : 1)}</text>
    `).join('');

    const dots = rows.map((t) => {
      const cx = x(t.maxRR).toFixed(1);
      const cy = y(t.rr).toFixed(1);
      const color = t.rr > 0 ? '#74ebca' : t.rr < 0 ? '#ff8fa3' : '#9fb0c4';
      return `<circle cx="${cx}" cy="${cy}" r="4.6" fill="${color}" fill-opacity=".78" stroke="#0d1b26" stroke-width="1">
        <title>${escapeHtml(`${dateNice(t.date)} — realized ${moneyR(t.rr)}, max ${plainR(t.maxRR)}`)}</title>
      </circle>`;
    }).join('');

    els.scatterWrap.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="RR captured versus maximum RR">
        ${grid}
        ${dots}
        <text class="axis" x="${(PL + (W - PR)) / 2}" y="${H - 2}" text-anchor="middle">Maximum observed RR →</text>
      </svg>`;
  }

  // ---------------------------------------------------------------- render: trade log
  function renderTradeLog(data) {
    const total = data.length;
    const pages = Math.max(1, Math.ceil(total / LOG_PAGE_SIZE));
    state.logPage = Math.max(0, Math.min(state.logPage, pages - 1));
    const start = state.logPage * LOG_PAGE_SIZE;
    const rows = data.slice(start, start + LOG_PAGE_SIZE);
    const tableWrap = els.logRows.closest('.table-wrap');

    els.logCount.textContent = `${total.toLocaleString()} matching row${total === 1 ? '' : 's'}`;
    tableWrap.hidden = total === 0;
    els.logRows.innerHTML = rows.map((t) => tradeRow(t, true)).join('');

    els.logEmpty.hidden = total > 0;
    if (!total) {
      els.logEmpty.innerHTML = state.trades.length
        ? '<strong>No trades match your filters.</strong>Try clearing the search or choosing “All years / All months”.'
        : '<strong>No trades yet.</strong>Add your first trade, or import an Excel/CSV journal.<br><button type="button" class="btn primary" data-open-add>+ Add trade</button>';
    }
    renderPager(els.logPager, total, state.logPage, LOG_PAGE_SIZE, (p) => {
      state.logPage = p;
      renderTradeLog(filtered());
    });
  }

  function renderPager(el, total, page, size, onChange) {
    if (total <= size) { el.innerHTML = ''; return; }
    const pages = Math.ceil(total / size);
    const from = page * size + 1;
    const to = Math.min(total, (page + 1) * size);
    el.innerHTML = `<span>Showing ${from}–${to} of ${total.toLocaleString()}</span>
      <div class="page-btns">
        <button type="button" data-dir="prev" ${page <= 0 ? 'disabled' : ''}>‹ Prev</button>
        <span class="page-num">Page ${page + 1} of ${pages}</span>
        <button type="button" data-dir="next" ${page >= pages - 1 ? 'disabled' : ''}>Next ›</button>
      </div>`;
    el.querySelectorAll('button[data-dir]').forEach((btn) => {
      btn.addEventListener('click', () => {
        onChange(btn.dataset.dir === 'next' ? page + 1 : page - 1);
      });
    });
  }

  // ---------------------------------------------------------------- render: gallery
  function renderGallery(data) {
    const items = shotItems(data);
    const pages = Math.max(1, Math.ceil(items.length / GALLERY_PAGE_SIZE));
    state.galleryPage = Math.max(0, Math.min(state.galleryPage, pages - 1));
    const start = state.galleryPage * GALLERY_PAGE_SIZE;
    const pageItems = items.slice(start, start + GALLERY_PAGE_SIZE);

    els.galleryCount.textContent = `${items.length.toLocaleString()} linked screenshot${items.length === 1 ? '' : 's'}`;
    els.galleryGrid.hidden = items.length === 0;
    els.galleryGrid.innerHTML = pageItems.map((t) => {
      const rr = numeric(t.rr) ? moneyR(t.rr) : '—';
      const rrCls = numeric(t.rr) && t.rr > 0 ? 'up' : numeric(t.rr) && t.rr < 0 ? 'down' : '';
      return `<button type="button" class="shot-card" data-shot-open="${t.id}">
        <div class="shot-media loading">
          <div class="shot-fallback">
            <span>Image unavailable</span>
            <span>Open the trade in the log to check the link.</span>
          </div>
          <img data-imgref="${escapeHtml(t.screenshot)}" alt="Chart screenshot for ${escapeHtml(dateNice(t.date))}" loading="lazy">
        </div>
        <div class="shot-body">
          <div class="shot-date">${escapeHtml(dateNice(t.date))}</div>
          <div class="shot-meta">
            ${pill(t)}
            <span class="rr ${rrCls}">${rr}</span>
          </div>
        </div>
      </button>`;
    }).join('');

    els.galleryEmpty.hidden = items.length > 0;
    if (!items.length) {
      const h3 = els.galleryEmpty.querySelector('h3');
      const p = els.galleryEmpty.querySelector('p');
      if (state.trades.some((t) => t.screenshot)) {
        h3.textContent = 'No screenshots match your filters';
        p.textContent = 'Widen the filters above to see the rest of your screenshot archive.';
        els.galleryEmpty.querySelector('[data-open-add]').hidden = true;
      } else {
        h3.textContent = 'No screenshots yet';
        p.innerHTML = 'Add screenshot links or upload chart images when you create a trade. Imported workbooks can include a <strong>Screenshot</strong> column with image URLs.';
        els.galleryEmpty.querySelector('[data-open-add]').hidden = false;
      }
    }

    renderPager(els.galleryPager, items.length, state.galleryPage, GALLERY_PAGE_SIZE, (p) => {
      state.galleryPage = p;
      renderGallery(filtered());
    });

    hydrateImages(els.galleryGrid);
  }

  // ---------------------------------------------------------------- render: calendar
  function ensureCalMonth() {
    if (state.calMonth && /^\d{4}-\d{2}$/.test(state.calMonth)) return;
    const months = state.trades.map((t) => t.date.slice(0, 7)).sort();
    state.calMonth = months.length ? months[months.length - 1] : currentMonth();
  }

  function renderCalendar(data) {
    ensureCalMonth();
    const allMonths = Array.from(new Set([
      ...state.trades.map((t) => t.date.slice(0, 7)),
      state.calMonth,
      currentMonth()
    ])).sort().reverse();
    els.calMonth.innerHTML = allMonths
      .map((m) => `<option value="${m}">${monthLabel(m)}</option>`).join('');
    els.calMonth.value = state.calMonth;
    els.calMonthLabel.textContent = monthLabel(state.calMonth);

    const monthData = data.filter((t) => t.date.startsWith(state.calMonth));
    const byDate = new Map();
    for (const t of monthData) {
      if (!byDate.has(t.date)) byDate.set(t.date, []);
      byDate.get(t.date).push(t);
    }

    const [year, month] = state.calMonth.split('-').map(Number);
    const first = new Date(year, month - 1, 1, 12);
    const offset = (first.getDay() + 6) % 7;
    const days = new Date(year, month, 0).getDate();
    const cells = [];

    for (let i = 0; i < offset; i++) cells.push('<div class="cal-day blank" aria-hidden="true"></div>');
    for (let d = 1; d <= days; d++) {
      const iso = `${year}-${pad2(month)}-${pad2(d)}`;
      const rows = byDate.get(iso) || [];
      let sum = 0;
      let numericCount = 0;
      for (const t of rows) {
        if (numeric(t.rr)) { sum += t.rr; numericCount += 1; }
      }
      let cls = '';
      let rrText = '';
      if (rows.length) {
        cls = sum > 0 ? 'pos' : sum < 0 ? 'neg' : 'zero';
        rrText = numericCount ? moneyR(sum) : '0.00R';
      }
      const countText = rows.length ? `${rows.length} record${rows.length === 1 ? '' : 's'}` : '';
      const title = rows.length
        ? `${dateNice(iso)} — ${rrText} · ${countText}. Click to add another trade.`
        : `${dateNice(iso)} — no trades. Click to add one.`;
      cells.push(`<button type="button" class="cal-day ${cls}" data-date="${iso}" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}">
        <span class="cal-num">${d}</span>
        ${rows.length ? `<span class="cal-r">${escapeHtml(rrText)}</span><span class="cal-count">${escapeHtml(countText)}</span>` : ''}
      </button>`);
    }
    while (cells.length % 7 !== 0) cells.push('<div class="cal-day blank" aria-hidden="true"></div>');
    els.calGrid.innerHTML = cells.join('');

    els.calEmpty.hidden = monthData.length > 0;
    if (!monthData.length) {
      els.calEmpty.innerHTML = state.trades.length
        ? `<strong>No trades in ${escapeHtml(monthLabel(state.calMonth))} with these filters.</strong>Click any day above to add a trade on that date.`
        : `<strong>Nothing recorded in ${escapeHtml(monthLabel(state.calMonth))}.</strong>Click any day above to add your first trade, or import a workbook.`;
    }

    const scored = monthData.filter((t) => t.status === 'TP' || t.status === 'SL');
    const net = monthData.filter((t) => numeric(t.rr)).reduce((sum, t) => sum + t.rr, 0);
    const tp = monthData.filter((t) => t.status === 'TP').length;
    const sl = monthData.filter((t) => t.status === 'SL').length;
    els.calStats.innerHTML = `
      <div class="mini"><strong>${scored.length}</strong><span>TP + SL</span></div>
      <div class="mini"><strong class="${net > 0 ? 'up' : net < 0 ? 'down' : ''}">${monthData.some((t) => numeric(t.rr)) ? moneyR(net) : '—'}</strong><span>Recorded net R</span></div>
      <div class="mini"><strong>${tp}</strong><span>Take profits</span></div>
      <div class="mini"><strong>${sl}</strong><span>Stop losses</span></div>`;
  }

  // ---------------------------------------------------------------- trade modal
  let editingId = null;
  let currentShot = '';
  let pendingFile = null;
  let previewToken = 0;
  let rrAutoStatus = null;
  let manualRR = '';
  let saving = false;

  function setOutcomeSelect(status) {
    Array.from(els.fOutcome.querySelectorAll('option[data-custom]')).forEach((o) => o.remove());
    const value = status || '';
    if (value && !['', 'TP', 'SL', 'BE', 'NO TRADE'].includes(value)) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = value;
      opt.dataset.custom = 'true';
      els.fOutcome.appendChild(opt);
    }
    els.fOutcome.value = value;
  }

  function updateDayPreview() {
    els.fDay.textContent = els.fDate.value ? `${weekday(els.fDate.value)} · auto` : 'Select a date';
  }

  function applyOutcomeRules({ capture = true } = {}) {
    const status = normalizeStatus(els.fOutcome.value);
    if (status === 'SL' || status === 'BE') {
      if (capture && !rrAutoStatus) manualRR = els.fRR.value;
      els.fRR.value = status === 'SL' ? '-1' : '0';
      els.fRR.readOnly = true;
      els.fRR.classList.add('locked');
      els.fRRHint.textContent = status === 'SL' ? 'auto · -1R' : 'auto · 0R';
      rrAutoStatus = status;
    } else {
      if (rrAutoStatus) {
        els.fRR.value = manualRR;
        rrAutoStatus = null;
      }
      els.fRR.readOnly = false;
      els.fRR.classList.remove('locked');
      els.fRRHint.textContent = '';
    }
  }

  function showShotPreview(url, label) {
    const img = els.fShotPreview.querySelector('img');
    img.src = url;
    els.fShotPreviewLabel.textContent = label;
    els.fShotPreview.hidden = false;
  }

  async function refreshShotPreview() {
    const token = ++previewToken;
    els.fShotRemove.classList.add('hidden');
    if (pendingFile) {
      if (pendingPreviewUrl) URL.revokeObjectURL(pendingPreviewUrl);
      pendingPreviewUrl = URL.createObjectURL(pendingFile);
      showShotPreview(pendingPreviewUrl, pendingFile.name);
      els.fShotRemove.classList.remove('hidden');
      return;
    }
    if (currentShot) {
      const url = await resolveShot(currentShot);
      if (token !== previewToken) return;
      if (url) {
        showShotPreview(url, currentShot.startsWith('img:') ? 'Uploaded image' : currentShot);
        els.fShotRemove.classList.remove('hidden');
        return;
      }
    }
    els.fShotPreview.hidden = true;
  }

  function openTradeModal(options = {}) {
    const trade = options.trade || null;
    editingId = trade ? trade.id : null;
    pendingFile = null;
    if (pendingPreviewUrl) { URL.revokeObjectURL(pendingPreviewUrl); pendingPreviewUrl = null; }
    currentShot = trade ? trade.screenshot || '' : '';

    els.tradeModalTitle.textContent = trade ? 'Edit trade' : 'Add trade';
    els.tradeModalEyebrow.textContent = trade ? `Journal entry #${trade.id}` : 'Journal entry';
    els.tradeId.value = trade ? trade.id : '';
    els.fDate.value = trade ? trade.date : (options.date || todayISO());
    setOutcomeSelect(trade ? trade.status : '');
    els.fRR.value = trade && numeric(trade.rr) ? trade.rr : '';
    const initialStatus = normalizeStatus(els.fOutcome.value);
    manualRR = (initialStatus === 'SL' || initialStatus === 'BE') ? '' : els.fRR.value;
    rrAutoStatus = null;
    applyOutcomeRules({ capture: false });
    els.fMaxRR.value = trade && numeric(trade.maxRR) ? trade.maxRR : '';
    els.fTime.value = trade && trade.time ? trade.time : '';
    els.fNote.value = trade ? trade.note || '' : '';
    els.fShotUrl.value = trade && trade.screenshot && !trade.screenshot.startsWith('img:') && !trade.screenshot.startsWith('data:') ? trade.screenshot : '';
    els.fShotFile.value = '';
    els.fShotName.textContent = 'No file chosen';
    els.fShotRemove.classList.add('hidden');
    els.tradeDelete.classList.toggle('hidden', !trade);
    els.tradeSave.textContent = trade ? 'Save changes' : 'Save trade';
    updateDayPreview();
    refreshShotPreview();

    els.tradeModal.hidden = false;
    document.body.classList.add('no-scroll');
    setTimeout(() => els.fDate.focus(), 30);
  }

  function closeTradeModal() {
    els.tradeModal.hidden = true;
    document.body.classList.remove('no-scroll');
    editingId = null;
    pendingFile = null;
    if (pendingPreviewUrl) { URL.revokeObjectURL(pendingPreviewUrl); pendingPreviewUrl = null; }
    els.fShotFile.value = '';
  }

  function resetTradeFormForNext(savedDate) {
    const nextDate = els.autoNextDay.checked ? addDaysISO(savedDate, 1) : savedDate;
    editingId = null;
    currentShot = '';
    pendingFile = null;
    if (pendingPreviewUrl) { URL.revokeObjectURL(pendingPreviewUrl); pendingPreviewUrl = null; }
    els.tradeId.value = '';
    els.fDate.value = nextDate;
    setOutcomeSelect('');
    els.fRR.value = '';
    manualRR = '';
    rrAutoStatus = null;
    applyOutcomeRules({ capture: false });
    els.fMaxRR.value = '';
    els.fTime.value = '';
    els.fNote.value = '';
    els.fShotUrl.value = '';
    els.fShotFile.value = '';
    els.fShotName.textContent = 'No file chosen';
    els.fShotRemove.classList.add('hidden');
    els.fShotPreview.hidden = true;
    els.tradeModalTitle.textContent = 'Add trade';
    els.tradeModalEyebrow.textContent = 'Journal entry';
    els.tradeDelete.classList.add('hidden');
    els.tradeSave.textContent = 'Save trade';
    updateDayPreview();
    refreshShotPreview();
    els.tradeModal.scrollTop = 0;
    setTimeout(() => {
      if (els.autoNextDay.checked) els.fOutcome.focus();
      else els.fDate.focus();
    }, 30);
    return nextDate;
  }

  function nextTradeId() {
    return state.trades.reduce((max, t) => Math.max(max, Number(t.id) || 0), 0) + 1;
  }

  async function saveTrade(event) {
    event.preventDefault();
    if (saving) return;
    const date = parseDateValue(els.fDate.value);
    if (!date) { toast('Choose a valid date for the trade.', true); els.fDate.focus(); return; }

    const existing = editingId !== null ? state.trades.find((t) => t.id === editingId) : null;
    let shot = currentShot;
    if (pendingFile) {
      saving = true;
      els.tradeSave.disabled = true;
      try {
        shot = await storeUploadedImage(pendingFile);
      } catch (err) {
        toast(err.message || 'Could not save the image.', true);
        return;
      } finally {
        saving = false;
        els.tradeSave.disabled = false;
      }
    } else {
      const rawUrl = els.fShotUrl.value.trim();
      if (rawUrl) {
        const parsed = parseShot(rawUrl);
        if (!parsed) { toast('Enter a valid http(s) screenshot URL.', true); els.fShotUrl.focus(); return; }
        shot = parsed;
      } else {
        shot = '';
      }
    }

    const status = normalizeStatus(els.fOutcome.value);
    const trade = {
      id: existing ? existing.id : nextTradeId(),
      date,
      day: weekday(date),
      status,
      rr: status === 'SL' ? -1 : status === 'BE' ? 0 : numOrNull(els.fRR.value),
      maxRR: numOrNull(els.fMaxRR.value),
      time: els.fTime.value || null,
      screenshot: shot,
      note: els.fNote.value.trim(),
      sheet: existing ? existing.sheet || 'Manual' : 'Manual',
      excelRow: existing ? existing.excelRow : null
    };

    if (existing) {
      state.trades = state.trades.map((t) => t.id === existing.id ? trade : t);
    } else {
      state.trades.push(trade);
    }
    state.trades.sort(chrono);

    if (existing && existing.screenshot && existing.screenshot !== shot) {
      dropImageRef(existing.screenshot);
    }

    persist();
    populateFilters();
    state.logPage = 0;
    state.galleryPage = 0;
    render();
    if (els.tradeModal.hidden) {
      toast(existing ? 'Trade updated.' : 'Trade added.');
      return;
    }
    const nextDate = resetTradeFormForNext(date);
    if (els.autoNextDay.checked) {
      toast(`${existing ? 'Trade updated' : 'Trade added'}. Next entry: ${dateNice(nextDate)}.`);
    } else {
      toast(`${existing ? 'Trade updated' : 'Trade added'}. Ready for another entry.`);
    }
  }

  function deleteTradeById(id) {
    const trade = state.trades.find((t) => t.id === Number(id));
    if (!trade) return;
    if (!confirm(`Delete the trade from ${dateNice(trade.date)}? This cannot be undone.`)) return;
    state.trades = state.trades.filter((t) => t.id !== trade.id);
    if (trade.screenshot) dropImageRef(trade.screenshot);
    persist();
    populateFilters();
    render();
    toast('Trade deleted.');
  }

  // ---------------------------------------------------------------- lightbox
  let lightboxSeq = 0;

  function openLightbox(items, index) {
    if (!items.length) return;
    state.lightbox.items = items.slice();
    state.lightbox.index = Math.max(0, Math.min(index, items.length - 1));
    els.lightbox.hidden = false;
    document.body.classList.add('no-scroll');
    els.lightbox.focus?.();
    showLightboxItem();
  }

  function closeLightbox() {
    els.lightbox.hidden = true;
    els.lbImg.removeAttribute('src');
    state.lightbox.items = [];
    document.body.classList.remove('no-scroll');
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
  }

  async function showLightboxItem() {
    const items = state.lightbox.items;
    const trade = items[state.lightbox.index];
    if (!trade) return;
    const seq = ++lightboxSeq;
    els.lbTitle.textContent = `${dateNice(trade.date)} · ${outcomeLabel(trade)}`;
    els.lbSub.textContent = `Realized RR: ${moneyR(trade.rr)} · Max RR: ${numeric(trade.maxRR) ? plainR(trade.maxRR) : '—'} · ${state.lightbox.index + 1}/${items.length}`;
    const isExternal = /^https?:\/\//i.test(trade.screenshot);
    els.lbSource.hidden = !isExternal;
    if (isExternal) els.lbSource.href = trade.screenshot;
    els.lbPrev.hidden = items.length < 2;
    els.lbNext.hidden = items.length < 2;

    els.lbImg.hidden = false;
    els.lbFallback.hidden = true;
    els.lbImg.removeAttribute('src');
    const url = await resolveShot(trade.screenshot);
    if (seq !== lightboxSeq) return;
    if (!url) {
      els.lbImg.hidden = true;
      els.lbFallback.hidden = false;
      return;
    }
    els.lbImg.src = url;
  }

  function moveLightbox(delta) {
    const items = state.lightbox.items;
    if (!items.length) return;
    state.lightbox.index = (state.lightbox.index + delta + items.length) % items.length;
    showLightboxItem();
  }

  function openShotById(id) {
    const items = shotItems(filtered());
    const index = items.findIndex((t) => t.id === Number(id));
    if (index >= 0) openLightbox(items, index);
  }

  // ---------------------------------------------------------------- import / export
  let xlsxPromise = null;

  function ensureXLSX() {
    if (window.XLSX) return Promise.resolve();
    if (xlsxPromise) return xlsxPromise;
    xlsxPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'assets/xlsx.full.min.js';
      script.onload = () => window.XLSX ? resolve() : reject(new Error('Excel parser did not initialize.'));
      script.onerror = () => {
        xlsxPromise = null;
        reject(new Error('Could not load assets/xlsx.full.min.js. Keep the assets folder next to index.html.'));
      };
      document.head.appendChild(script);
    });
    return xlsxPromise;
  }

  const normHeader = (v) => String(v ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');

  function cellHyperlink(sheet, r, c) {
    if (!sheet || c < 0) return '';
    const address = XLSX.utils.encode_cell({ r, c });
    const cell = sheet[address];
    return cell && cell.l && typeof cell.l.Target === 'string' ? cell.l.Target : '';
  }

  function extractWorkbook(workbook) {
    const out = [];
    for (const name of workbook.SheetNames) {
      const sheet = workbook.Sheets[name];
      if (!sheet) continue;
      const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null });
      const headerIndex = matrix.findIndex((row) => Array.isArray(row) &&
        row.some((cell) => normHeader(cell) === 'date') &&
        row.some((cell) => ['rr', 'maxrr'].includes(normHeader(cell))));
      if (headerIndex < 0) continue;

      const headers = matrix[headerIndex].map(normHeader);
      const idx = (...names) => {
        for (const name of names) {
          const found = headers.indexOf(name);
          if (found >= 0) return found;
        }
        return -1;
      };
      const cols = {
        date: idx('date'),
        day: idx('day', 'weekday'),
        status: idx('tpsl', 'status', 'outcome', 'result'),
        rr: idx('rr'),
        maxRR: idx('maxrr', 'maximumrr'),
        shot: idx('screenshot', 'image', 'screenshotlink', 'link', 'imageurl', 'screenshoturl'),
        time: idx('time', 'entrytime'),
        note: idx('note', 'notes', 'comment', 'comments')
      };

      for (let r = headerIndex + 1; r < matrix.length; r++) {
        const row = matrix[r];
        if (!Array.isArray(row)) continue;
        const date = parseDateValue(cols.date >= 0 ? row[cols.date] : null);
        if (!date) continue;
        const shotValue = cols.shot >= 0 ? row[cols.shot] : '';
        const shot = parseShot(shotValue) || parseShot(cellHyperlink(sheet, r, cols.shot));
        out.push({
          id: out.length + 1,
          date,
          day: cols.day >= 0 && row[cols.day] ? String(row[cols.day]).trim() : weekday(date),
          status: cols.status >= 0 ? normalizeStatus(row[cols.status]) : '',
          rr: cols.rr >= 0 ? numOrNull(row[cols.rr]) : null,
          maxRR: cols.maxRR >= 0 ? numOrNull(row[cols.maxRR]) : null,
          time: cols.time >= 0 ? normalizeTime(row[cols.time]) : null,
          screenshot: shot,
          note: cols.note >= 0 ? String(row[cols.note] ?? '').trim() : '',
          sheet: name,
          excelRow: r + 1
        });
      }
    }
    return out;
  }

  async function importFile(file) {
    if (!file) return;
    if (state.trades.length && !confirm(`Importing "${file.name}" will replace all ${state.trades.length} current rows. Download a backup first if you need it.\n\nContinue?`)) {
      els.fileInput.value = '';
      return;
    }
    toast('Reading workbook…');
    try {
      await ensureXLSX();
      let workbook;
      if (/\.csv$/i.test(file.name)) {
        const text = await file.text();
        workbook = XLSX.read(text, { type: 'string', raw: true });
      } else {
        const buffer = await file.arrayBuffer();
        workbook = XLSX.read(buffer, { type: 'array', cellDates: false });
      }
      const trades = extractWorkbook(workbook);
      if (!trades.length) {
        throw new Error('No dated rows found. A sheet needs a Date column plus an RR or Max RR header.');
      }
      state.trades = trades.sort(chrono);
      state.meta = { importedFile: file.name, importedAt: todayISO() };
      state.calMonth = null;
      state.logPage = 0;
      state.galleryPage = 0;
      resetFilterControls();
      await imgClear();
      populateFilters();
      persist();
      render();
      toast(`Imported ${trades.length} dated rows from ${workbook.SheetNames.length} sheet${workbook.SheetNames.length === 1 ? '' : 's'}.`);
    } catch (err) {
      console.error(err);
      toast(`Import failed: ${err.message || err}`, true);
    } finally {
      els.fileInput.value = '';
    }
  }

  function csvCell(value) {
    const s = String(value ?? '');
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function exportCsv() {
    const rows = [['Date', 'Day', 'Outcome', 'RR', 'Max RR', 'Time', 'Screenshot', 'Note']];
    state.trades.slice().sort(chrono).forEach((t) => {
      rows.push([
        t.date,
        t.day || weekday(t.date),
        outcomeLabel(t),
        numeric(t.rr) ? t.rr : '',
        numeric(t.maxRR) ? t.maxRR : '',
        t.time || '',
        t.screenshot.startsWith('img:') ? '(uploaded image)' : t.screenshot,
        t.note || ''
      ]);
    });
    download('\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n'),
      `r-ledger-trades-${todayISO()}.csv`, 'text/csv;charset=utf-8');
    toast('CSV exported.');
  }

  function downloadTemplate() {
    const rows = [
      ['Date', 'Day', 'Outcome', 'RR', 'Max RR', 'Time', 'Screenshot', 'Note'],
      ['2026-01-05', 'Monday', 'TP', '3.00', '6.00', '08:30', 'https://example.com/chart.png', 'Optional note']
    ];
    download(rows.map((row) => row.map(csvCell).join(',')).join('\r\n'),
      'r-ledger-import-template.csv', 'text/csv;charset=utf-8');
    toast('Template downloaded. Replace the example row with your trades.');
  }

  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error || new Error('Could not read image'));
      reader.readAsDataURL(blob);
    });
  }

  async function backupJson() {
    try {
      toast('Preparing backup…');
      const trades = [];
      for (const t of state.trades) {
        let shot = t.screenshot;
        if (shot.startsWith('img:')) {
          const blob = await imgGet(shot.slice(4));
          if (blob) shot = await blobToDataURL(blob);
        }
        trades.push({ ...t, screenshot: shot });
      }
      const payload = {
        app: 'R Ledger local journal',
        version: 1,
        exportedAt: new Date().toISOString(),
        meta: state.meta,
        trades: trades.slice().sort(chrono)
      };
      download(JSON.stringify(payload, null, 2), `r-ledger-backup-${todayISO()}.json`, 'application/json');
      toast('Backup downloaded.');
    } catch (err) {
      console.error(err);
      toast(`Backup failed: ${err.message || err}`, true);
    }
  }

  async function restoreBackup(file) {
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const rawTrades = Array.isArray(parsed) ? parsed : parsed.trades;
      if (!Array.isArray(rawTrades)) throw new Error('This file does not look like a journal backup.');
      if (state.trades.length && !confirm(`Restoring this backup will replace all ${state.trades.length} current rows.\n\nContinue?`)) {
        els.restoreInput.value = '';
        return;
      }

      const restored = [];
      for (const raw of rawTrades) {
        const trade = normalizeTrade(raw);
        if (!trade) continue;
        if (trade.screenshot.startsWith('data:image/')) {
          try {
            const key = `img_${Date.now()}_${restored.length}_${Math.random().toString(36).slice(2, 7)}`;
            const response = await fetch(trade.screenshot);
            const blob = await response.blob();
            await imgPut(key, blob);
            trade.screenshot = `img:${key}`;
          } catch (err) {
            console.warn('Could not move embedded image into local storage; keeping it embedded.', err);
          }
        }
        restored.push(trade);
      }
      if (!restored.length) throw new Error('No valid trades found in the backup.');

      let nextId = 1;
      for (const t of restored) {
        if (!t.id) t.id = nextId++;
        else nextId = Math.max(nextId, t.id + 1);
      }
      state.trades = restored.sort(chrono);
      state.meta = parsed.meta && typeof parsed.meta === 'object'
        ? {
            importedFile: String(parsed.meta.importedFile || ''),
            importedAt: parseDateValue(parsed.meta.importedAt) || todayISO()
          }
        : { importedFile: file.name, importedAt: todayISO() };
      state.calMonth = null;
      state.logPage = 0;
      state.galleryPage = 0;
      resetFilterControls();
      populateFilters();
      persist();
      render();
      toast(`Restored ${restored.length} trades from backup.`);
    } catch (err) {
      console.error(err);
      toast(`Restore failed: ${err.message || err}`, true);
    } finally {
      els.restoreInput.value = '';
    }
  }

  // ---------------------------------------------------------------- events
  function bindEvents() {
    document.querySelectorAll('.navbtn').forEach((btn) => {
      btn.addEventListener('click', () => showPage(btn.dataset.page));
    });

    els.addBtn.addEventListener('click', () => openTradeModal());
    els.viewAll.addEventListener('click', () => showPage('trades'));

    els.year.addEventListener('change', () => {
      populateMonths('all');
      state.logPage = 0;
      state.galleryPage = 0;
      render();
    });
    [els.month, els.status, els.includeBlanks].forEach((el) => {
      el.addEventListener('change', () => {
        state.logPage = 0;
        state.galleryPage = 0;
        render();
      });
    });
    els.search.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.logPage = 0;
        state.galleryPage = 0;
        render();
      }, 120);
    });

    els.calMonth.addEventListener('change', () => {
      state.calMonth = els.calMonth.value;
      renderCalendar(filtered());
    });
    els.calPrev.addEventListener('click', () => {
      state.calMonth = shiftMonth(state.calMonth, -1);
      renderCalendar(filtered());
    });
    els.calNext.addEventListener('click', () => {
      state.calMonth = shiftMonth(state.calMonth, 1);
      renderCalendar(filtered());
    });

    els.importBtn.addEventListener('click', () => els.fileInput.click());
    els.fileInput.addEventListener('change', (e) => importFile(e.target.files[0]));

    els.resetBtn.addEventListener('click', async () => {
      if (!state.trades.length) { toast('There is no data to reset.'); return; }
      if (!confirm(`Delete all ${state.trades.length} dated rows, notes and screenshots from this browser?\n\nThis cannot be undone.`)) return;
      state.trades = [];
      state.meta = { importedFile: '', importedAt: null };
      state.calMonth = null;
      state.logPage = 0;
      state.galleryPage = 0;
      resetFilterControls();
      await imgClear();
      persist();
      populateFilters();
      render();
      toast('All journal data cleared.');
    });

    // trade modal
    els.tradeForm.addEventListener('submit', saveTrade);
    document.querySelectorAll('[data-close-trade]').forEach((btn) => btn.addEventListener('click', closeTradeModal));
    els.tradeModal.addEventListener('mousedown', (e) => { if (e.target === els.tradeModal) closeTradeModal(); });
    els.fDate.addEventListener('change', updateDayPreview);
    els.nextDayBtn.addEventListener('click', () => {
      const current = parseDateValue(els.fDate.value);
      els.fDate.value = current ? addDaysISO(current, 1) : todayISO();
      updateDayPreview();
      els.fDate.focus();
    });
    els.autoNextDay.addEventListener('change', () => {
      try { localStorage.setItem(AUTO_NEXT_KEY, els.autoNextDay.checked ? '1' : '0'); } catch (err) {}
    });
    els.fOutcome.addEventListener('change', () => applyOutcomeRules());
    els.fRR.addEventListener('input', () => { if (!rrAutoStatus) manualRR = els.fRR.value; });
    els.fShotPick.addEventListener('click', () => els.fShotFile.click());
    els.fShotFile.addEventListener('change', () => {
      const file = els.fShotFile.files[0] || null;
      pendingFile = file;
      els.fShotName.textContent = file ? file.name : 'No file chosen';
      refreshShotPreview();
    });
    els.fShotRemove.addEventListener('click', () => {
      pendingFile = null;
      currentShot = '';
      els.fShotFile.value = '';
      els.fShotUrl.value = '';
      els.fShotName.textContent = 'No file chosen';
      if (pendingPreviewUrl) { URL.revokeObjectURL(pendingPreviewUrl); pendingPreviewUrl = null; }
      els.fShotPreview.hidden = true;
      els.fShotRemove.classList.add('hidden');
    });
    els.tradeDelete.addEventListener('click', () => {
      if (editingId === null) return;
      const id = editingId;
      closeTradeModal();
      deleteTradeById(id);
    });

    // data modal
    els.exportBtn.addEventListener('click', () => {
      els.dataModal.hidden = false;
      document.body.classList.add('no-scroll');
    });
    document.querySelectorAll('[data-close-data]').forEach((btn) => btn.addEventListener('click', () => {
      els.dataModal.hidden = true;
      document.body.classList.remove('no-scroll');
    }));
    els.dataModal.addEventListener('mousedown', (e) => {
      if (e.target === els.dataModal) {
        els.dataModal.hidden = true;
        document.body.classList.remove('no-scroll');
      }
    });
    els.exportCsv.addEventListener('click', () => { exportCsv(); els.dataModal.hidden = true; document.body.classList.remove('no-scroll'); });
    els.backupJson.addEventListener('click', () => { backupJson(); });
    els.restoreJson.addEventListener('click', () => els.restoreInput.click());
    els.downloadTemplate.addEventListener('click', downloadTemplate);
    els.restoreInput.addEventListener('change', (e) => restoreBackup(e.target.files[0]));

    // lightbox
    els.lbClose.addEventListener('click', closeLightbox);
    els.lbPrev.addEventListener('click', () => moveLightbox(-1));
    els.lbNext.addEventListener('click', () => moveLightbox(1));
    els.lbFull.addEventListener('click', () => {
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      } else if (els.lightbox.requestFullscreen) {
        els.lightbox.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
      }
    });
    els.lbImg.addEventListener('error', () => {
      els.lbImg.hidden = true;
      els.lbFallback.hidden = false;
    });
    els.lbImg.addEventListener('load', () => {
      els.lbFallback.hidden = true;
      els.lbImg.hidden = false;
    });
    els.lightbox.addEventListener('mousedown', (e) => {
      if (e.target === els.lightbox || e.target === els.lbImg || e.target.classList.contains('lb-stage')) {
        if (e.target !== els.lbImg) closeLightbox();
      }
    });

    // delegation
    document.addEventListener('click', (e) => {
      const add = e.target.closest('[data-open-add]');
      if (add) { openTradeModal(); return; }

      const shotBtn = e.target.closest('[data-shot]');
      if (shotBtn) { openShotById(shotBtn.dataset.shot); return; }

      const shotCard = e.target.closest('[data-shot-open]');
      if (shotCard) {
        const items = shotItems(filtered());
        const index = items.findIndex((t) => t.id === Number(shotCard.dataset.shotOpen));
        if (index >= 0) openLightbox(items, index);
        return;
      }

      const edit = e.target.closest('[data-edit]');
      if (edit) {
        const trade = state.trades.find((t) => t.id === Number(edit.dataset.edit));
        if (trade) openTradeModal({ trade });
        return;
      }

      const del = e.target.closest('[data-del]');
      if (del) { deleteTradeById(del.dataset.del); return; }

      const day = e.target.closest('.cal-day[data-date]');
      if (day) { openTradeModal({ date: day.dataset.date }); return; }
    });

    document.addEventListener('keydown', (e) => {
      if (!els.lightbox.hidden) {
        if (e.key === 'Escape') { e.preventDefault(); closeLightbox(); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); moveLightbox(-1); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); moveLightbox(1); }
        return;
      }
      if (e.key === 'Escape') {
        if (!els.tradeModal.hidden) { closeTradeModal(); return; }
        if (!els.dataModal.hidden) {
          els.dataModal.hidden = true;
          document.body.classList.remove('no-scroll');
        }
      }
    });

    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (state.page === 'overview') render();
      }, 160);
    });
  }

  // ---------------------------------------------------------------- init
  function init() {
    [
      'pageTitle', 'pageSubtitle', 'sourceInfo', 'resetBtn', 'exportBtn', 'importBtn', 'addBtn',
      'year', 'month', 'status', 'search', 'includeBlanks', 'kpis', 'equityWrap', 'outcomeBreakdown',
      'extraStats', 'monthlyChart', 'scatterWrap', 'recentRows', 'recentEmpty', 'viewAll', 'logCount',
      'logRows', 'logEmpty', 'logPager', 'galleryCount', 'galleryGrid', 'galleryEmpty', 'galleryPager',
      'calMonthLabel', 'calPrev', 'calMonth', 'calNext', 'calGrid', 'calEmpty', 'calStats', 'tradeModal',
      'tradeModalEyebrow', 'tradeModalTitle', 'tradeForm', 'tradeId', 'fDate', 'fOutcome', 'fRR', 'fMaxRR',
      'fTime', 'fDay', 'nextDayBtn', 'autoNextDay', 'fRRHint', 'fShotUrl', 'fShotFile', 'fShotPick', 'fShotName', 'fShotRemove', 'fShotPreview',
      'fShotPreviewLabel', 'fNote', 'tradeDelete', 'tradeSave', 'dataModal', 'exportCsv', 'backupJson',
      'restoreJson', 'downloadTemplate', 'lightbox', 'lbTitle', 'lbSub', 'lbSource', 'lbFull', 'lbClose',
      'lbPrev', 'lbImg', 'lbFallback', 'lbNext', 'fileInput', 'restoreInput', 'toast', 'sideCount'
    ].forEach((id) => { els[id] = $(id); });

    try {
      const autoPref = localStorage.getItem(AUTO_NEXT_KEY);
      if (autoPref !== null) els.autoNextDay.checked = autoPref === '1';
    } catch (err) {}

    loadState();
    populateFilters();
    bindEvents();
    render();
    const initial = location.hash.replace('#', '');
    if (PAGES[initial]) showPage(initial, false);
    window.addEventListener('hashchange', () => {
      const page = location.hash.replace('#', '');
      if (PAGES[page]) showPage(page, false);
    });
  }

  init();
})();
