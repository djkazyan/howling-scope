// ハウリング検出コア（DOM非依存）。ブラウザでは <script src="core.js">、テストでは Node から読み込む。
(function (root) {
  'use strict';

  // Blackman窓＋1/N正規化のFFT値に足すと、正弦波のピーク値(dBFS)に近い値になる
  var TONE_OFFSET = 13.56;

  var ISO_BANDS = [20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800,
    1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000];

  function nearestBand(f) {
    var best = 0, bd = Infinity;
    for (var i = 0; i < ISO_BANDS.length; i++) {
      var d = Math.abs(Math.log2(f / ISO_BANDS[i]));
      if (d < bd) { bd = d; best = i; }
    }
    return ISO_BANDS[best];
  }

  function trimNum(x, d) {
    var s = x.toFixed(d);
    if (s.indexOf('.') >= 0) s = s.replace(/\.?0+$/, '');
    return s;
  }
  function bandLabel(v) { return v >= 1000 ? trimNum(v / 1000, 2) + 'k' : String(v); }
  function fmtHz(f) { return f < 1000 ? Math.round(f) + ' Hz' : trimNum(f / 1000, f < 10000 ? 2 : 1) + ' kHz'; }
  function fmtHzShort(f) { return f < 1000 ? String(Math.round(f)) : trimNum(f / 1000, f < 10000 ? 2 : 1) + 'k'; }

  // ピークが周囲（±5〜16ビン）の平均(dB)よりどれだけ突出しているか
  function promAt(spec, i) {
    var n = spec.length, s = 0, c = 0;
    for (var k = 5; k <= 16; k++) {
      var a = i - k, b = i + k;
      if (a >= 1) { s += spec[a]; c++; }
      if (b < n - 1) { s += spec[b]; c++; }
    }
    if (c < 8) return 0;
    return spec[i] - s / c;
  }

  // ピーク頂点から-10dB以内に収まる幅（ビン数）。単音は3〜4、広がった山や帯域ノイズはそれより広い
  function peakWidth(spec, i, v) {
    var th = v - 10, w = 1, k;
    for (k = 1; k <= 10 && spec[i - k] >= th; k++) w++;
    for (k = 1; k <= 10 && spec[i + k] >= th; k++) w++;
    return w;
  }

  // 直近の履歴から上昇率(dB/秒)を推定
  function slopeOf(h) {
    if (h.length < 6) return 0;
    var span = h[h.length - 1].t - h[0].t;
    if (span < 0.45) return 0;
    var k = Math.max(2, h.length >> 2), a = 0, b = 0, ta = 0, tb = 0;
    for (var j = 0; j < k; j++) {
      a += h[j].v; ta += h[j].t;
      b += h[h.length - 1 - j].v; tb += h[h.length - 1 - j].t;
    }
    return (b - a) / (tb - ta);
  }

  // 直近0.8秒の中で、いまのレベルが最小値よりどれだけ上がっているか(dB)
  function growthOf(h) {
    if (h.length < 6 || h[h.length - 1].t - h[0].t < 0.4) return 0;
    var mn = Infinity, j;
    for (j = 0; j < h.length - 3; j++) if (h[j].v < mn) mn = h[j].v;
    var cur = (h[h.length - 1].v + h[h.length - 2].v + h[h.length - 3].v) / 3;
    return cur - mn;
  }

  // 声や楽器の倍音列に見えるか（等間隔のピーク列、または2倍・3倍・1/2・1/3の相手がいる）
  function isHarmonic(weak, k, binHz) {
    var w = weak[k], i = w.i;
    var minB = 60 / binHz, maxB = 900 / binHz;
    function eq(d1, d2) { return d1 >= minB && d1 <= maxB && Math.abs(d1 - d2) <= 2 + 0.05 * d1; }
    var L1 = weak[k - 1], L2 = weak[k - 2], R1 = weak[k + 1], R2 = weak[k + 2];
    if (L1 && R1 && eq(i - L1.i, R1.i - i)) return true;
    if (L1 && L2 && eq(i - L1.i, L1.i - L2.i)) return true;
    if (R1 && R2 && eq(R1.i - i, R2.i - R1.i)) return true;
    var rel = [2, 3, 0.5, 1 / 3];
    for (var r = 0; r < rel.length; r++) {
      var j0 = i * rel[r], tol = Math.max(3, 0.02 * j0);
      for (var q = 0; q < weak.length; q++) {
        var o = weak[q];
        if (o !== w && Math.abs(o.i - j0) <= tol && o.v >= w.v - 12) return true;
      }
    }
    return false;
  }

  /**
   * cfg: { fmin, fmax, prom(dB), floor(dBFS相当), tWatch(s), tDanger(s), hold(s, 0=無期限) }
   * step(spec, binHz, now): spec は「正弦波ピーク換算dBFS」のスペクトル。events を返す。
   */
  function createDetector(cfg) {
    var tracks = [], entries = [];
    var nextId = 1, frameNo = 0;

    function matchEntry(f, binHz) {
      var tol = Math.max(2.2 * binHz, 0.03 * f), best = null, bd = Infinity;
      for (var q = 0; q < entries.length; q++) {
        var d = Math.abs(entries[q].f - f);
        if (d <= tol && d < bd) { bd = d; best = entries[q]; }
      }
      return best;
    }

    function step(spec, binHz, now) {
      var events = [];
      frameNo++;
      var n = spec.length;
      var lo = Math.max(18, Math.ceil(cfg.fmin / binHz));
      var hi = Math.min(n - 18, Math.floor(cfg.fmax / binHz));
      var weakProm = Math.max(6, 0.55 * cfg.prom);
      var weak = [], cands = [], q, i;

      for (q = 0; q < entries.length; q++) entries[q].cur = 0;

      for (i = lo; i <= hi; i++) {
        var v = spec[i];
        if (v < cfg.floor - 6) continue;
        if (v <= spec[i - 1] || v < spec[i + 1] || v <= spec[i - 2] || v < spec[i + 2] ||
            v <= spec[i - 3] || v < spec[i + 3]) continue;
        var prom = promAt(spec, i);
        if (prom < weakProm) continue;
        weak.push({ i: i, v: v, prom: prom });
        if (v >= cfg.floor && prom >= cfg.prom && peakWidth(spec, i, v) <= 7) cands.push(weak.length - 1);
      }
      cands.sort(function (a, b) { return weak[b].prom - weak[a].prom; });
      if (cands.length > 40) cands.length = 40;

      for (var ci = 0; ci < cands.length; ci++) {
        var k = cands[ci], w = weak[k];
        var a = spec[w.i - 1], b = w.v, d = spec[w.i + 1];
        var den = a - 2 * b + d;
        var p = den < 0 ? 0.5 * (a - d) / den : 0;
        p = Math.max(-0.5, Math.min(0.5, p));
        var f = (w.i + p) * binHz;

        var t = null, bd = Infinity;
        for (q = 0; q < tracks.length; q++) {
          var tr = tracks[q];
          if (tr.fn === frameNo) continue;
          var db = Math.abs(tr.i - w.i);
          if (db <= 2 && db < bd) { bd = db; t = tr; }
        }
        if (!t) {
          t = { id: nextId++, first: now, i: w.i, f: f, lvl: b, prom: w.prom, hist: [], fn: 0, last: now,
                slope: 0, rise: 0, top: b };
          tracks.push(t);
        } else {
          t.f = t.f * 0.7 + f * 0.3;
          t.lvl = t.lvl * 0.6 + b * 0.4;
          t.prom = t.prom * 0.6 + w.prom * 0.4;
        }
        t.fn = frameNo; t.last = now; t.i = w.i;
        t.hist.push({ t: now, v: b });
        while (t.hist.length && now - t.hist[0].t > 0.8) t.hist.shift();
        t.slope = slopeOf(t.hist);
        t.rise = Math.max(t.rise, growthOf(t.hist));
        if (t.lvl > t.top) t.top = t.lvl;

        // 「ハウリング」は、レベルが育った細いピークだけ。一定のまま鳴り続ける音は「しそう」止まり
        var dur = now - t.first;
        var blocked = isHarmonic(weak, k, binHz) && t.slope < 6;
        var grew = t.rise >= cfg.riseDb && t.lvl >= t.top - 8;
        var sev = 0;
        if (!blocked) {
          if (dur >= cfg.tWatch && t.prom >= cfg.prom) sev = 1;
          if (grew && dur >= cfg.tDanger && t.prom >= cfg.prom) sev = 2;
        }
        t.sev = sev;
        if (sev === 0) continue;

        var e = matchEntry(t.f, binHz);
        if (!e) {
          e = { id: nextId++, f: t.f, peak: t.lvl, lvl: t.lvl, sev: 0, first: now, last: now,
                live: true, cur: 0, alerted: false, count: 1 };
          entries.push(e);
        } else if (now - e.last > 1.0) {
          e.sev = 0; e.alerted = false; e.count++;
        }
        e.f = e.f * 0.8 + t.f * 0.2;
        e.lvl = t.lvl;
        if (t.lvl > e.peak) e.peak = t.lvl;
        e.last = now;
        e.cur = Math.max(e.cur, sev);
        if (sev > e.sev) e.sev = sev;
        if (e.sev === 2 && !e.alerted) {
          e.alerted = true;
          events.push({ type: 'danger', id: e.id, f: e.f });
        }
      }

      for (q = tracks.length - 1; q >= 0; q--) if (now - tracks[q].last > 0.25) tracks.splice(q, 1);
      if (cfg.hold > 0) {
        for (q = entries.length - 1; q >= 0; q--) if (now - entries[q].last > cfg.hold) entries.splice(q, 1);
      }
      while (entries.length > 12) {
        var oi = 0;
        for (q = 1; q < entries.length; q++) if (entries[q].last < entries[oi].last) oi = q;
        entries.splice(oi, 1);
      }
      for (q = 0; q < entries.length; q++) entries[q].live = (now - entries[q].last) < 0.45;
      return events;
    }

    function remove(id) {
      for (var q = 0; q < entries.length; q++) if (entries[q].id === id) { entries.splice(q, 1); return; }
    }
    function clear() { entries.length = 0; tracks.length = 0; }
    function resetTracks() { tracks.length = 0; }

    return { cfg: cfg, entries: entries, step: step, remove: remove, clear: clear, resetTracks: resetTracks };
  }

  var api = {
    TONE_OFFSET: TONE_OFFSET, ISO_BANDS: ISO_BANDS, nearestBand: nearestBand, bandLabel: bandLabel,
    fmtHz: fmtHz, fmtHzShort: fmtHzShort, createDetector: createDetector
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HowlCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
