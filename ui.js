// 設定・DOM・検出リスト・警告表示。状態 S と検出器 det をここで作る。
(function () {
  'use strict';
  var Core = window.HowlCore, HS = window.HS;
  var $ = function (id) { return document.getElementById(id); };
  var FFT = 8192, NBIN = FFT / 2, KEY = 'howlscope.v1';

  var DEF = { prom: 14, floor: -70, hold: 30, dbMin: -100, weight: 'A', flash: true, cal: null };
  function loadCfg() {
    var o = {};
    try { o = JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { o = {}; }
    var c = {};
    Object.keys(DEF).forEach(function (k) { c[k] = (o[k] !== undefined && o[k] !== null) || k === 'cal' ? o[k] : DEF[k]; });
    if (c.cal === undefined || (c.cal !== null && !isFinite(c.cal))) c.cal = null;
    ['prom', 'floor', 'hold', 'dbMin'].forEach(function (k) { c[k] = +c[k]; if (!isFinite(c[k])) c[k] = DEF[k]; });
    if (['A', 'C', 'Z'].indexOf(c.weight) < 0) c.weight = 'A';
    c.flash = c.flash !== false;
    return c;
  }
  var cfg = loadCfg();
  function save() { try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch (e) {} }

  var detCfg = { fmin: 100, fmax: 16000, prom: cfg.prom, floor: cfg.floor, tWatch: 0.35, tDanger: 0.6, hold: cfg.hold };
  var det = Core.createDetector(detCfg);

  var S = {
    mode: 'idle', ctx: null, an: null, src: null, stream: null, wake: null, raf: 0,
    binHz: 48000 / FFT, n: NBIN, raw: null, td: null,
    spec: new Float32Array(NBIN), sm: new Float32Array(NBIN), pk: new Float32Array(NBIN), pkT: new Float64Array(NBIN),
    wA: null, wC: null, has: false, clock: 0, t0: null, lastT: 0,
    level: null, slow: null, bar: -999, tick: -999, tickT: 0, max: -Infinity,
    peakDb: -Infinity, peakT: 0, clipUntil: 0, lastText: 0, lastList: 0
  };
  S.sm.fill(-200); S.pk.fill(-200);

  var ui = {};
  ['status', 'statusText', 'lvl', 'unit', 'peak', 'peakWrap', 'max', 'bar', 'spec', 'list', 'empty', 'hold', 'clear',
    'go', 'demo', 'err', 'banner', 'bannerF', 'bannerSub', 'flash', 'sens', 'sensV', 'floor', 'floorV', 'dbmin',
    'flashOn', 'calRef', 'calSet', 'calClear', 'calState', 'inState', 'resetMax'].forEach(function (id) { ui[id] = $(id); });

  function setText(el, s) { if (el.textContent !== s) el.textContent = s; }
  function fmtDb(v) { return isFinite(v) ? v.toFixed(1).replace('-', '−') : '--.-'; }
  function offset() { return cfg.cal === null ? 0 : cfg.cal; }

  function setStatus(kind, text) { ui.status.setAttribute('data-s', kind); setText(ui.statusText, text); }
  function showErr(msg) { ui.err.textContent = msg; ui.err.hidden = false; }
  function clearErr() { ui.err.hidden = true; ui.err.textContent = ''; }

  function refreshUnit() {
    setText(ui.unit, (cfg.cal === null ? 'dBFS' : 'dB SPL') + ' · ' + cfg.weight);
    if (cfg.cal === null) {
      setText(ui.calState, '未校正（dBFS表示）。騒音計などで測った1kHz付近の値を入力し、同じ音を鳴らしながら押します。');
    } else {
      setText(ui.calState, '校正済み（補正 ' + (cfg.cal >= 0 ? '+' : '−') + Math.abs(cfg.cal).toFixed(1) + ' dB）。目安としてお使いください。');
    }
  }

  function updateTexts(now) {
    var off = offset();
    setText(ui.lvl, S.level === null ? '--.-' : fmtDb(S.level + off));
    setText(ui.max, isFinite(S.max) ? fmtDb(S.max + off) : '--.-');
    setText(ui.peak, isFinite(S.peakDb) ? fmtDb(S.peakDb) : '--.-');
    ui.peakWrap.classList.toggle('clip', now < S.clipUntil);
  }

  // ---- 検出リスト ----
  var rows = new Map();
  function mkRow(e) {
    var li = document.createElement('li');
    li.dataset.id = e.id;
    li.innerHTML = '<span class="chip"></span><div><b class="hz"></b><span class="sub"></span></div>' +
      '<div class="rm"><span class="age"></span><button type="button" class="x" aria-label="この項目を削除">×</button></div>';
    return li;
  }
  function ageText(sec) {
    if (sec < 1) return 'いま';
    if (sec < 60) return Math.round(sec) + '秒前';
    return Math.floor(sec / 60) + '分前';
  }
  function syncList() {
    var ents = det.entries.slice().sort(function (a, b) { return (b.cur - a.cur) || (b.live - a.live) || (b.last - a.last); });
    var seen = {};
    ents.forEach(function (e, idx) {
      seen[e.id] = true;
      var li = rows.get(e.id);
      if (!li) { li = mkRow(e); rows.set(e.id, li); }
      var chip = li.querySelector('.chip');
      chip.className = 'chip ' + (e.sev === 2 ? 's2' : 's1');
      setText(chip, e.sev === 2 ? 'ハウリング' : 'しそう');
      setText(li.querySelector('.hz'), Core.fmtHz(e.f));
      setText(li.querySelector('.sub'), 'GEQ ' + Core.bandLabel(Core.nearestBand(e.f)) + ' · ピーク ' + fmtDb(e.peak) + ' dBFS');
      setText(li.querySelector('.age'), e.live ? 'いま' : ageText(S.clock - e.last));
      li.classList.toggle('live', !!e.live);
      if (ui.list.children[idx] !== li) ui.list.insertBefore(li, ui.list.children[idx] || null);
    });
    rows.forEach(function (li, id) { if (!seen[id]) { li.remove(); rows.delete(id); } });
    ui.empty.hidden = ents.length > 0;
  }

  // ---- 警告 ----
  var flashTimer = 0;
  function flash() {
    if (!cfg.flash) return;
    ui.flash.classList.remove('on'); void ui.flash.offsetWidth; ui.flash.classList.add('on');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(function () { ui.flash.classList.remove('on'); }, 1300);
  }
  function alertDanger() {
    flash();
    try { if (navigator.vibrate) navigator.vibrate([120, 60, 120]); } catch (e) {}
  }
  function syncBanner() {
    var live = S.mode === 'idle' ? [] : det.entries.filter(function (e) { return e.live && e.cur === 2; });
    if (!live.length) { ui.banner.hidden = true; return; }
    live.sort(function (a, b) { return b.lvl - a.lvl; });
    var top = live[0];
    setText(ui.bannerF, Core.fmtHz(top.f));
    setText(ui.bannerSub, 'GEQ ' + Core.bandLabel(Core.nearestBand(top.f)) + ' 付近' + (live.length > 1 ? '　ほか' + (live.length - 1) + '件' : ''));
    ui.banner.hidden = false;
  }

  // ---- 設定の操作 ----
  function initControls() {
    ui.sens.value = cfg.prom; ui.sensV.textContent = cfg.prom + ' dB';
    ui.floor.value = cfg.floor; ui.floorV.textContent = '−' + Math.abs(cfg.floor) + ' dBFS';
    ui.hold.value = String(cfg.hold); ui.dbmin.value = String(cfg.dbMin); ui.flashOn.checked = cfg.flash;
    ui.calRef.value = '';
    var btns = document.querySelectorAll('.seg button');
    function paintW() { btns.forEach(function (b) { b.setAttribute('aria-pressed', b.dataset.w === cfg.weight ? 'true' : 'false'); }); }
    paintW(); refreshUnit();

    ui.sens.addEventListener('input', function () { cfg.prom = detCfg.prom = +ui.sens.value; ui.sensV.textContent = cfg.prom + ' dB'; save(); });
    ui.floor.addEventListener('input', function () { cfg.floor = detCfg.floor = +ui.floor.value; ui.floorV.textContent = '−' + Math.abs(cfg.floor) + ' dBFS'; save(); });
    ui.hold.addEventListener('change', function () { cfg.hold = detCfg.hold = +ui.hold.value; save(); });
    ui.dbmin.addEventListener('change', function () { cfg.dbMin = +ui.dbmin.value; save(); HS.redraw(); });
    ui.flashOn.addEventListener('change', function () { cfg.flash = ui.flashOn.checked; save(); });
    btns.forEach(function (b) {
      b.addEventListener('click', function () { cfg.weight = b.dataset.w; S.max = -Infinity; S.slow = null; paintW(); refreshUnit(); save(); });
    });
    ui.resetMax.addEventListener('click', function () { S.max = -Infinity; S.peakDb = -Infinity; updateTexts(S.clock); });
    ui.clear.addEventListener('click', function () { det.clear(); syncList(); syncBanner(); HS.redraw(); });
    ui.list.addEventListener('click', function (ev) {
      var b = ev.target.closest ? ev.target.closest('.x') : null;
      if (!b) return;
      det.remove(+b.closest('li').dataset.id); syncList(); syncBanner(); HS.redraw();
    });
    ui.calSet.addEventListener('click', function () {
      var ref = parseFloat(ui.calRef.value);
      if (!isFinite(ref)) { ui.calState.textContent = '基準にする dB SPL の値を入力してください。'; return; }
      if (S.slow === null || !isFinite(S.slow)) { ui.calState.textContent = 'マイクを開始し、基準の音を鳴らしてから押してください。'; return; }
      cfg.cal = ref - S.slow; S.max = -Infinity; save(); refreshUnit();
    });
    ui.calClear.addEventListener('click', function () { cfg.cal = null; S.max = -Infinity; save(); refreshUnit(); });
  }

  HS.cfg = cfg; HS.det = det; HS.S = S; HS.ui = ui; HS.FFT = FFT;
  HS.setStatus = setStatus; HS.showErr = showErr; HS.clearErr = clearErr;
  HS.updateTexts = updateTexts; HS.syncList = syncList; HS.syncBanner = syncBanner;
  HS.alertDanger = alertDanger; HS.offset = offset; HS.initControls = initControls;
})();
