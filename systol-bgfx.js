/* ============================================================================
   Systol — background FX

   Two layers, self-contained:
     · dot grid  — plotting-paper dots over the dashboard page (#dashboard)
     · the wall  — self-building cardio-ridge: rows of randomized ECG traces
                   written into existence by sweeping monitor heads, on every
                   page below the dashboard

   Usage: add ONE line anywhere in the page (end of body preferred):
       <script src="systol-bgfx.js" defer></script>
   The script injects its own <canvas>, dot layer, and styles. It expects the
   app's theme tokens (--bg, --trace, --ink) and follows theme/accent changes
   live. Honors prefers-reduced-motion (renders the finished wall as a still).

   Behavior (as signed off in the preview):
     · the build waits until the wall is first scrolled into view, then
       accelerates — BUILD_RATE 3 ≈ first rows ~2s apart, complete in ~20–25s
     · every trace random: beat spacing/heights, faint beats, activity bumps
       anywhere on the page; each completed sweep pens a fresh trace
     · per-row erase gaps 60–140px, re-rolled every lap
     · easter egg: 75–135s after the wall is first seen (then every 2–4 min),
       one vertical strip fires a single synchronized beat — every row its own
       ECG signal (position/width/height, some rows two), nothing identical
   ========================================================================== */
(function () {
  'use strict';

  /* ---- the three dials ----
     Defaults below are the marketing-page look. Any page can override them on
     its own <script> tag, so a doc page can stay quiet without a second file:

       <script src="systol-bgfx.js" data-brightness="45" data-wall="off" defer></script>

     data-brightness  0–100, the readability dial (see BRIGHTNESS)
     data-wall        "off" drops the ECG traces and keeps only the dot grid
     data-dot-spacing px between dots                                        */
  var OPTS = (document.currentScript && document.currentScript.dataset) || {};
  function num(v, fallback) { var n = parseFloat(v); return isFinite(n) ? n : fallback; }

  var BRIGHTNESS = num(OPTS.brightness, 100);
                               /* % of the design's own brightness — the readability
                                  dial. 100 = as designed; lower it (65 is calm, 45 is
                                  barely-there) if the background ever competes with
                                  the copy. Applies to the traces AND the dot grid. */
  var BUILD_RATE = 3;          /* build-up pace (scales the ramp: ~20–25s to fill) */
  var DOT_SPACING = num(OPTS.dotSpacing, 26);  /* px between plotting-paper dots */
  var WALL_ON = String(OPTS.wall || '').toLowerCase() !== 'off';
                               /* false → dots only; the canvas never shows and the
                                  animation loop never starts (info-focused pages) */

  var DIM = Math.max(0, BRIGHTNESS) / 100;

  function boot() {
    /* ---- inject layers + styles ---- */
    var style = document.createElement('style');
    style.textContent =
      /* style.css paints the page colour on <body>, which would cover anything
         at z-index -1. Hand that job to <html> instead (same pixel result —
         the root's background still fills the canvas viewport) so the FX
         layers below body become visible. */
      'html:root{background:var(--bg)}html:root>body{background:transparent}' +
      '#bgfx{position:fixed;inset:0;width:100%;height:100%;z-index:-1;pointer-events:none}' +
      '#bgfx-dots{position:fixed;inset:0;z-index:-1;pointer-events:none;opacity:' + Math.min(1, DIM) + ';' +
        'background-image:radial-gradient(circle,color-mix(in srgb,var(--ink) 20%,transparent) 1px,transparent 1.4px);' +
        'background-size:' + DOT_SPACING + 'px ' + DOT_SPACING + 'px}' +
      'footer{background:var(--bg)}' +   /* footer is chrome — the FX stop at its rule */
      /* At the very top the header goes transparent so the dot grid runs
         straight through it and the page reads as one surface; it fades to
         opaque as soon as you scroll, so content never passes under glass.
         app.js already toggles .scrolled at scrollY > 4. */
      'body:not(.bgfx-off) header{background:transparent;' +
        'transition:border-color .2s ease,background-color .2s ease}' +
      'body:not(.bgfx-off) header.scrolled{background:var(--bg)}';
    document.head.appendChild(style);

    var canvas = document.createElement('canvas');
    canvas.id = 'bgfx'; canvas.setAttribute('aria-hidden', 'true');
    var dots = document.createElement('div');
    dots.id = 'bgfx-dots'; dots.setAttribute('aria-hidden', 'true');
    /* canvas first, dots above it (same z-index, later in DOM) */
    document.body.insertBefore(dots, document.body.firstChild);
    document.body.insertBefore(canvas, dots);

    var ctx = canvas.getContext('2d');
    var reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    var DPR = Math.min(window.devicePixelRatio || 1, 2);
    var W = 0, H = 0;

    /* ---- palette, read live from the theme tokens ---- */
    var pal;
    function cssHex(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
    function rgb(hex) {
      var h = hex.replace('#', '');
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      var n = parseInt(h, 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    /* everything paints through this, so scaling alpha here dims the whole
       effect. pal.bg is exempt: the occlusion fills must stay fully opaque or
       the rows stop hiding the ones behind them. */
    function rgba(c, a) {
      if (pal && c !== pal.bg) a *= DIM;
      return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')';
    }
    function readPalette() {
      var bg = rgb(cssHex('--bg'));
      pal = {
        bg: bg,
        light: (bg[0] + bg[1] + bg[2]) / 3 > 128,
        trace: rgb(cssHex('--trace'))
      };
    }

    /* ---- shared value noise ---- */
    function n2(x, y) { var n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453; return n - Math.floor(n); }
    function noise(x, y) {
      var ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
      var a = n2(ix, iy), b = n2(ix + 1, iy), c = n2(ix, iy + 1), d = n2(ix + 1, iy + 1);
      var ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
      return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
    }

    /* ---- PQRST complex, background-scaled (wide bumps survive 3px sampling) ---- */
    function ecgBump(ph, c, w, a) { var d = (ph - c) / w; return a * Math.exp(-d * d); }
    function ecgWide(ph) {
      return ecgBump(ph, 0.16, 0.03, 0.2)
           + ecgBump(ph, 0.235, 0.014, -0.14)
           + ecgBump(ph, 0.25, 0.02, 1)
           + ecgBump(ph, 0.267, 0.016, -0.26)
           + ecgBump(ph, 0.42, 0.06, 0.3);
    }

    /* ---- page-1 boundary: dots own the dashboard, the wall owns the rest ---- */
    var dashEl = document.getElementById('dashboard');
    function dashBottom() {
      if (!dashEl) return 0;
      return Math.max(0, Math.min(H, dashEl.getBoundingClientRect().bottom));
    }
    function layoutDots() {
      /* no dashboard on the page (other pages that include this script) → the
         dots are the whole background, so don't clip them away */
      if (!dashEl) { dots.style.clipPath = 'none'; return; }
      dots.style.clipPath = 'inset(0 0 ' + Math.max(0, H - dashBottom()) + 'px 0)';
    }

    /* ---- the wall ---- */
    var wall = {
      rows: [], clock: 0, realT: 0, started: false, waveT: -1, waveDue: 0, waveCx: 0,
      init: function () {
        this.rows = []; this.clock = 0;
        var gap = 30, top = 24, bottom = H - 10, idx = 0, i, j;
        for (var y0 = top; y0 <= bottom; y0 += gap, idx++) {
          this.rows.push({
            y: y0, idx: idx,
            dir: idx % 2 ? -1 : 1,                 /* alternate rows write opposite ways */
            speed: 90 + n2(idx, 11) * 70,
            gap: 60 + Math.random() * 80,          /* erase gap, re-rolled every lap */
            newSeed: Math.random() * 1000
          });
        }
        /* build-up: rows join in shuffled order once the wall is first seen.
           Reduced motion skips straight to the finished wall. */
        var order = [], pre = reduce.matches;
        this.started = pre;
        for (i = 0; i < this.rows.length; i++) order.push(i);
        for (i = order.length - 1; i > 0; i--) {
          j = (Math.random() * (i + 1)) | 0;
          var tmp = order[i]; order[i] = order[j]; order[j] = tmp;
        }
        for (i = 0; i < order.length; i++) {
          var R = this.rows[order[i]];
          R.born = pre ? 0 : (i < 3 ? Math.random() * 1.5 : i * 3 + Math.random() * 2);
          R.oldSeed = pre ? Math.random() * 1000 : null;   /* null = blank paper */
          R.hx = pre ? Math.random() * W : (R.dir > 0 ? -10 : W + 10);
        }
        this.realT = 0;
        this.waveT = -1;
        this.waveDue = 75 + Math.random() * 60;
      },
      /* easter egg: one vertical strip, every row beats ONCE, together —
         each with its own signal, so nothing lines up or repeats */
      wave: function () {
        if (this.waveT >= 0) return;
        this.waveT = 0;
        this.waveCx = W * (0.2 + Math.random() * 0.6);
        for (var i = 0; i < this.rows.length; i++) {
          this.rows[i].wv = {
            x: this.waveCx + (Math.random() - 0.5) * W * 0.12,
            span: 240 + Math.random() * 200,
            amp: 20 + Math.random() * 22,
            jit: Math.random() * 0.15,
            x2: Math.random() < 0.4 ? this.waveCx + (Math.random() - 0.5) * W * 0.16 : null,
            span2: 200 + Math.random() * 120
          };
        }
      },
      /* one trace under one seed — static in screen space; the seed decides
         beat spacing/phase, per-beat heights, faint-beat rate, and where its
         activity bumps sit (anywhere on the page, sometimes two) */
      rowY: function (R, x, seed) {
        var bw = 120 + n2(seed, 3) * 150;
        var u = x / bw + seed;
        var m = Math.floor(u), ph = u - m;
        var beatAmp = 0.45 + n2(m, seed * 13.7) * 0.95;
        if (n2(m * 1.3, seed * 7.1) < 0.06 + n2(seed, 21) * 0.18) beatAmp *= 0.15;
        var ampRow = 16 + 44 * n2(seed, R.idx);
        var c1 = W * (0.05 + n2(seed, 7) * 0.9);
        var w1 = W * (0.14 + n2(seed, 5) * 0.26);
        var env = Math.exp(-Math.pow((x - c1) / w1, 2));
        if (n2(seed, 31) < 0.45) {
          var c2 = W * (0.05 + n2(seed, 43) * 0.9);
          var w2 = W * (0.12 + n2(seed, 57) * 0.2);
          var g2 = Math.exp(-Math.pow((x - c2) / w2, 2)) * (0.5 + n2(seed, 61) * 0.5);
          if (g2 > env) env = g2;
        }
        env = 0.12 + env * 0.88;
        var surge = 0;
        if (this.waveT >= 0 && R.wv) {
          var wv = R.wv;
          var tt = this.waveT - wv.jit;
          var pulse = tt <= 0 ? 0 : (tt / 0.25) * Math.exp(1 - tt / 0.25);
          var ph2 = 0.25 + (x - wv.x) / wv.span;
          if (ph2 > 0.02 && ph2 < 0.98) surge += pulse * wv.amp * ecgWide(ph2);
          if (wv.x2 != null) {
            var ph3 = 0.25 + (x - wv.x2) / wv.span2;
            if (ph3 > 0.02 && ph3 < 0.98) surge += pulse * wv.amp * 0.6 * ecgWide(ph3);
          }
        }
        return R.y - (Math.max(0, ecgWide(ph)) * ampRow * beatAmp * env
               + 5 * noise(x * 0.015 + R.idx * 9.1, seed) + surge);
      },
      frame: function (dt) {
        ctx.clearRect(0, 0, W, H);
        var clipTop = dashBottom();
        var vis = clipTop < H - 2;
        /* build waits for its audience, then accelerates (half pace at first,
           triple by the end) */
        if (!this.started && vis) this.started = true;
        if (this.started) {
          this.clock += dt * BUILD_RATE * (0.5 + 1.5 * Math.min(1, this.clock / 60));
          this.realT += dt;
        }
        if (this.waveT >= 0) {
          this.waveT += dt;                        /* one shared beat, ~2.5s */
          if (this.waveT > 2.5) this.waveT = -1;
        } else if (this.realT >= this.waveDue) {
          this.wave();
          this.waveDue = this.realT + 120 + Math.random() * 120;
        }
        if (vis && clipTop > 0) { ctx.save(); ctx.beginPath(); ctx.rect(0, clipTop, W, H - clipTop); ctx.clip(); }
        var STEP = 3;
        var stroke = rgba(pal.trace, pal.light ? 0.36 : 0.28);
        var fill = rgba(pal.bg, 1);
        ctx.lineWidth = 1.2; ctx.lineJoin = 'round';
        for (var i = 0; i < this.rows.length; i++) {
          var R = this.rows[i];
          if (this.clock < R.born) continue;
          R.hx += R.speed * dt * R.dir;
          if (R.dir > 0 ? R.hx > W + 20 : R.hx < -20) {   /* wrap → this pass becomes the paper */
            R.hx = R.dir > 0 ? -10 : W + 10;
            R.oldSeed = R.newSeed;
            R.newSeed = Math.random() * 1000;
            R.gap = 60 + Math.random() * 80;
          }
          if (!vis) continue;                      /* hidden behind page 1 — state only */
          var xStart = -10, xEnd = W + 10;
          if (R.oldSeed == null) {                 /* first pass writes onto blank paper */
            if (R.dir > 0) xEnd = Math.min(xEnd, R.hx);
            else xStart = Math.max(xStart, R.hx);
          }
          var pts = [];
          for (var x = xStart; x <= xEnd; x += STEP) {
            var isNew = R.dir > 0 ? x <= R.hx : x >= R.hx;
            pts.push(x, this.rowY(R, x, isNew ? R.newSeed : R.oldSeed));
          }
          var j2;
          if (pts.length >= 4) {
            ctx.beginPath();                       /* silhouette: occlude rows behind */
            ctx.moveTo(pts[0], pts[1]);
            for (j2 = 2; j2 < pts.length; j2 += 2) ctx.lineTo(pts[j2], pts[j2 + 1]);
            ctx.lineTo(pts[pts.length - 2], R.y + 2); ctx.lineTo(pts[0], R.y + 2); ctx.closePath();
            ctx.fillStyle = fill; ctx.fill();
            var gLo = R.dir > 0 ? R.hx : R.hx - R.gap;
            var gHi = R.dir > 0 ? R.hx + R.gap : R.hx;
            ctx.strokeStyle = stroke;
            ctx.beginPath();
            var started2 = false;
            for (j2 = 0; j2 < pts.length; j2 += 2) {
              var px = pts[j2];
              if (px > gLo && px < gHi) { started2 = false; continue; }
              if (!started2) { ctx.moveTo(px, pts[j2 + 1]); started2 = true; }
              else ctx.lineTo(px, pts[j2 + 1]);
            }
            ctx.stroke();
          }
          if (R.hx > -10 && R.hx < W + 10) {       /* bright writing head */
            ctx.beginPath(); ctx.arc(R.hx, this.rowY(R, R.hx, R.newSeed), 1.8, 0, Math.PI * 2);
            ctx.fillStyle = rgba(pal.trace, 0.85); ctx.fill();
          }
        }
        if (vis && clipTop > 0) ctx.restore();
        ctx.lineJoin = 'miter';
      }
    };

    /* ---- lifecycle ---- */
    var raf = 0, last = 0, lastW = 0, lastH = 0;
    function resize() {
      W = lastW = window.innerWidth; H = lastH = window.innerHeight;
      DPR = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(W * DPR));
      canvas.height = Math.max(1, Math.round(H * DPR));
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      layoutDots();
      if (canvas.hidden) return;
      wall.init();
      if (reduce.matches) wall.frame(0);
    }
    function loop(ts) {
      raf = requestAnimationFrame(loop);
      var dt = last ? Math.min(0.05, (ts - last) / 1000) : 0.016;
      last = ts;
      wall.frame(dt);
    }
    function stopLoop() { cancelAnimationFrame(raf); raf = 0; last = 0; }
    /* single gate: nothing restarts the loop while the setting is off (tab
       visibility and resize both come through here) */
    function startLoop() {
      if (!raf && !reduce.matches && !canvas.hidden) raf = requestAnimationFrame(loop);
    }

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stopLoop(); else startLoop();
    });
    var scrollRaf;
    window.addEventListener('scroll', function () {
      cancelAnimationFrame(scrollRaf);
      scrollRaf = requestAnimationFrame(function () {
        layoutDots();
        if (reduce.matches) wall.frame(0);         /* keep the still in sync while scrolling */
      });
    }, { passive: true });
    var resizeRaf;
    window.addEventListener('resize', function () {
      cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(function () {
        /* mobile URL-bar show/hide fires resize constantly — let the canvas
           stretch through small height-only changes instead of rebuilding */
        if (window.innerWidth === lastW && Math.abs(window.innerHeight - lastH) < 150) return;
        resize();
      });
    });
    new MutationObserver(function () { readPalette(); if (reduce.matches) wall.frame(0); })
      .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-accent'] });
    if (reduce.addEventListener) {
      reduce.addEventListener('change', function () { stopLoop(); resize(); apply(); });
    }

    /* ---- the on/off setting (Settings → Accessibility) ----
       Owned here rather than in app.js so the whole feature stays one file.
       Default follows the OS reduced-motion preference; the switch overrides
       it, and the choice persists under the app's "systol-" key convention
       (so Restore defaults clears it along with everything else). */
    var PREF_KEY = 'systol-bgfx';
    var toggle = document.getElementById('bgfxToggle');
    function wanted() {
      var v = null;
      try { v = localStorage.getItem(PREF_KEY); } catch (e) {}
      if (v === '1') return true;
      if (v === '0') return false;
      return !reduce.matches;
    }
    function apply() {
      var on = wanted();
      canvas.hidden = !on || !WALL_ON;   /* data-wall="off" → dots only */
      dots.hidden = !on;
      document.body.classList.toggle('bgfx-off', !on);   /* header goes solid again */
      if (toggle) toggle.setAttribute('aria-checked', String(on));
      if (!on || !WALL_ON) { stopLoop(); ctx.clearRect(0, 0, W, H); return; }
      wall.init();
      if (reduce.matches) wall.frame(0); else startLoop();
    }
    if (toggle) {
      toggle.addEventListener('click', function () {
        try { localStorage.setItem(PREF_KEY, wanted() ? '0' : '1'); } catch (e) {}
        apply();
      });
    }

    readPalette();
    resize();
    apply();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
