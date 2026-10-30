// マイク入力・デモ信号・メインループ
(function () {
  'use strict';
  var Core = window.HowlCore, HS = window.HS;
  var S = HS.S, ui = HS.ui, cfg = HS.cfg, det = HS.det, FFT = HS.FFT;
  var TONE = Core.TONE_OFFSET, LN10_10 = Math.LN10 / 10;

  // ---- A特性・C特性（各ビンの電力ウェイト）----
  function buildWeights() {
    var n = S.n, wA = new Float32Array(n), wC = new Float32Array(n);
    for (var i = 1; i < n; i++) {
      var f = i * S.binHz, f2 = f * f, c = 12194 * 12194;
      var ra = (c * f2 * f2) / ((f2 + 20.6 * 20.6) * Math.sqrt((f2 + 107.7 * 107.7) * (f2 + 737.9 * 737.9)) * (f2 + c));
      var rc = (c * f2) / ((f2 + 20.6 * 20.6) * (f2 + c));
      wA[i] = Math.pow(10, (20 * Math.log10(ra) + 2.0) / 10);
      wC[i] = Math.pow(10, (20 * Math.log10(rc) + 0.06) / 10);
    }
    S.wA = wA; S.wC = wC;
  }

  // ---- 入力 ----
  function readMic() {
    var raw = S.raw, td = S.td, spec = S.spec, n = S.n, i;
    S.an.getFloatFrequencyData(raw);
    S.an.getFloatTimeDomainData(td);
    for (i = 0; i < n; i++) { var v = raw[i]; if (!(v > -160)) v = -160; spec[i] = v + TONE; }
    var ss = 0, pk = 0;
    for (i = 0; i < td.length; i++) { var x = td[i], a = x < 0 ? -x : x; ss += x * x; if (a > pk) pk = a; }
    return { rms: Math.sqrt(ss / td.length), peak: pk };
  }

  // デモ用の合成スペクトル（正弦波ピーク換算dBFS）
  function addTone(spec, b, f0, L) {
    if (L < -110) return;
    var c = f0 / b, i0 = Math.floor(c) - 6;
    for (var i = i0; i <= i0 + 13; i++) {
      if (i < 1 || i >= spec.length) continue;
      var d = Math.abs(i - c), att = d < 3 ? 3 * d * d : 27 + (d - 3) * 10, v = L - att;
      if (v > spec[i]) spec[i] = v;
    }
  }
  function addBump(spec, b, fc, db) {
    var i0 = Math.floor(fc / 3 / b), i1 = Math.ceil(fc * 3 / b);
    for (var i = i0; i <= i1; i++) {
      if (i < 1 || i >= spec.length) continue;
      var x = Math.log2(i * b / fc), v = db - 18 * x * x + (Math.random() - 0.5) * 6;
      if (v > spec[i]) spec[i] = v;
    }
  }
  function readDemo(t) {
    var spec = S.spec, n = S.n, b = S.binHz, i, c = t % 18;
    for (i = 0; i < n; i++) {
      var f = Math.max(i, 1) * b;
      spec[i] = -90 - 4 * Math.log2(f / 1000) + (Math.random() + Math.random() + Math.random() - 1.5) * 5;
    }
    var m = 0.5 + 0.5 * Math.sin(t * 1.7);
    addBump(spec, b, 500, -70 + 8 * m); addBump(spec, b, 1600, -76 + 6 * m); addBump(spec, b, 3200, -80 + 5 * m);
    if (c >= 12 && c < 17) {
      for (var h = 1; h <= 14; h++) addTone(spec, b, 190 * h * (1 + 0.003 * Math.sin(t * 6)), -48 - 3 * Math.log2(h));
    }
    // 1.1kHz: ゆっくり上がって止まる（しそう）
    if (c >= 1 && c < 8) addTone(spec, b, 1100, Math.min(-53, -76 + (c - 1) * 5.5));
    // 2.48kHz: 急に育つ（ハウリング）。10秒でフェーダーを下げた想定
    if (c >= 3 && c < 11) addTone(spec, b, 2480, c < 7 ? -78 + (c - 3) * 15 : c < 10 ? -18 : -18 - (c - 10) * 60);
    var s = 0;
    for (i = 0; i < n; i++) s += Math.exp(spec[i] * LN10_10);
    var rms = Math.pow(10, (10 * Math.log10(s) - 6.3) / 20);
    return { rms: rms, peak: Math.min(1, rms * 4) };
  }

  function levels(rms, peak) {
    var rmsDb = 20 * Math.log10(Math.max(rms, 1e-7)), w = 0;
    if (cfg.weight !== 'Z') {
      var wt = cfg.weight === 'A' ? S.wA : S.wC, spec = S.spec, sp = 0, sw = 0;
      for (var i = 1; i < S.n; i++) { var p = Math.exp(spec[i] * LN10_10); sp += p; sw += p * wt[i]; }
      if (sp > 0 && sw > 0) w = 10 * Math.log10(sw / sp);
    }
    return { lvl: rmsDb + w, peakDb: 20 * Math.log10(Math.max(peak, 1e-7)) };
  }

  // ---- 毎フレーム ----
  function loop(ts) {
    if (S.mode === 'idle') return;
    var now = ts / 1000;
    if (S.t0 === null) { S.t0 = now; S.lastT = now; }
    var dt = Math.min(0.1, Math.max(0, now - S.lastT)); S.lastT = now; S.clock = now;

    var r = S.mode === 'mic' ? readMic() : readDemo(now - S.t0);
    var spec = S.spec, sm = S.sm, pk = S.pk, pkT = S.pkT, n = S.n, i;

    var a = 1 - Math.exp(-dt / 0.1);
    for (i = 0; i < n; i++) {
      var v = spec[i], s = sm[i];
      sm[i] = v > s ? v : s + (v - s) * a;
      if (v >= pk[i]) { pk[i] = v; pkT[i] = now; }
      else if (now - pkT[i] > 4) pk[i] = Math.max(v, pk[i] - 10 * dt);
    }
    S.has = true;

    var events = det.step(spec, S.binHz, now);
    for (i = 0; i < events.length; i++) if (events[i].type === 'danger') HS.alertDanger();

    var L = levels(r.rms, r.peak);
    S.level = L.lvl;
    S.slow = S.slow === null || !isFinite(S.slow) ? L.lvl : S.slow + (L.lvl - S.slow) * (1 - Math.exp(-dt / 0.5));
    if (L.lvl > S.bar) S.bar = L.lvl; else S.bar = Math.max(L.lvl, S.bar - 28 * dt);
    if (L.lvl >= S.tick) { S.tick = L.lvl; S.tickT = now; }
    else if (now - S.tickT > 1.5) S.tick = Math.max(L.lvl, S.tick - 18 * dt);
    if (L.lvl > S.max) S.max = L.lvl;
    if (L.peakDb >= S.peakDb || now - S.peakT > 2) { S.peakDb = L.peakDb; S.peakT = now; }
    if (L.peakDb >= -0.5) S.clipUntil = now + 2;

    if (now - S.lastText > 0.1) { S.lastText = now; HS.updateTexts(now); }
    if (now - S.lastList > 0.2) { S.lastList = now; HS.syncList(); HS.syncBanner(); }
    redraw();
    S.raf = requestAnimationFrame(loop);
  }

  function redraw() {
    HS.drawSpec(ui.spec, S, cfg, det.entries);
    HS.drawBar(ui.bar, S, HS.offset());
  }
  HS.redraw = redraw;

  // ---- 画面を消さない ----
  function getWake() {
    try {
      if (navigator.wakeLock && S.mode !== 'idle' && !S.wake) {
        navigator.wakeLock.request('screen').then(function (l) {
          S.wake = l; l.addEventListener('release', function () { S.wake = null; });
        }).catch(function () {});
      }
    } catch (e) {}
  }
  function releaseWake() { try { if (S.wake) S.wake.release(); } catch (e) {} S.wake = null; }

  function resetState() {
    S.level = null; S.slow = null; S.bar = -999; S.tick = -999; S.peakDb = -Infinity; S.t0 = null;
    S.sm.fill(-200); S.pk.fill(-200); S.pkT.fill(0); S.has = false; det.resetTracks();
  }

  function setRunning(mode) {
    S.mode = mode;
    ui.go.textContent = '停止'; ui.go.classList.add('stop'); ui.demo.disabled = true;
    HS.setStatus(mode === 'mic' ? 'run' : 'demo', mode === 'mic' ? '計測中' : 'デモ中');
    getWake();
    S.raf = requestAnimationFrame(loop);
  }

  function stopAll(msg) {
    S.mode = 'idle';
    cancelAnimationFrame(S.raf);
    if (S.stream) S.stream.getTracks().forEach(function (t) { t.stop(); });
    S.stream = null; S.src = null; S.an = null;
    if (S.ctx) { try { S.ctx.close(); } catch (e) {} }
    S.ctx = null;
    releaseWake();
    ui.go.textContent = 'マイク開始'; ui.go.classList.remove('stop'); ui.demo.disabled = false;
    HS.setStatus('idle', '待機中');
    if (msg) HS.showErr(msg);
    HS.updateTexts(S.clock); HS.syncList(); HS.syncBanner(); redraw();
  }

  function micError(e) {
    var name = e && e.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') return 'マイクの使用が許可されていません。ブラウザのサイト設定でマイクを許可してから、もう一度開始してください。';
    if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'マイクが見つかりません。';
    if (name === 'NotReadableError') return 'マイクを使えません。ほかのアプリが使用中の可能性があります。';
    return 'マイクを開始できませんでした（' + (name || '原因不明') + '）。';
  }

  function startMic() {
    HS.clearErr();
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      HS.showErr('このページではマイクを使えません。HTTPSで公開したURLをSafariで開いてください（ファイルを直接開いた場合は動きません）。');
      return;
    }
    HS.setStatus('busy', '接続中…');
    var AC = window.AudioContext || window.webkitAudioContext, ctx;
    try { ctx = new AC({ latencyHint: 'interactive' }); } catch (e) { ctx = new AC(); }
    var resumed = ctx.resume ? ctx.resume() : Promise.resolve();
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
      .then(function (stream) {
        return Promise.resolve(resumed).then(function () { return stream; });
      })
      .then(function (stream) {
        var an = ctx.createAnalyser();
        an.fftSize = FFT; an.smoothingTimeConstant = 0;
        var src = ctx.createMediaStreamSource(stream);
        src.connect(an); // destination へは繋がない（スピーカーに出すとハウリングするため）
        S.ctx = ctx; S.an = an; S.src = src; S.stream = stream;
        S.binHz = ctx.sampleRate / FFT; S.n = an.frequencyBinCount;
        S.raw = new Float32Array(S.n); S.td = new Float32Array(an.fftSize);
        buildWeights(); resetState();
        var track = stream.getAudioTracks()[0];
        track.addEventListener('ended', function () { stopAll('マイク入力が切断されました。'); });
        var st = track.getSettings ? track.getSettings() : {};
        function onoff(v) { return v === false ? 'OFF' : v === true ? 'ON' : '不明'; }
        var bad = st.echoCancellation === true || st.noiseSuppression === true || st.autoGainControl === true;
        ui.inState.textContent = 'AGC ' + onoff(st.autoGainControl) + ' / ノイズ抑制 ' + onoff(st.noiseSuppression) + ' / エコー除去 ' + onoff(st.echoCancellation) +
          (bad ? '（iPhone側の補正が効いていると、測定値が実際とずれます）' : '') + '　サンプルレート ' + ctx.sampleRate + ' Hz';
        ctx.onstatechange = function () {
          if (S.mode !== 'mic') return;
          if (ctx.state === 'running') HS.setStatus('run', '計測中');
          else HS.setStatus('busy', '中断中…');
        };
        setRunning('mic');
      })
      .catch(function (e) {
        try { ctx.close(); } catch (x) {}
        HS.setStatus('idle', '待機中');
        HS.showErr(micError(e));
      });
  }

  function startDemo() {
    HS.clearErr();
    S.binHz = 48000 / FFT; S.n = FFT / 2;
    buildWeights(); resetState();
    setRunning('demo');
  }

  ui.go.addEventListener('click', function () { if (S.mode === 'idle') startMic(); else stopAll(); });
  ui.demo.addEventListener('click', function () { if (S.mode === 'idle') startDemo(); });

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible' || S.mode === 'idle') return;
    getWake();
    if (S.ctx && S.ctx.state !== 'running' && S.ctx.resume) S.ctx.resume().catch(function () {});
  });
  if (window.ResizeObserver) new ResizeObserver(function () { redraw(); }).observe(document.body);
  else window.addEventListener('resize', redraw);

  buildWeights();
  HS.initControls();
  redraw();
})();
