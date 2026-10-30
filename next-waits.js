/* ═══════════════════════════════════════════════════════
   NEXT WAITS FOR THE VOICE — one identical file on every
   class site with lessons or practice (keep the copies the
   same; the master is site-tests/lib/next-waits.js).

   Marcos 10/30: "no site should allow a next button until
   the read aloud is done speaking. No one should be allowed
   to speed through." … "I am speaking about the actual
   lessons and practice pages" (the directions screens keep
   their own waits).

   The page names its lesson and practice Next buttons on
   the script tag:
     <script src="next-waits.js?v=1" data-hold="#next-btn, #lc-next"></script>
   While the voice is reading anything on the page (a lesson
   card reading itself, a 🔊 the student tapped, a Listen),
   those buttons are dimmed and a tap, Enter or Space on
   them does nothing. They come back 1.2 s after the voice
   ends, so a card read line by line (0.9 s apart) is one
   reading. Stopping the voice lets them go at once.

   Never stuck: a reading that never starts (no sound) lets
   go after 4 s; one that never says it ended lets go once
   the voice has gone quiet, or at the latest after 0.75 s a
   word + 10 s.

   What it proves: Next was not pressed while the voice was
   talking. Not that the child listened.
═══════════════════════════════════════════════════════ */
(function () {
  var SETTLE_MS = 1200;      // longer than the 0.9 s between a reading's lines
  var START_WAIT = 4000;     // no sound by then: this device is not going to speak
  var POLL_MS = 250;
  var synth = window.speechSynthesis;
  var tag = document.currentScript;
  var HOLD = (tag && tag.getAttribute('data-hold')) || '';
  if (!synth || typeof synth.speak !== 'function' || !HOLD) return;

  var live = [];             // the readings handed to the voice and not finished: { u, at, started, words }
  var lastEnd = -Infinity;   // when a reading last came to its end
  var quiet = 0, poll = null, settleTimer = null;

  function busy() {
    return live.length > 0 || Date.now() - lastEnd < SETTLE_MS;
  }

  function paint() {
    var on = busy();
    document.querySelectorAll(HOLD).forEach(function (b) {
      if (on && !b.classList.contains('nw-held')) {
        b.classList.add('nw-held');
        if (!b.hasAttribute('aria-disabled')) { b.setAttribute('aria-disabled', 'true'); b.setAttribute('data-nw-aria', ''); }
      } else if (!on && b.classList.contains('nw-held')) {
        b.classList.remove('nw-held');
        if (b.hasAttribute('data-nw-aria')) { b.removeAttribute('aria-disabled'); b.removeAttribute('data-nw-aria'); }
      }
    });
    if (on && !poll) poll = setInterval(watch, POLL_MS);
    if (!on && poll) { clearInterval(poll); poll = null; }
  }

  function done(job, ended) {
    var k = live.indexOf(job);
    if (k < 0) return;
    live.splice(k, 1);
    if (ended) {
      lastEnd = Date.now();
      clearTimeout(settleTimer);
      settleTimer = setTimeout(paint, SETTLE_MS + 20);
    }
    paint();
  }

  // The voice's own signals can go missing (some voices never say they ended): check on it
  function watch() {
    var now = Date.now();
    live.slice().forEach(function (job) {
      var age = now - job.at;
      if (!job.started && !synth.speaking && age > START_WAIT) done(job, false);        // no sound
      else if (age > START_WAIT + job.words * 750 + 10000) done(job, true);             // never said it ended
    });
    quiet = synth.speaking || synth.pending ? 0 : quiet + 1;
    if (quiet >= 2) live.slice().forEach(function (job) { if (now - job.at > 500) done(job, job.started); });
    paint();
  }

  var speak = synth.speak, cancel = synth.cancel;
  synth.speak = function (u) {
    if (u) {
      var job = { u: u, at: Date.now(), started: false, words: String(u.text || '').split(/\s+/).filter(Boolean).length };
      live.push(job);
      var onstart = u.onstart, onend = u.onend, onerror = u.onerror;
      u.onstart = function (e) { job.started = true; if (onstart) return onstart.call(this, e); };
      u.onend = function (e) { done(job, true); if (onend) return onend.call(this, e); };
      u.onerror = function (e) { done(job, false); if (onerror) return onerror.call(this, e); };
      if (u.addEventListener) {
        u.addEventListener('start', function () { job.started = true; });
        u.addEventListener('end', function () { done(job, true); });
        u.addEventListener('error', function () { done(job, false); });
      }
      quiet = 0;
      paint();
    }
    return speak.apply(synth, arguments);
  };
  synth.cancel = function () {
    live = [];
    lastEnd = -Infinity;     // stopped, not finished: nothing to wait out
    var r = cancel.apply(synth, arguments);
    paint();
    return r;
  };

  // A real tap, Enter or Space on a held button does nothing (the page's own code can still move on)
  function held(el) {
    return !!(el && el.closest && el.closest(HOLD)) && busy();
  }
  document.addEventListener('click', function (e) {
    if (!e.isTrusted || !held(e.target)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    paint();
  }, true);
  ['keydown', 'keyup'].forEach(function (type) {
    document.addEventListener(type, function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      if (!held(document.activeElement)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    }, true);
  });

  // A held button the page adds while the voice is talking ("Go on", made the moment a passage ends) looks held at
  // once, not on the next check a quarter second later (10/30: it looked ready and a tap did nothing)
  new MutationObserver(function () { if (busy()) paint(); }).observe(document.documentElement, { childList: true, subtree: true });

  var css = document.createElement('style');
  css.textContent = '.nw-held{opacity:0.45 !important;cursor:not-allowed !important;}';
  (document.head || document.documentElement).appendChild(css);

  window.NextWaits = { busy: busy, hold: HOLD };
})();
