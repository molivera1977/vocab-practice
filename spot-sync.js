/* ═══════════════════════════════════════════════════════
   spot-sync.js — PICK UP ON ANY COMPUTER. The SAME file on every site (like form-label.js): change it in one
   site, copy it to all. Marcos 11/12/2026: "i want the kids to have the same experience that they have at home
   to be like they were logging on at school."

   A site keeps a student's unfinished work on the computer under its STORAGE_KEY, and shows "Welcome back!
   ↩️ Resume Where I Left Off" for it. This file:
   1. sends a copy of that save to the sheet ('_spots' tab, ONE per student per site) each time the student
      moves on (a new question or card), at most one send at a time, the newest copy; and when the page closes;
   2. when the save is removed (finished, discarded with the PIN, a new try started), tells the sheet that try
      is over — kept on this computer and sent again until the sheet has it — so another computer drops its old
      copy; a save of that try still waiting to go is never sent;
   3. at sign-in — SpotSync.restore(name), BEFORE the site's checkResume — asks the sheet for that student's
      copy and puts it on this computer when it is further along than this computer's (the same try: more
      questions answered; another try: saved later). The site's own resume card then shows it. A copy that is
      past its last question is never brought back (its finish may already be counted).
   If another student's unfinished work is on this computer and would be replaced, it goes to the sheet first.
   If the sheet gave no answer at sign-in, this student's saves never replace ANOTHER unfinished try on the sheet.
   Nothing is sent for a guest, the teacher, the share link or Teacher Review Mode (cfg.skip).
   Nothing in the site's save changes: this file watches localStorage.setItem / removeItem for that one key.

   SpotSync.init({ site, key, url, who, skip, usable, attemptOf, progOf, app, perStudent })
     site — the site's name on the sheet ('inference-practice'); key — its STORAGE_KEY; url — SHEET_URL;
     perStudent — true when the site keeps one save PER STUDENT under STORAGE_KEY + ':' + name (the unit tests);
     who() — the student signed in now; skip() — true = send nothing now (share link, review mode);
     usable(save) — can this site still open that save (optional); attemptOf / progOf — optional (defaults below);
     app — optional: the site's app; its checkResume then waits for the sheet once per sign-in (the menu held,
       a note shown) — for sites whose sign-in does not call restore() itself.
   SpotSync.restore(name) → Promise of 'sheet' (the sheet's copy is on this computer now) | 'device' (this
     computer's is further along) | 'ended' (that try was finished or discarded elsewhere: removed here) |
     'none' | 'offline' (no answer in WAIT_MS) | 'skip' | 'stale' (someone else signed in meanwhile). Never rejects.
═══════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.SpotSync) return;

  const WAIT_MS = 15000;    // the sheet's answer at sign-in (science 11/11: 22 at once took 9.6–10.9 s)
  const SEND_MS = 20000;    // any other send gives up after this (it is tried again)
  const IDLE_MS = 60000;    // the same spot (only the clock moved) goes again at most once a minute
  const RETRY_MS = 15000;   // a send that failed is tried again after this
  const BEACON_MAX = 60000; // a page that is closing can send this much (keepalive)

  let cfg = null;
  let quiet = 0;            // > 0 while this file itself writes the key (no echo to the sheet)
  let pending = null, inFlight = false, timer = null, lastKey = '', lastAt = 0, failedAt = 0;
  const ended = new Set();       // name|attempt this page saw end: never sent again
  const unsure = new Set();      // names whose sign-in got no answer from the sheet (saves go with ifSame)

  const LS = (() => { try { return window.localStorage; } catch (e) { return null; } })();
  const proto = window.Storage && Storage.prototype;
  const rawGet = k => { try { return LS ? proto.getItem.call(LS, k) : null; } catch (e) { return null; } };
  let rawSet = (k, v) => { try { LS.setItem(k, v); } catch (e) { /* full or blocked */ } };
  let rawRemove = k => { try { LS.removeItem(k); } catch (e) { /* blocked */ } };

  const parse = s => { try { const v = s && JSON.parse(s); return v && typeof v === 'object' ? v : null; } catch (e) { return null; } };
  const skipName = n => !n || n === 'Guest' || /\((Guest|Teacher)\)$/.test(String(n));
  const skipNow = () => !cfg || (cfg.skip && cfg.skip());
  // One try = where it started + which part + which try + WHEN it started (a try begun again after a discard is new)
  const attemptOf = s => (cfg.attemptOf ? cfg.attemptOf(s)
    : [s.sessionBase || 'x', s.currentSection || s.currentForm || 'x', s.level || 1, s.version || 1, s.currentAttemptNum || 1, s.startedAt || ''].join('|'));
  const progOf = s => (cfg.progOf ? cfg.progOf(s)
    : (Number(s.currentIndex) || 0) * 1000 + (Array.isArray(s.cardsSeen) ? s.cardsSeen.length : 0));
  const pastLast = s => Array.isArray(s.currentBank) && Number(s.currentIndex) >= s.currentBank.length;
  const endKey = (name, attempt) => name + '|' + attempt;

  // The site's save for a student: one key (most sites) or one per student (perStudent: STORAGE_KEY + ':' + name)
  const keyFor = name => (cfg.perStudent ? cfg.key + ':' + name : cfg.key);
  const watched = k => k === cfg.key || (!!cfg.perStudent && typeof k === 'string' && k.indexOf(cfg.key + ':') === 0);
  // { name, attempt, prog, t (this computer's clock when saved), sent (prog the sheet has) } for the save under key k
  const metaKey = k => 'spotsync:' + k;
  const clearsKey = () => 'spotsync-clears:' + cfg.key;   // tries this computer saw end, not yet on the sheet
  const readMeta = k => parse(rawGet(metaKey(k)));
  const writeMeta = (k, m) => { quiet++; try { if (m) rawSet(metaKey(k), JSON.stringify(m)); else rawRemove(metaKey(k)); } finally { quiet--; } };
  const metaFor = (k, s) => { const m = readMeta(k); return m && s && m.name === s.studentName && m.attempt === attemptOf(s) ? m : null; };

  function post(body, { signal, keepalive, timeoutMs } = {}) {
    const text = JSON.stringify(body);
    const ctl = !signal && typeof AbortController === 'function' ? new AbortController() : null;
    const t = ctl ? setTimeout(() => ctl.abort(), timeoutMs || SEND_MS) : null;
    return fetch(cfg.url, { method: 'POST', body: text, signal: signal || (ctl ? ctl.signal : undefined), keepalive: !!keepalive && text.length < BEACON_MAX })
      .then(r => r.json())
      .finally(() => { if (t) clearTimeout(t); });
  }
  const saveBody = (save, raw, t, extra) => ({
    action: 'spotSave', site: cfg.site, name: save.studentName, attempt: attemptOf(save), prog: progOf(save),
    t: t || 0, data: raw, ...(extra || {})
  });
  function markSent(body) {
    const k = keyFor(body.name), m = readMeta(k);
    if (m && m.name === body.name && m.attempt === body.attempt) writeMeta(k, { ...m, sent: Math.max(m.sent == null ? -1 : m.sent, body.prog) });
  }

  /* ── 1. every save of the key → the newest copy goes to the sheet ── */
  // The sheet's answer counts (ok, or refused for good: bad data / bad name); anything else is tried again
  const answered = res => !!res && (res.ok === true || res.ok === false || /spot: bad/.test(String(res.error || '')));
  const keyOf = b => b.name + '|' + b.attempt + '|' + b.prog;
  // A new spot goes at once; the same spot (only the clock moved) once a minute; after a failed send, wait
  function delayFor(body) {
    const now = Date.now();
    if (failedAt && now - failedAt < RETRY_MS) return failedAt + RETRY_MS - now;
    return keyOf(body) !== lastKey ? 0 : Math.max(0, lastAt + IDLE_MS - now);
  }
  function schedule(ms) { clearTimeout(timer); timer = setTimeout(() => { timer = null; sendClears(); flush(false); }, ms); }
  function flush(closing) {
    if (pending && ended.has(endKey(pending.name, pending.attempt))) pending = null;
    if (!pending || (inFlight && !closing)) return;   // the send in flight schedules the next one when it ends
    const body = pending; pending = null;
    inFlight = true; lastKey = keyOf(body); lastAt = Date.now();
    post(body, { keepalive: closing })
      .then(res => {
        if (!answered(res)) throw new Error('no answer');   // the sheet was busy (a script error): try again
        failedAt = 0;
        if (res.wrote) markSent(body);                     // refused for good (bad data): not tried again
      })
      .catch(() => {
        lastKey = ''; failedAt = Date.now();
        if (!pending && !ended.has(endKey(body.name, body.attempt))) pending = body;
      })
      .finally(() => { inFlight = false; if (pending) schedule(delayFor(pending)); });
  }
  function onSaved(k, raw) {
    const save = parse(raw);
    if (!save || skipName(save.studentName) || skipNow()) return;
    if (cfg.who && cfg.who() !== save.studentName) return;   // only the signed-in student's own work goes out
    const attempt = attemptOf(save), prog = progOf(save), old = metaFor(k, save);
    writeMeta(k, { name: save.studentName, attempt, prog, t: Date.now(), sent: old ? old.sent : -1 });
    if (ended.has(endKey(save.studentName, attempt))) return;
    pending = saveBody(save, raw, Date.now(), unsure.has(save.studentName) ? { ifSame: true } : null);
    if (!inFlight) schedule(delayFor(pending));
  }

  /* ── 2. the save was removed ── */
  const readClears = () => { const v = parse(rawGet(clearsKey())); return Array.isArray(v) ? v : []; };
  const writeClears = list => { quiet++; try { if (list.length) rawSet(clearsKey(), JSON.stringify(list.slice(-20))); else rawRemove(clearsKey()); } finally { quiet--; } };
  let clearing = false;
  function sendClears() {
    const list = readClears();
    if (!list.length || clearing) return;
    clearing = true;
    const c = list[0];
    post({ action: 'spotClear', site: cfg.site, name: c.name, attempt: c.attempt, t: c.t }, { keepalive: true })
      .then(res => {
        if (!answered(res)) throw new Error('no answer');
        writeClears(readClears().filter(x => !(x.name === c.name && x.attempt === c.attempt)));
        clearing = false;
        if (readClears().length) sendClears();
      })
      .catch(() => { clearing = false; setTimeout(sendClears, RETRY_MS); });
  }
  function onRemoved(k, oldRaw) {
    const save = parse(oldRaw);
    const m = save ? metaFor(k, save) : null;
    writeMeta(k, null);
    if (!save || skipName(save.studentName) || skipNow()) return;
    const attempt = attemptOf(save);
    if (save.studentName === (cfg.who && cfg.who())) {
      // this student's try is over (finished, discarded, or a new one started) — tell the sheet, until it has it
      ended.add(endKey(save.studentName, attempt));
      if (pending && pending.name === save.studentName && pending.attempt === attempt) pending = null;
      writeClears(readClears().concat([{ name: save.studentName, attempt, t: Date.now() }]));
      sendClears();
    } else if (!(m && m.sent >= progOf(save))) {
      // another student's unfinished work is being replaced on this computer: keep it on the sheet
      post(saveBody(save, oldRaw, m ? m.t : 0, { ifNewer: true }), { keepalive: true }).catch(() => {});
    }
  }

  function hook() {
    if (!proto || proto.__spotSync) return;
    const set = proto.setItem, remove = proto.removeItem;
    rawSet = (k, v) => { try { set.call(LS, k, v); } catch (e) { /* full or blocked */ } };
    rawRemove = k => { try { remove.call(LS, k); } catch (e) { /* blocked */ } };
    proto.setItem = function (k, v) {
      const r = set.apply(this, arguments);   // a full storage throws here, like before
      if (cfg && !quiet && this === LS && watched(k)) { try { onSaved(k, String(v)); } catch (e) { /* never break the site */ } }
      return r;
    };
    proto.removeItem = function (k) {
      const watch = cfg && !quiet && this === LS && watched(k);
      const old = watch ? rawGet(k) : null;
      const r = remove.apply(this, arguments);
      if (watch && old) { try { onRemoved(k, old); } catch (e) { /* never break the site */ } }
      return r;
    };
    proto.__spotSync = true;
  }
  function closing() { if (pending) flush(true); }

  /* ── 3. at sign-in ── */
  function putHere(k, raw, m) {
    quiet++;
    try { rawSet(k, raw); } finally { quiet--; }
    writeMeta(k, m);
  }
  function dropHere(k) {
    quiet++;
    try { rawRemove(k); } finally { quiet--; }
    writeMeta(k, null);
  }
  async function decide(name, r, deadline) {
    if (cfg.who && cfg.who() !== name) return 'stale';
    const k = keyFor(name);
    const raw = rawGet(k), here = parse(raw);
    const hereName = here && here.studentName;
    const m = here ? metaFor(k, here) : null;
    const hereT = m ? m.t : 0;
    const endedHere = readClears().some(c => c.name === name && c.attempt === r.attempt);
    let sheet = null;
    if (r.found && r.state === 'open' && !endedHere) {
      sheet = parse(r.data);
      if (!sheet || sheet.studentName !== name || pastLast(sheet) || (cfg.usable && !cfg.usable(sheet))) sheet = null;
    }
    const fromSheet = { name, attempt: r.attempt, prog: r.prog, t: r.t, sent: r.prog };

    if (hereName === name) {
      const attempt = attemptOf(here), prog = progOf(here);
      if (r.found && r.state === 'done' && r.attempt === attempt) { dropHere(k); return 'ended'; }
      const sheetAhead = !!sheet && (r.attempt === attempt ? r.prog > prog : r.t > hereT);
      if (!sheetAhead) {
        // this computer's copy is the one to keep: make sure the sheet has it
        if (!(m && m.sent >= prog)) {
          const body = saveBody(here, raw, hereT, { ifNewer: true });
          post(body).then(res => { if (res && res.wrote) markSent(body); }).catch(() => {});
        }
        return 'device';
      }
      putHere(k, r.data, fromSheet);
      return 'sheet';
    }
    if (!sheet) return 'none';
    if (here && !skipName(hereName) && !(m && m.sent >= progOf(here))) {
      // another student's unfinished work is here and was never on the sheet: put it there before replacing it
      const res = await post(saveBody(here, raw, hereT, { ifNewer: true }), { timeoutMs: Math.max(3000, deadline - Date.now()) }).catch(() => null);
      if (!res || res.ok !== true) return 'device';
      if (cfg.who && cfg.who() !== name) return 'stale';
    }
    putHere(k, r.data, fromSheet);
    return 'sheet';
  }
  function restore(name) {
    if (!cfg || skipName(name) || skipNow() || typeof fetch !== 'function') return Promise.resolve('skip');
    sendClears();
    const deadline = Date.now() + WAIT_MS;
    return post({ action: 'spotGet', site: cfg.site, name }, { timeoutMs: WAIT_MS })
      .then(r => (r && r.ok === true ? decide(name, r, deadline + 5000) : 'offline'))
      .catch(() => 'offline')
      .then(result => {
        if (result === 'offline') unsure.add(name); else if (result !== 'stale') unsure.delete(name);
        return result;
      });
  }

  /* ── for a site whose sign-in does not call restore(): its checkResume waits for the sheet once per sign-in ── */
  const NOTE = '⏳ Looking for your saved work…';
  function hold(on) {
    const root = document.documentElement;
    root.classList.toggle('spot-wait', on);
    const menu = document.getElementById('section-select') || document.getElementById('form-select-section');   // the site's menu
    if (menu) { if (on) menu.setAttribute('inert', ''); else menu.removeAttribute('inert'); }
    const rc = document.getElementById('resume-container');
    if (on && rc) rc.classList.add('hidden');
    let note = document.getElementById('spot-wait-note');
    if (on && !note && menu && menu.parentNode) {
      note = document.createElement('p');
      note.id = 'spot-wait-note';
      note.className = 'spot-wait-note';
      note.textContent = NOTE;
      menu.parentNode.insertBefore(note, menu);
    }
    if (!document.getElementById('spot-wait-style')) {
      const st = document.createElement('style');
      st.id = 'spot-wait-style';
      st.textContent = '.spot-wait-note{display:none;text-align:center;font-weight:800;color:#1f3a8a;margin:6px 0 10px}' +
        'html.spot-wait .spot-wait-note{display:block}html.spot-wait #section-select,html.spot-wait #form-select-section{opacity:.5;pointer-events:none}';
      document.head.appendChild(st);
    }
  }
  function wrapCheckResume(app) {
    if (!app || typeof app.checkResume !== 'function' || app.checkResume.__spot) return;
    const original = app.checkResume;
    let asked = '', waiting = null;
    const wrapped = function () {
      const self = this, args = arguments;
      const name = cfg.who && cfg.who();
      if (!name) asked = '';                                  // signed out: the next sign-in asks again
      if (!name || skipName(name) || skipNow()) return original.apply(self, args);
      if (waiting && asked === name) { waiting.then(() => { if (cfg.who() === name) original.apply(self, args); }); return; }
      if (asked === name) return original.apply(self, args);   // already asked for this sign-in
      asked = name;
      hold(true);
      waiting = restore(name).then(() => {
        waiting = null;
        hold(false);
        if (cfg.who() === name) original.apply(self, args);
      });
    };
    wrapped.__spot = true;
    app.checkResume = wrapped;
  }

  function init(options) {
    if (cfg || !options || !options.site || !options.key || !options.url || !LS) return;
    cfg = options;
    hook();
    if (cfg.app) wrapCheckResume(cfg.app);
    window.addEventListener('pagehide', closing);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') closing(); });
    setTimeout(sendClears, 0);
  }

  window.SpotSync = { init, restore, WAIT_MS };
})();
