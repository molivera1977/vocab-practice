/* ═══════════════════════════════════════════════════════
   share.js · SHARE MODE — the same file on every site
   Open a site with ?share=<code> to let another teacher or an
   admin try it:
     - no student sign-in
     - nothing is sent to the Google Sheet or the dashboard
     - its saved progress lives under its own share_ keys, so it
       never touches a student's data on a shared computer
     - every visit starts fresh (no attempt locks carry over)
   The site's own script.js reads window.SHARE_MODE for the few
   things only it knows: skip sign-in, open every part, and show
   the answers on the results page.
   Students never get this: without the right code it does nothing.
═══════════════════════════════════════════════════════ */
(function () {
  var SHARE_CODE = 'mro';       // the code on the share link — change it here to shut old links off

  var on = new URLSearchParams(location.search).get('share') === SHARE_CODE;
  window.SHARE_MODE = on;
  if (!on) return;

  /* 1. Storage: every key gets a share_ prefix, and each visit starts clean. */
  var PREFIX = 'share_';
  [window.localStorage, window.sessionStorage].forEach(function (store) {
    try {
      Object.keys(store).filter(function (k) { return k.indexOf(PREFIX) === 0; })
        .forEach(function (k) { store.removeItem(k); });
    } catch (e) {}
  });
  ['getItem', 'setItem', 'removeItem'].forEach(function (method) {
    var original = Storage.prototype[method];
    Storage.prototype[method] = function (key) {
      var args = Array.prototype.slice.call(arguments);
      args[0] = PREFIX + key;
      return original.apply(this, args);
    };
  });

  /* 2. Network: nothing reaches the Google Sheet. The call "succeeds" with an
        empty answer so the site carries on exactly as it would for a student. */
  var toSheet = function (target) {
    var url = String((target && target.url) || target || '');
    return /script\.google(usercontent)?\.com/.test(url);
  };
  var realFetch = window.fetch;
  window.fetch = function (target) {
    if (toSheet(target)) {
      window.SHARE_BLOCKED = (window.SHARE_BLOCKED || 0) + 1;
      return Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    return realFetch.apply(this, arguments);
  };
  if (navigator.sendBeacon) {
    var realBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (target) {
      if (toSheet(target)) { window.SHARE_BLOCKED = (window.SHARE_BLOCKED || 0) + 1; return true; }
      return realBeacon.apply(null, arguments);
    };
  }

  /* 3. A banner so the visitor knows what this is; the Teacher Access link goes away. */
  var dress = function () {
    var bar = document.createElement('div');
    bar.className = 'share-banner';
    bar.textContent = '👀 Shared preview — no sign-in, and nothing is saved or sent to Mr. O';
    /* Pinned across the very top of the screen. It is taken out of the page's own layout on purpose:
       some sites lay <body> out as a row or pad it, and a banner placed "first in the page" then lands
       beside the content or inset from the edges. The page is pushed down by the banner's height. */
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;box-sizing:border-box;margin:0;' +
      'padding:8px 14px;background:#fff3cd;border-bottom:2px solid #ffc107;color:#856404;' +
      'font:bold 15px/1.4 system-ui,sans-serif;text-align:center;';
    document.body.insertBefore(bar, document.body.firstChild);
    /* The reading sites keep the story panel stuck 14px from the top while the questions scroll;
       it has to stick below the banner instead of under it. */
    var stuck = document.createElement('style');
    document.head.appendChild(stuck);
    var makeRoom = function () {
      var h = bar.offsetHeight;
      document.documentElement.style.paddingTop = h + 'px';
      stuck.textContent = '.story-panel { top: ' + (h + 14) + 'px !important; }';
    };
    makeRoom();
    window.addEventListener('resize', makeRoom);
    var each = function (selector, fn) { Array.prototype.forEach.call(document.querySelectorAll(selector), fn); };
    each('[onclick*="promptTeacherReview"]', function (el) { el.style.display = 'none'; });

    /* The directions are written for students. One note on top says what is different here. */
    var directions = document.getElementById('directions-screen');
    if (directions) {
      var note = document.createElement('div');
      note.className = 'share-note';
      note.style.cssText = 'background:#fff3cd;border:2px solid #ffc107;border-radius:12px;padding:12px 16px;' +
        'margin-bottom:16px;color:#856404;font-size:0.95rem;line-height:1.6;';
      note.innerHTML = '<strong>For visitors:</strong> the directions below are what students see. ' +
        'In this shared preview there is no sign-in, every part is open, and you can take anything as many ' +
        'times as you like. Written answers are optional and are not sent. The results page at the end ' +
        'shows the correct answers.';
      var heading = directions.querySelector('h2');
      if (heading) heading.insertAdjacentElement('afterend', note); else directions.insertBefore(note, directions.firstChild);
    }

    /* Student-only pieces on the "choose a part" screen: the attempt rules and the score history. */
    each('#form-select-section div', function (el) {
      if (!el.querySelector('div, button') && /Rules:/.test(el.textContent)) el.style.display = 'none';
    });
    each('#form-select-section .score-btn', function (el) { el.parentElement.style.display = 'none'; });

    var writtenNote = document.getElementById('written-teacher-note');
    if (writtenNote) writtenNote.textContent = '👀 Shared preview — written answers are optional and are not sent.';
  };
  if (document.body) dress(); else document.addEventListener('DOMContentLoaded', dress);
})();
