// キャンバス描画（スペクトラム・レベルメーター）
(function () {
  'use strict';
  var Core = window.HowlCore;
  var MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  var css = getComputedStyle(document.documentElement);
  var C = {};
  ['text', 'dim', 'line', 'trace', 'peak', 'ok', 'warn', 'danger', 'panel'].forEach(function (k) {
    C[k] = css.getPropertyValue('--' + k).trim() || '#8a96a2';
  });

  function fit(c) {
    var d = Math.min(window.devicePixelRatio || 1, 3);
    var w = Math.max(1, Math.round(c.clientWidth * d)), h = Math.max(1, Math.round(c.clientHeight * d));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    return d;
  }
  function rr(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.arcTo(x + w, y, x + w, y + r, r);
    g.lineTo(x + w, y + h - r); g.arcTo(x + w, y + h, x + w - r, y + h, r);
    g.lineTo(x + r, y + h); g.arcTo(x, y + h, x, y + h - r, r);
    g.lineTo(x, y + r); g.arcTo(x, y, x + r, y, r); g.closePath();
  }

  var LF0 = Math.log10(20), LF1 = Math.log10(20000);
  var cache = { key: '', lo: null, hi: null, fr: null, m: 0, step: 1 };

  // 画面の列ごとに、対応するFFTビンの範囲を前計算
  function buildCols(pw, d, binHz, n) {
    var key = pw + '|' + d + '|' + binHz + '|' + n;
    if (cache.key === key) return cache;
    var step = Math.max(1, Math.round(1.5 * d)), m = Math.floor(pw / step) + 1;
    var lo = new Int32Array(m), hi = new Int32Array(m), fr = new Float32Array(m);
    for (var k = 0; k < m; k++) {
      var x = k * step;
      var f0 = Math.pow(10, LF0 + (x / pw) * (LF1 - LF0));
      var f1 = Math.pow(10, LF0 + ((x + step) / pw) * (LF1 - LF0));
      var b0 = f0 / binHz, b1 = f1 / binHz;
      var l = Math.min(n - 2, Math.max(1, Math.floor(b0)));
      var h = Math.min(n - 2, Math.max(l, Math.floor(b1)));
      lo[k] = l; hi[k] = h;
      fr[k] = Math.min(1, Math.max(0, (b0 + b1) / 2 - l));
    }
    cache = { key: key, lo: lo, hi: hi, fr: fr, m: m, step: step };
    return cache;
  }
  function valueAt(a, cc, k) {
    var l = cc.lo[k], h = cc.hi[k];
    if (h > l) { var m = a[l]; for (var j = l + 1; j <= h; j++) if (a[j] > m) m = a[j]; return m; }
    return a[l] + (a[l + 1] - a[l]) * cc.fr[k];
  }

  var GRID_F = [[50, '50'], [100, '100'], [200, '200'], [500, '500'], [1000, '1k'], [2000, '2k'], [5000, '5k'], [10000, '10k'], [20000, '20k']];

  /** S: {sm, pk, binHz, n, clock, has}, cfg: {dbMin, hold}, entries: 検出リスト */
  function drawSpec(canvas, S, cfg, entries) {
    var g = canvas.getContext('2d'), d = fit(canvas), W = canvas.width, H = canvas.height;
    g.clearRect(0, 0, W, H);
    var L = Math.round(34 * d), R = Math.round(8 * d), T = Math.round(8 * d), B = Math.round(20 * d);
    var pw = W - L - R, ph = H - T - B;
    if (pw < 10 || ph < 10) return;
    var dbMin = cfg.dbMin, dbMax = 0;
    var xOf = function (f) { return L + (Math.log10(Math.min(20000, Math.max(20, f))) - LF0) / (LF1 - LF0) * pw; };
    var yOf = function (v) { return T + (1 - (v - dbMin) / (dbMax - dbMin)) * ph; };

    g.font = Math.round(10 * d) + 'px ' + MONO;
    g.lineWidth = Math.max(1, Math.round(d * 0.75));
    // 横線(dB)
    g.textAlign = 'right'; g.textBaseline = 'middle';
    for (var v = 0; v >= dbMin; v -= 20) {
      var y = Math.round(yOf(v)) + 0.5;
      g.strokeStyle = C.line; g.globalAlpha = 1;
      g.beginPath(); g.moveTo(L, y); g.lineTo(L + pw, y); g.stroke();
      g.fillStyle = C.dim; g.fillText(String(v), L - 5 * d, y);
    }
    // 縦線(Hz)
    g.textBaseline = 'alphabetic';
    for (var q = 0; q < GRID_F.length; q++) {
      var x = Math.round(xOf(GRID_F[q][0])) + 0.5;
      g.strokeStyle = C.line;
      g.beginPath(); g.moveTo(x, T); g.lineTo(x, T + ph); g.stroke();
      var label = GRID_F[q][1], tw = g.measureText(label).width;
      g.fillStyle = C.dim;
      if (x + tw / 2 > W) { g.textAlign = 'right'; g.fillText(label, W - 2 * d, H - 5 * d); }
      else { g.textAlign = 'center'; g.fillText(label, x, H - 5 * d); }
    }

    if (!S.has) {
      g.textAlign = 'center'; g.fillStyle = C.dim; g.font = Math.round(13 * d) + 'px sans-serif';
      g.fillText('「マイク開始」でリアルタイム表示（デモで動きを確認できます）', L + pw / 2, T + ph / 2);
      return;
    }

    var cc = buildCols(pw, d, S.binHz, S.n), top = T + ph;
    g.save();
    g.beginPath(); g.rect(L, T, pw, ph); g.clip();

    // スペクトラム（塗り＋線）
    var k, px;
    g.beginPath();
    g.moveTo(L, top);
    for (k = 0; k < cc.m; k++) { px = L + k * cc.step; g.lineTo(px, Math.min(top, Math.max(T, yOf(valueAt(S.sm, cc, k))))); }
    g.lineTo(L + (cc.m - 1) * cc.step, top); g.closePath();
    g.globalAlpha = 0.16; g.fillStyle = C.trace; g.fill();
    g.globalAlpha = 1; g.strokeStyle = C.trace; g.lineWidth = Math.max(1.5, 1.5 * d); g.lineJoin = 'round';
    g.beginPath();
    for (k = 0; k < cc.m; k++) {
      px = L + k * cc.step; var yy = Math.min(top, Math.max(T, yOf(valueAt(S.sm, cc, k))));
      if (k === 0) g.moveTo(px, yy); else g.lineTo(px, yy);
    }
    g.stroke();

    // ピークホールド
    g.globalAlpha = 0.6; g.strokeStyle = C.peak; g.lineWidth = Math.max(1, d);
    g.beginPath();
    for (k = 0; k < cc.m; k++) {
      px = L + k * cc.step; var yp = Math.min(top, Math.max(T, yOf(valueAt(S.pk, cc, k))));
      if (k === 0) g.moveTo(px, yp); else g.lineTo(px, yp);
    }
    g.stroke();
    g.restore();

    // 検出した周波数のマーカー
    var list = entries.slice().sort(function (a, b) { return a.f - b.f; });
    g.font = '700 ' + Math.round(11 * d) + 'px ' + MONO;
    for (var i = 0; i < list.length; i++) {
      var e = list[i], mx = Math.round(xOf(e.f)) + 0.5;
      var age = S.clock - e.last;
      var alpha = e.live || cfg.hold === 0 ? 1 : Math.max(0.4, 1 - 0.6 * age / cfg.hold);
      var col = e.sev === 2 ? C.danger : C.warn;
      g.globalAlpha = alpha; g.strokeStyle = col; g.lineWidth = Math.max(1.5, 1.5 * d);
      g.setLineDash([4 * d, 4 * d]);
      g.beginPath(); g.moveTo(mx, T); g.lineTo(mx, T + ph); g.stroke();
      g.setLineDash([]);
      var txt = Core.fmtHzShort(e.f), tw2 = g.measureText(txt).width + 10 * d, bh = 15 * d;
      var bx = Math.min(W - R - tw2, Math.max(L, mx - tw2 / 2)), by = T + 2 * d + (i % 3) * (bh + 2 * d);
      rr(g, bx, by, tw2, bh, 4 * d); g.fillStyle = col; g.fill();
      g.fillStyle = '#1a0505'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(txt, bx + tw2 / 2, by + bh / 2 + 0.5 * d);
    }
    g.globalAlpha = 1;
  }

  var BAR_LO = -70, BAR_HI = 0;
  /** S: {bar, tick, level}, off: 校正オフセット(dB) */
  function drawBar(canvas, S, off) {
    var g = canvas.getContext('2d'), d = fit(canvas), W = canvas.width, H = canvas.height;
    g.clearRect(0, 0, W, H);
    var gap = Math.max(1, Math.round(2 * d)), segW = Math.round(6 * d), segH = Math.round(H * 0.5), y0 = Math.round(2 * d);
    var n = Math.max(1, Math.floor((W + gap) / (segW + gap)));
    var total = n * (segW + gap) - gap, x0 = Math.round((W - total) / 2);
    var step = (BAR_HI - BAR_LO) / n;
    var val = S.level === null ? -999 : S.bar;
    var kt = S.level === null ? -1 : Math.min(n - 1, Math.floor((S.tick - BAR_LO) / step));
    for (var k = 0; k < n; k++) {
      var lv = BAR_LO + k * step;
      var col = lv < -18 ? C.ok : lv < -6 ? C.warn : C.danger;
      var lit = val >= lv + 0.01;
      g.globalAlpha = lit ? 1 : 0.14; g.fillStyle = col;
      if (k === kt && S.tick > BAR_LO) { g.globalAlpha = 1; g.fillStyle = C.peak; }
      g.fillRect(x0 + k * (segW + gap), y0, segW, segH);
    }
    g.globalAlpha = 1; g.fillStyle = C.dim; g.textAlign = 'center'; g.textBaseline = 'alphabetic';
    g.font = Math.round(10 * d) + 'px ' + MONO;
    [-60, -40, -20, -10, 0].forEach(function (lev) {
      var x = x0 + (lev - BAR_LO) / (BAR_HI - BAR_LO) * total;
      var s = String(Math.round(lev + off));
      var tw = g.measureText(s).width;
      var xx = Math.min(W - tw / 2, Math.max(tw / 2, x));
      g.fillText(s, xx, H - 3 * d);
    });
  }

  window.HS = { C: C, drawSpec: drawSpec, drawBar: drawBar };
})();
