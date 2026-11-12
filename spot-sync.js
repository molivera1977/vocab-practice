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
   SpotSync.signIn(name) → the same wait as app's checkResume (menu held, the sheet asked once per sign-in), for a
     site whose sign-in draws its screen without checkResume (the unit tests' review gate). Never rejects.

   FINISHED WORK ON ANY COMPUTER (Marcos 11/12: "Make finished parts and unlocks follow kids across computers
   next?" → "Yes, build it"). A site also remembers what a student FINISHED only on the computer: its scores list
   (every lock, the tries left, the merry-go-round), and on some sites rounds, PIN passes, retakes, turned-in
   written parts. With cfg.records this file keeps each student's share of those on the sheet ('_records', one row
   per student per site) and merges it into this computer's lists at sign-in, in the same answer as the saved spot,
   so the locks at home are the ones the student has at school:
     records: [{ key, kind, site }] — key: the site's localStorage key; kind: 'list' (entries with .name, the
       default) | 'map' ({ name: value }) | 'names' ([name, …]); site: the sheet row it lives in (default cfg.site;
       a unit test reads its review's list).
     refresh(name) — redraws the site's locks after the merge (before its checkResume).
   A list entry is known by its fingerprint. One a computer removes (the Teacher PIN's clear, a retake) is removed
   everywhere; the same entry made again later counts again. A map value / a name in a list: the later change
   wins. Lists are never cut: what one computer has, every computer gets. Work done here goes to the sheet when it
   changes; at sign-in, what the sheet lacks goes; other students' work on this computer follows slowly
   (BACKFILL_*). The share link sends and merges nothing.
═══════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.SpotSync) return;

  const WAIT_MS = 15000;    // the sheet's answer at sign-in (science 11/11: 22 at once took 9.6–10.9 s)
  const SEND_MS = 20000;    // any other send gives up after this (it is tried again)
  const IDLE_MS = 60000;    // the same spot (only the clock moved) goes again at most once a minute
  const RETRY_MS = 15000;   // a send that failed is tried again after this
  const BEACON_MAX = 60000; // a page that is closing can send this much (keepalive)
  const BACKFILL_MS = 30000;  // other students' finished work on this computer starts going this long after a sign-in
  const BACKFILL_GAP = 4000;  // … one student at a time, this far apart
  const BACKFILL_MAX = 12;    // … at most this many per page
  const REC_TRIES = 4;        // a finished-work send that failed this many times in a row waits for the next change

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

  /* ── 4. FINISHED WORK: the site's lists of finished work ↔ the sheet ('_records') ── */
  const recList = () => (cfg && Array.isArray(cfg.records) ? cfg.records : []);
  const kindOf = st => (st.kind === 'map' || st.kind === 'names' || st.kind === 'slot' ? st.kind : 'list');
  const rowSite = st => st.site || cfg.site;
  const recSites = () => recList().map(rowSite).filter((x, i, a) => a.indexOf(x) === i);
  const storesOf = site => recList().filter(st => rowSite(st) === site);
  const storeFor = k => recList().find(st => st.key === k) || null;
  const recSkip = () => !cfg || !!window.SHARE_MODE;   // the share link keeps its own lists (share_ keys)
  const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
  // An entry's fingerprint: the same entry gives the same id on every computer, whatever the order of its fields
  function canon(v) {
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
    return JSON.stringify(v === undefined ? null : v);
  }
  function idOf(e) {
    const text = canon(e);
    let a = 0x811c9dc5, b = 0x9747b28c;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      a = Math.imul(a ^ c, 0x01000193) >>> 0;
      b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
      b = (b ^ (b >>> 15)) >>> 0;
    }
    return a.toString(36) + 'x' + b.toString(36);
  }
  // The store as it is here: a list (list, names) or an object (map)
  function storeFrom(st, raw) {
    let v = null;
    try { v = raw ? JSON.parse(raw) : null; } catch (e) { v = null; }
    if (kindOf(st) === 'map') return isObj(v) ? v : {};
    if (kindOf(st) === 'slot') return isObj(v) ? v : null;
    return Array.isArray(v) ? v : [];
  }
  const readStore = st => storeFrom(st, rawGet(st.key));
  function writeStore(st, v) {
    quiet++;
    try { if (v === null) rawRemove(st.key); else rawSet(st.key, JSON.stringify(v)); } finally { quiet--; }
  }
  function namesIn(st, v) {
    if (kindOf(st) === 'slot') return v && typeof v.name === 'string' ? [v.name] : [];
    if (kindOf(st) === 'map') return Object.keys(v);
    if (kindOf(st) === 'names') return v.filter(n => typeof n === 'string');
    return v.map(e => (e && typeof e === 'object' ? e.name : null)).filter(n => typeof n === 'string');
  }
  // One student's share: list → { id: entry }; map → the value or null; names → true or null; slot → the object or null
  function shareOf(st, v, name) {
    const kind = kindOf(st);
    if (kind === 'slot') return v && v.name === name ? v : null;
    if (kind === 'map') return Object.prototype.hasOwnProperty.call(v, name) ? v[name] : null;
    if (kind === 'names') return v.indexOf(name) >= 0 ? true : null;
    const out = {};
    v.forEach(e => { if (e && typeof e === 'object' && e.name === name) out[idOf(e)] = e; });
    return out;
  }
  // This computer's bookkeeping per store: { <name>: { s: { id: added at }, d: { id: removed at }, t: value changed at, h } }
  const recMetaKey = k => 'recsync:' + k;
  const readRecMeta = k => { const v = parse(rawGet(recMetaKey(k))); return isObj(v) ? v : {}; };
  function writeRecMeta(k, m) { quiet++; try { rawSet(recMetaKey(k), JSON.stringify(m)); } finally { quiet--; } }
  const metaOf = (all, name) => {
    const m = isObj(all[name]) ? all[name] : {};
    return { s: isObj(m.s) ? m.s : {}, d: isObj(m.d) ? m.d : {}, t: Number(m.t) || 0, h: m.h || '' };
  };
  // What this computer would send for one student and one store (null = nothing to say)
  function payloadOf(st, v, m, name) {
    const share = shareOf(st, v, name);
    if (kindOf(st) === 'list') {
      const items = {};
      Object.keys(share).forEach(id => { items[id] = { e: share[id], t: m.s[id] || 0 }; });
      return Object.keys(items).length || Object.keys(m.d).length ? { kind: 'list', items, dead: Object.assign({}, m.d) } : null;
    }
    return share !== null || m.t > 0 ? { kind: 'one', v: share, t: m.t } : null;
  }
  const hashOf = p => (p ? idOf(p) : '');

  // The site changed one of its lists here (a part finished, the PIN's clear, a retake): note what changed, send it
  function onRecordChange(st, beforeRaw, afterRaw) {
    if (recSkip()) return;
    const before = storeFrom(st, beforeRaw), after = storeFrom(st, afterRaw);
    const names = namesIn(st, before).concat(namesIn(st, after)).filter((x, i, a) => a.indexOf(x) === i && !skipName(x));
    if (!names.length) return;
    const all = readRecMeta(st.key), now = Date.now();
    const touched = [];
    names.forEach(name => {
      const a = shareOf(st, before, name), b = shareOf(st, after, name), m = metaOf(all, name);
      let changed = false;
      if (kindOf(st) === 'list') {
        Object.keys(b).forEach(id => { if (!(id in a)) { m.s[id] = now; changed = true; } });
        Object.keys(a).forEach(id => { if (!(id in b)) { m.d[id] = now; delete m.s[id]; changed = true; } });
      } else if (canon(a) !== canon(b)) { m.t = now; changed = true; }
      if (changed) { all[name] = m; touched.push(name); }
    });
    if (!touched.length) return;
    writeRecMeta(st.key, all);
    const me = cfg.who && cfg.who();
    touched.forEach(name => queuePush(rowSite(st), name, name === me));
  }

  // Entries that say when they were finished go in time order (the site's "latest try" stays the latest)
  const stampOf = e => { const t = e && e.date ? Date.parse(e.date + ' ' + (e.time || '')) : NaN; return isNaN(t) ? null : t; };
  function insertByTime(list, e) {
    const t = stampOf(e);
    const i = t === null ? -1 : list.findIndex(x => { const u = stampOf(x); return u !== null && u > t; });
    return i < 0 ? list.concat([e]) : list.slice(0, i).concat([e], list.slice(i));
  }
  // The sheet's row for one student → this computer's lists. Returns true when a list here changed.
  function applyRow(site, name, row) {
    if (!isObj(row) || skipName(name)) return false;
    let changed = false;
    storesOf(site).forEach(st => {
      const srv = row[st.key];
      if (!isObj(srv)) return;
      const all = readRecMeta(st.key), m = metaOf(all, name);
      let v = readStore(st), touched = false;
      if (kindOf(st) === 'list' && srv.kind === 'list') {
        const sItems = isObj(srv.items) ? srv.items : {}, sDead = isObj(srv.dead) ? srv.dead : {};
        Object.keys(sDead).forEach(id => { m.d[id] = Math.max(m.d[id] || 0, Number(sDead[id]) || 0); });
        Object.keys(sItems).forEach(id => { const t = Number(sItems[id] && sItems[id].t) || 0; if (t > (m.s[id] || 0)) m.s[id] = t; });
        const here = {};
        v = v.filter(e => {
          if (!e || typeof e !== 'object' || e.name !== name) return true;
          const id = idOf(e);
          if (id in m.d && m.d[id] >= (m.s[id] || 0)) { touched = true; return false; }   // removed on another computer
          here[id] = true;
          return true;
        });
        Object.keys(sItems).forEach(id => {
          const it = sItems[id];
          if (here[id] || !isObj(it) || !isObj(it.e) || it.e.name !== name || idOf(it.e) !== id) return;
          if (id in m.d && m.d[id] >= (Number(it.t) || 0)) return;
          v = insertByTime(v, it.e);
          here[id] = true;
          touched = true;
        });
      } else if (kindOf(st) !== 'list' && srv.kind === 'one' && ((Number(srv.t) || 0) > m.t ||
                 // both from before this file (time 0): a value beats none here
                 (!(Number(srv.t) || 0) && !m.t && shareOf(st, v, name) === null && srv.v !== null && srv.v !== undefined))) {
        const val = srv.v === undefined ? null : srv.v;
        if (kindOf(st) === 'map') {
          if (canon(shareOf(st, v, name)) !== canon(val)) {
            v = Object.assign({}, v);
            if (val === null) delete v[name]; else v[name] = val;
            touched = true;
          }
        } else if (kindOf(st) === 'slot') {
          // the one slot on this computer: only the student signed in now takes it (an answer about another
          // student never moves it); a value of theirs that is gone elsewhere leaves it
          const mine = cfg.who && cfg.who() === name;
          if (val !== null && !mine) return;
          if (canon(shareOf(st, v, name)) !== canon(val) && (val === null ? !!v && v.name === name : isObj(val) && val.name === name)) {
            if (v && v.name !== name && !skipName(v.name)) {
              // another student's value is replaced: to the sheet first; here it is "not on this computer" again,
              // so their next sign-in here brings it back from the sheet
              const body = pushBody(site, v.name);
              if (body) post(body, { keepalive: true }).catch(() => {});
              const other = metaOf(all, v.name);
              other.t = 0;
              all[v.name] = other;
            }
            v = val;
            touched = true;
          }
        } else if ((v.indexOf(name) >= 0) !== !!val) {
          v = val ? v.concat([name]) : v.filter(n => n !== name);
          touched = true;
        }
        m.t = Number(srv.t) || 0;
      }
      if (touched) { writeStore(st, v); changed = true; }
      all[name] = m;
      writeRecMeta(st.key, all);
    });
    return changed;
  }
  // Does this computer know something the sheet's row does not? (an entry, a later removal, a later value)
  function lacks(site, name, row) {
    row = isObj(row) ? row : {};
    return storesOf(site).some(st => {
      const p = payloadOf(st, readStore(st), metaOf(readRecMeta(st.key), name), name);
      if (!p) return false;
      const srv = isObj(row[st.key]) ? row[st.key] : null;
      if (p.kind === 'one') return !srv || srv.kind !== 'one' || p.t > (Number(srv.t) || 0);
      const sItems = srv && isObj(srv.items) ? srv.items : {}, sDead = srv && isObj(srv.dead) ? srv.dead : {};
      return Object.keys(p.items).some(id => !(id in sItems) && !((Number(sDead[id]) || 0) >= p.items[id].t && id in sDead)) ||
        Object.keys(p.dead).some(id => p.dead[id] > (Number(sDead[id]) || 0));
    });
  }
  // The sheet has everything this computer has for that student (as of now)
  function markSynced(site, name) {
    storesOf(site).forEach(st => {
      const all = readRecMeta(st.key), m = metaOf(all, name);
      m.h = hashOf(payloadOf(st, readStore(st), m, name));
      all[name] = m;
      writeRecMeta(st.key, all);
    });
  }
  const dirty = (site, name) => storesOf(site).some(st => {
    const m = metaOf(readRecMeta(st.key), name);
    return hashOf(payloadOf(st, readStore(st), m, name)) !== m.h;
  });
  function pushBody(site, name) {
    const stores = {};
    storesOf(site).forEach(st => {
      const p = payloadOf(st, readStore(st), metaOf(readRecMeta(st.key), name), name);
      if (p) stores[st.key] = p;
    });
    return Object.keys(stores).length ? { action: 'recSave', site, name, stores } : null;
  }

  // Sends: one at a time, the signed-in student first; a failed send is tried again later, then waits for a change
  const recQueue = [];
  let recBusy = false, recFails = 0, recTimer = null, backfilled = 0, backfillTimer = null, recSending = '';
  const lackTries = {};
  const urgent = new Set();   // keys queued by a change made here (not the slow backfill): sent quickly, and on closing
  const CHANGE_GAP = 300;     // between the sends of one change (the Teacher PIN's clear: every student on this computer)
  // The student signed in now got something new from the sheet after the sign-in: redraw the locks if the menu shows
  function lateRefresh(name) {
    if (!cfg.refresh || !cfg.who || cfg.who() !== name) return;
    const menu = document.getElementById('section-select') || document.getElementById('form-select-section');
    if (!menu || menu.classList.contains('hidden')) return;
    try { cfg.refresh(name); } catch (e) { /* never break the site */ }
  }
  function queuePush(site, name, first, delay) {
    const k = site + '|' + name, i = recQueue.indexOf(k);
    if (i >= 0) recQueue.splice(i, 1);
    if (first) recQueue.unshift(k); else recQueue.push(k);
    urgent.add(k);
    recFails = 0;
    if (!recBusy) pumpSoon(delay || 0);
  }
  function pumpSoon(ms) { clearTimeout(recTimer); recTimer = setTimeout(() => { recTimer = null; pump(); }, ms); }
  function pump() {
    if (recBusy || !recQueue.length || recSkip() || typeof fetch !== 'function') return;
    const k = recQueue.shift(), cut = k.indexOf('|'), site = k.slice(0, cut), name = k.slice(cut + 1);
    const body = pushBody(site, name);
    if (!body) { pumpSoon(0); return; }
    recBusy = true;
    recSending = k;
    post(body, { keepalive: true })   // a page closing mid-send still delivers it (when small enough)
      .then(res => {
        if (!answered(res)) throw new Error('no answer');
        recFails = 0;
        if (res.ok === true && isObj(res.stores)) {
          if (applyRow(site, name, res.stores)) lateRefresh(name);
          // still something the sheet would not take: once more, then stop (never a loop of sends)
          lackTries[k] = (lackTries[k] || 0) + 1;
          if (lackTries[k] < 2 && lacks(site, name, res.stores)) { if (recQueue.indexOf(k) < 0) recQueue.unshift(k); }
          else { delete lackTries[k]; markSynced(site, name); }
        }
      })
      .catch(() => {
        recFails++;
        delete lackTries[k];
        if (recFails < REC_TRIES && recQueue.indexOf(k) < 0) recQueue.unshift(k);
      })
      .finally(() => {
        recBusy = false;
        recSending = '';
        if (recQueue.indexOf(k) < 0) urgent.delete(k);
        if (!recQueue.length) return;
        const next = recQueue[0];
        pumpSoon(recFails ? RETRY_MS * recFails
          : next.slice(next.indexOf('|') + 1) === (cfg.who && cfg.who()) ? 0 : urgent.has(next) ? CHANGE_GAP : BACKFILL_GAP);
      });
  }
  // Other students' finished work on this computer that the sheet may not have yet: a few, slowly, after a sign-in
  function backfillLater() {
    if (backfillTimer || backfilled >= BACKFILL_MAX) return;
    backfillTimer = setTimeout(() => {
      backfillTimer = null;
      if (recSkip()) return;
      const me = cfg.who && cfg.who();
      recSites().forEach(site => {
        const names = [];
        storesOf(site).forEach(st => {
          namesIn(st, readStore(st)).concat(Object.keys(readRecMeta(st.key))).forEach(n => { if (names.indexOf(n) < 0) names.push(n); });
        });
        names.forEach(name => {
          if (backfilled >= BACKFILL_MAX || name === me || skipName(name) || !dirty(site, name)) return;
          if (recQueue.indexOf(site + '|' + name) >= 0) return;
          backfilled++;
          recQueue.push(site + '|' + name);
        });
      });
      if (!recBusy && !recTimer) pumpSoon(0);
    }, BACKFILL_MS);
  }
  // At sign-in: the sheet's rows (r.recs, in the spotGet answer) → this computer; what the sheet lacks → the sheet
  let recChangedFor = '';
  const SPREAD_MS = 2500;   // a class signing in at once: their first sends spread over this much
  function recordsAtSignIn(name, recs) {
    if (!recList().length || recSkip()) return;
    let unanswered = false;
    recSites().forEach(site => {
      const row = isObj(recs) ? recs[site] : undefined;
      if (isObj(row)) {
        if (applyRow(site, name, row)) recChangedFor = name;
        if (lacks(site, name, row)) queuePush(site, name, true, Math.floor(Math.random() * SPREAD_MS)); else markSynced(site, name);
      } else {
        unanswered = true;
        if (dirty(site, name)) queuePush(site, name, true, Math.floor(Math.random() * SPREAD_MS));   // send what is here
      }
    });
    if (unanswered && isObj(recs) === false) pullLater(name, 1);
    backfillLater();
  }
  // The sign-in got no answer: ask the sheet again a little later (the lists only), merge, and redraw the locks
  function pullLater(name, n) {
    if (n > REC_TRIES) return;
    setTimeout(() => {
      if (recSkip() || !cfg.who || cfg.who() !== name) return;
      post({ action: 'spotGet', site: cfg.site, name, recs: recSites() })
        .then(r => {
          if (!(r && r.ok === true && isObj(r.recs))) throw new Error('no answer');
          let changed = false;
          recSites().forEach(site => {
            const row = r.recs[site];
            if (!isObj(row)) return;
            if (applyRow(site, name, row)) changed = true;
            if (lacks(site, name, row)) queuePush(site, name, true); else markSynced(site, name);
          });
          if (changed) lateRefresh(name);
        })
        .catch(() => pullLater(name, n + 1));
    }, RETRY_MS * n);
  }
  function closingRecords() {
    const me = cfg.who && cfg.who();
    const keys = recQueue.filter(k => urgent.has(k) || k.slice(k.indexOf('|') + 1) === me);
    if (recSending && keys.indexOf(recSending) < 0) keys.unshift(recSending);
    keys.forEach(k => {
      const body = pushBody(k.slice(0, k.indexOf('|')), k.slice(k.indexOf('|') + 1));
      if (body) post(body, { keepalive: true }).catch(() => {});
    });
  }

  function hook() {
    if (!proto || proto.__spotSync) return;
    const set = proto.setItem, remove = proto.removeItem;
    rawSet = (k, v) => { try { set.call(LS, k, v); } catch (e) { /* full or blocked */ } };
    rawRemove = k => { try { remove.call(LS, k); } catch (e) { /* blocked */ } };
    proto.setItem = function (k, v) {
      const rec = cfg && !quiet && this === LS ? storeFor(k) : null;
      const before = rec ? rawGet(k) : null;
      const r = set.apply(this, arguments);   // a full storage throws here, like before
      if (rec) { try { onRecordChange(rec, before, String(v)); } catch (e) { /* never break the site */ } }
      if (cfg && !quiet && this === LS && watched(k)) { try { onSaved(k, String(v)); } catch (e) { /* never break the site */ } }
      return r;
    };
    proto.removeItem = function (k) {
      const rec = cfg && !quiet && this === LS ? storeFor(k) : null;
      const watch = cfg && !quiet && this === LS && watched(k);
      const old = watch || rec ? rawGet(k) : null;
      const r = remove.apply(this, arguments);
      if (rec && old) { try { onRecordChange(rec, old, null); } catch (e) { /* never break the site */ } }
      if (watch && old) { try { onRemoved(k, old); } catch (e) { /* never break the site */ } }
      return r;
    };
    proto.__spotSync = true;
  }
  function closing() { if (pending) flush(true); try { closingRecords(); } catch (e) { /* never break the site */ } }

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
    const body = { action: 'spotGet', site: cfg.site, name };
    const withRecs = recList().length > 0 && !recSkip();
    if (withRecs) body.recs = recSites();   // the finished work comes in the same answer
    let recsDone = false;
    return post(body, { timeoutMs: WAIT_MS })
      .then(r => {
        if (!(r && r.ok === true)) return 'offline';
        if (withRecs) { recsDone = true; try { recordsAtSignIn(name, r.recs); } catch (e) { /* never break the site */ } }
        return decide(name, r, deadline + 5000);
      })
      .catch(() => 'offline')
      .then(result => {
        if (result === 'offline') unsure.add(name); else if (result !== 'stale') unsure.delete(name);
        if (withRecs && !recsDone) { try { recordsAtSignIn(name, null); } catch (e) { /* never break the site */ } }
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
  // Once per sign-in: the menu held, the sheet asked (saved spot + finished work), the locks redrawn
  let asked = '', waiting = null;
  function ready(name) {
    if (!cfg || !name || skipName(name) || skipNow()) return Promise.resolve('skip');
    if (asked === name) return waiting || Promise.resolve('asked');
    asked = name;
    hold(true);
    const p = restore(name).then(result => {
      if (waiting !== p) return result;   // a newer sign-in is waiting: its answer releases the menu
      waiting = null;
      hold(false);
      if (recChangedFor === name && cfg.refresh && cfg.who && cfg.who() === name) {
        recChangedFor = '';
        try { cfg.refresh(name); } catch (e) { /* never break the site */ }
      }
      return result;
    });
    waiting = p;
    return p;
  }
  function signIn(name) {   // each sign-in asks again (unless that same sign-in is still waiting)
    if (!(asked === name && waiting)) asked = '';
    return ready(name).catch(() => 'offline');
  }
  function wrapCheckResume(app) {
    if (!app || typeof app.checkResume !== 'function' || app.checkResume.__spot) return;
    const original = app.checkResume;
    const wrapped = function () {
      const self = this, args = arguments;
      const name = cfg.who && cfg.who();
      if (!name) asked = '';                                  // signed out: the next sign-in asks again
      if (!name || skipName(name) || skipNow()) return original.apply(self, args);
      if (asked === name && !waiting) return original.apply(self, args);   // already asked for this sign-in
      ready(name).then(() => { if (cfg.who() === name) original.apply(self, args); });
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

  window.SpotSync = { init, restore, signIn, WAIT_MS };
})();
