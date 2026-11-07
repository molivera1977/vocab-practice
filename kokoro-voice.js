/* ═══════════════════════════════════════════════════════
   KOKORO VOICE — one identical file on every site that has
   Kokoro recordings (keep the copies the same; the master
   is website data/kokoro-voice/kokoro-voice.js).

   Marcos 10/31: "Can Kokoro be our voice for all pages and
   sites, not just video?" → "Yes, pilot POS". He picked
   Kokoro (af_heart) over the Mac voice, Qwen3, Chatterbox
   and his own cloned voice.

   Load it AFTER kokoro/lines.js and BEFORE next-waits.js
   and the page's own script:
     <script src="kokoro/lines.js?v=…"></script>
     <script src="kokoro-voice.js?v=1"></script>
   It stands in for the browser's voice
   (window.speechSynthesis). A line the page hands to the
   voice that has a recording (kokoro/lines.js) is played
   from kokoro/<id>.webm, and the page hears what Chrome's
   voice would tell it: start, each word as it is said
   (charIndex, so the highlight follows), end, and on Stop
   an "interrupted" error. speaking / pending stay true
   while a recording plays, so the page's highlight watch,
   its no-sound waits and next-waits.js all work unchanged.

   Never silent because of it: a line with no recording, a
   recording that will not load or play within 2.5 s (the
   page's own no-sound wait is 4 s), or a browser that
   cannot play it, is said by the device's own voice. Those
   lines are kept in KokoroVoice.misses / .fellBack.

   ?voice=device on the address turns it off (to compare).
   Under the class-site tests' stand-in voices it only
   listens (KokoroVoice.mode 'audit'): every line passes to
   the stand-in, and a line with no recording is kept in
   KokoroVoice.misses for the spec to report.

   What it proves: the line was played to the end. Not that
   the child listened.
═══════════════════════════════════════════════════════ */
(function () {
  var START_GIVE_UP = 2500;   // no sound from the recording by then: the device's voice says the line
  var WORD_POLL_MS = 40;      // how often the word being said is checked (a word lasts ~250 ms)
  var NORMAL_RATE = window.KOKORO_NORMAL_RATE || 0.82;   // the sites' reading rate = the recording's own speed
  var END_STOP = /[.!?:,]["”’]?$/;
  var real = window.speechSynthesis;
  var LINES = window.KOKORO_LINES;

  function canon(t) {   // the sites end a line they read with a stop; make_lines.py keys lines the same way
    t = String(t == null ? '' : t).trim();
    return END_STOP.test(t) ? t : t + '.';
  }
  function lookup(t) {
    var k = canon(t);
    return LINES && Object.prototype.hasOwnProperty.call(LINES, k) ? LINES[k] : null;
  }
  var api = window.KokoroVoice = {
    mode: 'off', misses: [], fellBack: [], played: 0,
    has: function (t) { return !!lookup(t); }
  };
  function miss(t) { t = String(t); if (api.misses.indexOf(t) < 0) api.misses.push(t); }

  if (!real || typeof real.speak !== 'function' || !LINES || typeof Audio === 'undefined') return;
  if (/[?&]voice=device\b/.test(location.search)) return;
  var native = typeof SpeechSynthesis !== 'undefined' && real instanceof SpeechSynthesis;
  api.mode = window.KOKORO_MODE || (native ? 'play' : 'audit');

  if (api.mode === 'audit') {
    var standInSpeak = real.speak;
    real.speak = function (u) {
      if (u && !lookup(u.text)) miss(u.text);
      return standInSpeak.apply(real, arguments);
    };
    return;
  }

  var queue = [], cur = null;

  // Tell the page what Chrome's voice would: a real event on the utterance runs both u.onend and its listeners
  function fire(u, type, extra) {
    extra = extra || {};
    var init = { utterance: u, charIndex: extra.charIndex || 0, charLength: extra.charLength || 0,
                 elapsedTime: extra.elapsedTime || 0, name: extra.name || '' };
    var ev = null;
    try {
      if (type === 'error') { init.error = extra.error || 'interrupted'; ev = new SpeechSynthesisErrorEvent('error', init); }
      else ev = new SpeechSynthesisEvent(type, init);
    } catch (e) { ev = null; }
    if (ev && typeof u.dispatchEvent === 'function') { u.dispatchEvent(ev); return; }
    var h = u['on' + type];
    if (typeof h === 'function') h.call(u, Object.assign({ type: type }, init));
  }

  function quietDown(it) {
    clearInterval(it.poll); clearInterval(it.watch);
    clearTimeout(it.giveUp); clearTimeout(it.waitTimer);
    if (it.audio) {
      var a = it.audio; it.audio = null;
      a.pause(); a.removeAttribute('src'); a.load();   // stop the download too
    }
  }

  function next() {
    if (cur) return;
    var it = queue.shift();
    if (!it) return;
    cur = it;
    if (!it.line) { toDevice(it, null); return; }
    playWhenQuiet(it);
  }

  // A line the device's voice is still saying (a line with no recording) finishes first, as in Chrome's queue
  function playWhenQuiet(it) {
    if (cur !== it) return;
    if (real.speaking || real.pending) { it.waitTimer = setTimeout(function () { playWhenQuiet(it); }, 100); return; }
    play(it);
  }

  function play(it) {
    var u = it.u, marks = it.line[2] || [], k = 0;
    var a = it.audio = new Audio('kokoro/' + it.line[0] + '.webm');
    a.preload = 'auto';
    if (typeof u.volume === 'number' && u.volume >= 0 && u.volume <= 1) a.volume = u.volume;
    if (typeof u.rate === 'number' && u.rate > 0) {
      a.playbackRate = Math.max(0.5, Math.min(2, u.rate / NORMAL_RATE));
      a.preservesPitch = true;
    }
    var words = function () {
      if (cur !== it || !it.audio) return;
      var t = a.currentTime;
      while (k < marks.length && marks[k + 1] <= t + 0.02) {
        fire(u, 'boundary', { name: 'word', charIndex: marks[k], elapsedTime: Math.round(marks[k + 1] * 1000) });
        k += 2;
      }
    };
    // Only this line's own recording, still playing it, counts: a recording that was stopped or handed to the
    // device's voice reports a failure as it is shut down, and that must not hand the line on a second time
    // (found 10/31 by pos-kokoro.spec.js: a line given up on was said twice)
    var mine = function () { return cur === it && it.audio === a; };
    a.addEventListener('playing', function () {
      if (!mine() || it.started) return;
      it.started = true;
      clearTimeout(it.giveUp);
      api.played++;
      fire(u, 'start');
      it.poll = setInterval(words, WORD_POLL_MS);
      words();
    });
    a.addEventListener('ended', function () {
      if (!mine()) return;
      var ms = Math.round((a.duration || 0) * 1000);
      quietDown(it);
      cur = null;
      fire(u, 'end', { charIndex: String(u.text).length, elapsedTime: ms });
      next();   // a line the page started from its own onend is already in the queue
    });
    a.addEventListener('error', function () {
      if (!mine()) return;
      if (!it.started) { toDevice(it, 'would not load'); return; }
      quietDown(it);
      cur = null;
      fire(u, 'error', { error: 'audio-hardware' });
      next();
    });
    it.giveUp = setTimeout(function () { if (mine() && !it.started) toDevice(it, 'too slow to start'); }, START_GIVE_UP);
    var p = a.play();
    if (p && typeof p.catch === 'function') p.catch(function () { if (mine() && !it.started) toDevice(it, 'not allowed to play'); });
  }

  // The device's own voice says it; the queue goes on once that voice is done (or never starts)
  function toDevice(it, why) {
    quietDown(it);
    if (why) api.fellBack.push({ text: String(it.u.text), why: why });
    it.sent = true;
    var u = it.u, at = Date.now(), quiet = 0, done = false;
    var settle = function () {
      if (done) return;
      done = true;
      clearInterval(it.watch);
      if (cur === it) { cur = null; next(); }
    };
    if (typeof u.addEventListener === 'function') { u.addEventListener('end', settle); u.addEventListener('error', settle); }
    it.watch = setInterval(function () {   // some voices never say they ended, some never start
      if (real.speaking || real.pending) { quiet = 0; return; }
      if (++quiet >= 3 && Date.now() - at > 600) settle();
    }, 200);
    real.speak(u);
  }

  var voice = {
    speak: function (u) {
      if (!u) return;
      var line = lookup(u.text);
      if (!line) miss(u.text);
      queue.push({ u: u, line: line });
      next();
    },
    cancel: function () {
      var gone = (cur ? [cur] : []).concat(queue);
      queue = [];
      if (cur) quietDown(cur);
      cur = null;
      real.cancel();   // the device's voice reports its own cut-off lines
      gone.forEach(function (it) {
        if (!it.sent) Promise.resolve().then(function () { fire(it.u, 'error', { error: 'interrupted' }); });
      });
    },
    pause: function () { if (cur && cur.audio) cur.audio.pause(); real.pause(); },
    resume: function () { if (cur && cur.audio) cur.audio.play(); real.resume(); },
    getVoices: function () { return real.getVoices(); },
    addEventListener: function () { return real.addEventListener.apply(real, arguments); },
    removeEventListener: function () { return real.removeEventListener.apply(real, arguments); },
    dispatchEvent: function () { return real.dispatchEvent.apply(real, arguments); }
  };
  Object.defineProperty(voice, 'speaking', { get: function () { return !!cur || real.speaking; } });
  Object.defineProperty(voice, 'pending', { get: function () { return queue.length > 0 || real.pending; } });
  Object.defineProperty(voice, 'paused', { get: function () { return real.paused; } });
  Object.defineProperty(voice, 'onvoiceschanged', {
    get: function () { return real.onvoiceschanged; },
    set: function (f) { real.onvoiceschanged = f; }
  });
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, get: function () { return voice; } });
})();
