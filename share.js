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

   TWO GUEST LINKS (Marcos 11/13: "a student guest link … and a
   teacher/admin guest link that will take them to teacher mode"):
     ?share=<SHARE_CODE>    student guest: the cover shows one big
                            🎒 Start as a student guest button
     ?share=<teacher code>  teacher/admin guest: the cover shows 🎒
                            Student guest AND 🧑‍🏫 Teacher / admin
                            guest, which opens the site's Teacher
                            screen with no PIN (Try it, Slide Mode,
                            Answer key). Both are guest views: nothing
                            is saved or sent.
   The teacher code is not written here, only its fingerprint
   (TEACHER_HASH), so it can't be read off this public file. It is on
   Mr. O's Guest View Links page.
   A site opts in by marking its cover's start button
   data-guest-start and setting window.SHARE_OPEN_TEACHER to a
   function that opens its Teacher screen. A site without it treats
   the teacher code as a plain guest view.
═══════════════════════════════════════════════════════ */
(function () {
  var SHARE_CODE = 'mro';       // the student guest code — change it here to shut old links off
  var TEACHER_HASH = 'ae786515';   // fingerprint (fnv) of the teacher/admin code — a new code = a new fingerprint

  /* FNV-1a, 32 bits: a fingerprint of a code, not a lock — enough to keep the code out of sight */
  var fnv = function (s) {
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return ('0000000' + h.toString(16)).slice(-8);
  };
  var given = new URLSearchParams(location.search).get('share') || '';
  var teacher = given !== '' && given !== SHARE_CODE && fnv(given) === TEACHER_HASH;
  var on = given === SHARE_CODE || teacher;
  window.SHARE_MODE = on;
  window.SHARE_TEACHER = teacher;
  // the guest link a page builds its own links from (Try it as a student, back to the Teacher screen):
  // a teacher/admin guest keeps their own code, everyone else gets the student guest code
  window.SHARE_LINK = '?share=' + (teacher ? given : SHARE_CODE);
  if (!on) return;

  /* 1. Storage: every key gets a share_ prefix, and each visit starts clean. A teacher/admin guest keeps one thing
        for the tab: the Teacher screen's pick (<site>_teacher_pick), so ← Teacher screen after Try it lands on the
        same part. */
  var PREFIX = 'share_';
  [window.localStorage, window.sessionStorage].forEach(function (store) {
    try {
      Object.keys(store).filter(function (k) {
        if (k.indexOf(PREFIX) !== 0) return false;
        return !(teacher && store === window.sessionStorage && /_teacher_pick$/.test(k));
      }).forEach(function (k) { store.removeItem(k); });
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
    bar.textContent = teacher
      ? '👀 Teacher / admin guest view · nothing is saved or sent to Mr. O'
      : '👀 Guest view · your results show at the end · nothing is saved or sent to Mr. O';
    /* Pinned across the very top of the screen. It is taken out of the page's own layout on purpose:
       some sites lay <body> out as a row or pad it, and a banner placed "first in the page" then lands
       beside the content or inset from the edges. The page is pushed down by the banner's height. */
    /* Kept quiet on purpose (Marcos 10/13: "less noticeable"): a slim, muted strip, not a warning bar. */
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;box-sizing:border-box;margin:0;' +
      'padding:3px 12px;background:#f3f4f6;border-bottom:1px solid #e5e7eb;color:#6b7280;' +
      'font:normal 12px/1.5 system-ui,sans-serif;text-align:center;letter-spacing:0.01em;';
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
      note.innerHTML = '<strong>For guests:</strong> the directions below are what students see. ' +
        'In this guest view there is no sign-in, every part is open, and you can take anything as many ' +
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

    /* A greeting that says "Your practice is saved for Mr. O" is not true for a visitor.
       The name element stays (the site writes the name into it); only the words after it change. */
    var who = document.getElementById('student-name-display');
    if (who && who.parentElement) {
      while (who.nextSibling) who.parentElement.removeChild(who.nextSibling);
      who.parentElement.appendChild(document.createTextNode('! Nothing is saved in this guest view.'));
    }

    var writtenNote = document.getElementById('written-teacher-note');
    if (writtenNote) writtenNote.textContent = '👀 Guest view — written answers are optional and are not sent.';
  };
  if (document.body) dress(); else document.addEventListener('DOMContentLoaded', dress);

  /* 4. The cover (Marcos 11/13: "both arrive to the cover page but have a very visible student guest and
        teacher/admin guest button"). Runs once the site's own script has run, since that is where
        SHARE_OPEN_TEACHER is set. The student guest link gets one button; the teacher/admin link gets two. */
  var cover = function () {
    var canTeach = teacher && typeof window.SHARE_OPEN_TEACHER === 'function';
    var start = document.querySelector('[data-guest-start]');
    if (start) {
      start.textContent = canTeach ? '🎒 Student guest' : '🎒 Start as a student guest';
      if (canTeach) {
        // a site whose cards wait hidden for this link (the QPS hub has no cover of its own): show them
        start.hidden = false;
        var shut = start.closest('[hidden]');
        if (shut) shut.hidden = false;
        /* Two cards side by side (one above the other on a phone): the button on top, a short line on what it is,
           then three short lines with an icon each, built the same on both sides so they sit even. Marcos 11/13:
           "should each writing be under the proper button so they know what they are getting into?" · "explain
           Teacher Mode a little better and what slide mode is" · "I like the explanations but visually it looks
           dumb" (two uneven gray paragraphs). */
        var css = document.createElement('style');
        css.textContent =
          '.guest-choice{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:18px;max-width:760px;margin:0 auto;text-align:left}' +
          '.guest-card{display:flex;flex-direction:column;gap:12px;padding:14px 14px 16px;border:1px solid #e5e7eb;border-radius:18px;background:#f9fafb}' +
          '.guest-tag{margin:0;font-family:system-ui,sans-serif;font-size:13px;line-height:1.3;font-weight:600;color:#6b7280;text-align:center}' +
          '.guest-note{list-style:none;margin:0;padding:0 4px;display:grid;gap:12px}' +
          '.guest-note li{display:grid;grid-template-columns:28px 1fr;gap:8px;align-items:start;font-size:15px;line-height:1.4;color:#4b5563}' +
          '.guest-note .gi{font-size:19px;line-height:1.2;text-align:center}' +
          '.guest-note b{display:block;color:#1f2937}';
        document.head.appendChild(css);
        var row = document.createElement('div');
        row.className = 'guest-choice';
        row.style.marginTop = getComputedStyle(start).marginTop;   // the room the site gave its own start button
        start.parentNode.insertBefore(row, start);
        var card = function (button, id, tag, items) {
          var c = document.createElement('div');
          c.className = 'guest-card';
          button.style.width = '100%';
          button.style.margin = '0';
          var t = document.createElement('p');
          t.className = 'guest-tag';
          t.textContent = tag;
          var ul = document.createElement('ul');
          ul.className = 'guest-note';
          ul.id = id;
          items.forEach(function (it) {
            var li = document.createElement('li');
            var icon = document.createElement('span');
            icon.className = 'gi';
            icon.setAttribute('aria-hidden', 'true');
            icon.textContent = it[0];
            var words = document.createElement('span');
            var b = document.createElement('b');
            b.textContent = it[1];
            words.appendChild(b);
            words.appendChild(document.createTextNode(it[2]));
            li.appendChild(icon);
            li.appendChild(words);
            ul.appendChild(li);
          });
          c.appendChild(button);
          c.appendChild(t);
          c.appendChild(ul);
          row.appendChild(c);
        };
        /* Teacher Mode in plain words for a visitor who has never seen it. Slide Mode is listed only on a site that
           has it (its button is marked data-guest-slides). */
        var tools = [
          ['👀', 'Try it as a student', 'Any part, start to score. ⏩ skips the waits.'],
          ['✅', 'Answer key', 'Every question, the right answer and why. Printable.']
        ];
        if (document.querySelector('[data-guest-slides]')) {
          tools.push(['🖥️', 'Slide Mode', 'The lesson, big, one step at a time, for the board. Never the scored questions.']);
        }
        var tb = start.cloneNode(false);            // the site's own big-button look, in a color of its own
        ['onclick', 'data-guest-start', 'id', 'disabled'].forEach(function (a) { tb.removeAttribute(a); });
        tb.id = 'guest-teacher-btn';
        if (tb.tagName === 'BUTTON') tb.type = 'button';
        tb.textContent = '🧑‍🏫 Teacher / admin guest';
        tb.style.background = '#0f5f57';
        tb.style.color = '#fff';
        tb.style.boxShadow = '0 4px 0 #0a3f3a';
        tb.addEventListener('click', function () { window.SHARE_OPEN_TEACHER(); });
        card(start, 'guest-student-note', 'Take it the way a student does', [
          ['🔓', 'Every part open', 'No sign-in and nothing locked.'],
          ['📊', 'Score and right answers', 'Shown at the end of each part.'],
          ['🛡️', 'Nothing is saved', 'No scores go to Mr. O.']
        ]);
        card(tb, 'guest-teacher-note', 'Teacher Mode · no PIN · what Mr. O sees', tools);
      }
    }
    // ← Teacher screen from a Try it comes back as <link>#teacher: open it again
    if (canTeach && location.hash === '#teacher') window.SHARE_OPEN_TEACHER();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', cover); else cover();
})();
