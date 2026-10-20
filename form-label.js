/* ═══════════════════════════════════════════════════════
   FORM LABEL — one identical file on every class site that
   has more than one form or part (keep the copies the same).

   Pins a big colored label to the top of the screen while a
   student works, naming the form or part they are on, so
   Mr. O can read it from across the room. Marcos 10/19 on
   SBAC Read Literary ("perfect. Easy to see from across the
   room"), then 10/20: the same label on every assignment
   with more than one form or part.

   The site calls FormLabel.show(text, color) when a test
   screen opens and FormLabel.hide() on every other screen.
   This file does the rest: the look, sitting under the
   Guest view strip, keeping a story panel that sticks beside
   the questions below the label, and hiding an older
   in-page part banner while the label is up.
═══════════════════════════════════════════════════════ */
(function () {
  // White text on every one of these is 4.1:1 or better (large bold text needs 3:1).
  var COLORS = {
    orange: '#c2410c', blue: '#1d4ed8', purple: '#7e22ce', green: '#047857',
    teal: '#0f766e', red: '#b91c1c', slate: '#334155', brown: '#92400e'
  };
  var CSS =
    '.form-label{position:sticky;top:0;z-index:30;margin:0 0 14px;padding:8px 16px;border-radius:12px;' +
    'text-align:center;color:#fff;font-size:1.6rem;font-weight:bold;letter-spacing:0.08em;line-height:1.3;' +
    'text-transform:uppercase;box-shadow:0 4px 10px rgba(0,0,0,0.18);}' +
    '.form-label.fl-long{font-size:1.2rem;letter-spacing:0.04em;}' +
    '.form-label.fl-hidden{display:none;}' +
    'body.fl-on .part-banner{display:none;}';
  var el = null, placeStyle = null;

  function ensure() {
    if (el) return el;
    var base = document.createElement('style');
    base.textContent = CSS;
    document.head.appendChild(base);
    el = document.createElement('div');
    el.id = 'form-label';
    el.className = 'form-label fl-hidden';
    var host = document.querySelector('.container') || document.body;
    host.insertBefore(el, host.firstChild);
    placeStyle = document.createElement('style');
    document.head.appendChild(placeStyle);
    return el;
  }

  function place() {
    if (!el) return;
    if (el.classList.contains('fl-hidden')) { placeStyle.textContent = ''; return; }
    var strip = document.querySelector('.share-banner');
    var top = strip ? strip.offsetHeight : 0;
    el.style.top = top + 'px';
    var used = top + el.offsetHeight;
    // A story panel that sticks beside the questions goes below the label, and gets shorter by
    // the same amount, or the end of the question column pushes it back up under the label.
    placeStyle.textContent =
      'body.fl-on .story-panel{top:' + (used + 14) + 'px !important;}' +
      'body.fl-on .story-scroll{max-height:calc(100vh - ' + (150 + used) + 'px) !important;}';
  }

  window.FormLabel = {
    COLORS: COLORS,
    show: function (text, color) {
      ensure();
      el.textContent = text;
      el.style.background = COLORS[color] || color;
      el.classList.toggle('fl-long', text.length > 26);
      el.classList.remove('fl-hidden');
      document.body.classList.add('fl-on');
      place();
    },
    hide: function () {
      if (!el) return;
      el.classList.add('fl-hidden');
      document.body.classList.remove('fl-on');
      place();
    }
  };
  window.addEventListener('resize', place);
})();
