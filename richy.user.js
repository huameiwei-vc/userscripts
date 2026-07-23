// ==UserScript==
// @name         Richy
// @namespace    https://avjb.com/owner-security-test
// @version      3.3.0
// @author       BlueTeam-PoC
// @match        https://avjb.com/*
// @match        https://*.avjb.com/*
// @run-at       document-start
// @grant        none
// @icon         data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="%230b0d12"/><circle cx="32" cy="32" r="14" fill="%23e11d48"/><polygon points="28,24 42,32 28,40" fill="white"/></svg>
// @downloadURL  https://raw.githubusercontent.com/huameiwei-vc/userscripts/main/richy.user.js
// @updateURL    https://raw.githubusercontent.com/huameiwei-vc/userscripts/main/richy.user.js
// ==/UserScript==

(function () {
  'use strict';

  const log = (...a) => console.log('%c[Richy]', 'color:#fb7185;font-weight:bold', ...a);

  // ===== Early hooks: block timeLimit =====
  function installEarlyHooks() {
    const _add = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, listener, options) {
      if (type === 'timeupdate' && typeof listener === 'function') {
        try {
          const src = Function.prototype.toString.call(listener);
          if (/timeLimit|noplayer|getElementById\(\s*['"]player['"]\s*\)/i.test(src)) { return; }
        } catch (_) {}
      }
      return _add.call(this, type, listener, options);
    };

    const patchOn = (obj) => {
      if (!obj || !obj.on || obj.__avjbPatched) return;
      const raw = obj.on.bind(obj);
      obj.on = function (evt, fn) {
        if (evt === 'timeupdate' && typeof fn === 'function') {
          try {
            const src = Function.prototype.toString.call(fn);
            if (/timeLimit|noplayer/i.test(src)) { return obj; }
          } catch (_) {}
        }
        return raw(evt, fn);
      };
      obj.__avjbPatched = true;
    };

    const t = setInterval(() => {
      try { if (window.HlsJsPlayer?.prototype) patchOn(window.HlsJsPlayer.prototype); } catch (_) {}
    }, 50);
    setTimeout(() => clearInterval(t), 8000);
  }

  installEarlyHooks();

  // ===== Helpers =====
  function videoIdFromLocation() {
    return (location.pathname.match(/\/video\/(\d+)\//) || [])[1] ||
      (location.pathname.match(/\/newembed\/(\d+)/) || [])[1] || null;
  }

  function bucketOf(id) { return Math.floor(Number(id) / 1000) * 1000; }

  function extractM3u8(text) {
    if (!text) return null;
    for (const re of [/https?:\/\/list\.avstatic\.com\/[^'"\s\\]+\.m3u8/, /https?:\/\/[^'"\s\\]+\.m3u8[^'"\s\\]*/]) {
      const m = text.match(re);
      if (m) return m[0].replace(/\\u002F/g, '/').replace(/\\\//g, '/');
    }
    return null;
  }

  function extractFromPageScripts() {
    const text = Array.from(document.scripts).map(s => s.textContent || '').join('\n');
    return extractM3u8(text) || extractM3u8(document.documentElement.innerHTML);
  }

  async function fetchEmbedM3u8(videoId) {
    const url = `${location.origin}/newembed/${videoId}`;
    const res = await fetch(url, { credentials: 'omit', cache: 'no-store' });
    const html = await res.text();
    return { m3u8: extractM3u8(html), timeLimit: Number((html.match(/timeLimit\s*=\s*(\d+)/) || [])[1] || 0) };
  }

  async function buildOpenCdnPlaylistText(videoId, knownCount) {
    const bucket = bucketOf(videoId);
    let count = knownCount;
    if (!count) {
      let lo = 0, hi = 3000;
      const first = await fetch(`https://list.avstatic.com/cdn/videos/${bucket}/${videoId}/0000.jpg`, { method: 'HEAD' });
      if (!first.ok) throw new Error('CDN not accessible');
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        const r = await fetch(`https://list.avstatic.com/cdn/videos/${bucket}/${videoId}/${String(mid).padStart(4,'0')}.jpg`, { method: 'HEAD' });
        if (r.ok) lo = mid; else hi = mid - 1;
      }
      count = lo + 1;
    }
    let body = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n';
    for (let i = 0; i < count; i++) {
      body += '#EXTINF:2.000000,\n';
      body += `https://list.avstatic.com/cdn/videos/${bucket}/${videoId}/${String(i).padStart(4,'0')}.jpg\n`;
    }
    body += '#EXT-X-ENDLIST\n';
    return { count, text: body };
  }

  async function probePlaylist(m3u8) {
    try {
      const text = await (await fetch(m3u8)).text();
      const durs = text.split('\n').filter(l => l.startsWith('#EXTINF:')).map(l => parseFloat(l.split(':')[1]));
      return { segs: durs.length, totalSec: Math.round(durs.reduce((a, b) => a + b, 0)) };
    } catch (e) { return { error: String(e) }; }
  }

  function wipeOfficialPlayer() {
    ['#layer2','.no-player','.paywall-v2','.paywall-guest','.player-wrap','#new','#kt_player','.fp-player']
      .forEach(sel => document.querySelectorAll(sel).forEach(el => el.style.setProperty('display','none','important')));
    try { if (window.player?.api) { window.player.api('pause'); window.player.api('stop'); } } catch(_){}
  }

  // ===== iframe srcdoc — 带滑动手势的播放器 =====
  function buildSrcdoc(m3u8Source) {
    const initScript = m3u8Source.type === 'url'
      ? `var m3u8Url = ${JSON.stringify(m3u8Source.value)};`
      : `var m3u8Text = ${JSON.stringify(m3u8Source.value)};
         var m3u8Url = URL.createObjectURL(new Blob([m3u8Text], {type:'application/vnd.apple.mpegurl'}));`;

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<style>
* { margin:0; padding:0; box-sizing:border-box; }
html, body { width:100%; height:100%; background:#000; overflow:hidden; touch-action:none; }
#wrap { position:relative; width:100%; height:100%; }
video { width:100%; height:100%; object-fit:contain; }

/* 滑动手势提示 */
#seek-hint {
  display:none; position:absolute; top:50%; left:50%;
  transform:translate(-50%,-50%);
  background:rgba(0,0,0,0.75); color:#fff;
  padding:10px 20px; border-radius:10px;
  font:600 18px/1.4 system-ui,sans-serif;
  pointer-events:none; z-index:100;
  white-space:nowrap;
}
#seek-hint.show { display:block; }

/* 进度条 */
#progress-bar {
  position:absolute; bottom:0; left:0; right:0;
  height:40px; display:flex; align-items:center;
  padding:0 12px; gap:8px;
  background:linear-gradient(transparent, rgba(0,0,0,0.8));
  z-index:50; opacity:1; transition:opacity 0.3s;
}
#progress-bar.hidden { opacity:0; pointer-events:none; }
#progress-bar input[type=range] {
  -webkit-appearance:none; appearance:none;
  flex:1; height:4px; background:rgba(255,255,255,0.3);
  border-radius:2px; outline:none; margin:0;
}
#progress-bar input[type=range]::-webkit-slider-thumb {
  -webkit-appearance:none; width:16px; height:16px;
  background:#e11d48; border-radius:50%; border:none;
}
#progress-bar input[type=range]::-moz-range-thumb {
  width:16px; height:16px; background:#e11d48; border-radius:50%; border:none;
}
#time-label { color:#fff; font:11px/1 monospace; white-space:nowrap; }
</style>
</head>
<body>
<div id="wrap">
  <video id="v" playsinline></video>
  <div id="seek-hint"></div>
  <div id="progress-bar">
    <input type="range" id="seek" min="0" max="10000" value="0" step="1">
    <span id="time-label">0:00</span>
  </div>
</div>
<script>
${initScript}

var video = document.getElementById('v');
var hint = document.getElementById('seek-hint');
var seekBar = document.getElementById('seek');
var timeLabel = document.getElementById('time-label');
var progressBar = document.getElementById('progress-bar');

// ====== 格式化时间 ======
function fmt(s) {
  if (!isFinite(s) || s < 0) s = 0;
  var h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = Math.floor(s%60);
  if (h) return h+':'+String(m).padStart(2,'0')+':'+String(sec).padStart(2,'0');
  return m+':'+String(sec).padStart(2,'0');
}

// ====== 进度条同步 ======
var dragging = false;
video.addEventListener('timeupdate', function() {
  if (dragging) return;
  var d = video.duration || 1;
  seekBar.value = Math.round((video.currentTime / d) * 10000);
  timeLabel.textContent = fmt(video.currentTime) + ' / ' + fmt(d);
});
seekBar.addEventListener('input', function() { dragging = true; });
seekBar.addEventListener('change', function() {
  video.currentTime = (seekBar.value / 10000) * (video.duration || 0);
  dragging = false;
});

// ====== 滑动手势：左右滑 = 快进/快退 ======
var touchStartX = 0, touchStartY = 0, touchStartTime = 0;
var isSeeking = false, seekDelta = 0;

document.getElementById('wrap').addEventListener('touchstart', function(e) {
  // 如果触摸在进度条区域，不拦截
  if (e.target === seekBar || e.target.closest('#progress-bar')) return;
  var t = e.touches[0];
  touchStartX = t.clientX;
  touchStartY = t.clientY;
  touchStartTime = video.currentTime;
  isSeeking = false;
  seekDelta = 0;
}, {passive: true});

document.getElementById('wrap').addEventListener('touchmove', function(e) {
  if (e.target === seekBar || e.target.closest('#progress-bar')) return;
  var t = e.touches[0];
  var dx = t.clientX - touchStartX;
  var dy = t.clientY - touchStartY;

  // 水平移动 > 垂直移动的 1.5 倍才算横滑
  if (Math.abs(dx) > 15 && Math.abs(dx) > Math.abs(dy) * 1.5) {
    e.preventDefault();
    isSeeking = true;
    // 滑动灵敏度：屏幕宽度 = 视频总时长的 1/3（最多）
    var screenW = window.innerWidth || 360;
    var maxSeek = Math.min(video.duration * 0.33, 120); // 最多跳120秒
    seekDelta = (dx / screenW) * maxSeek;

    var target = Math.max(0, Math.min(video.duration, touchStartTime + seekDelta));
    hint.textContent = (seekDelta >= 0 ? '+' : '') + Math.round(seekDelta) + 's → ' + fmt(target);
    hint.classList.add('show');
  }
}, {passive: false});

document.getElementById('wrap').addEventListener('touchend', function(e) {
  if (isSeeking) {
    var target = Math.max(0, Math.min(video.duration, touchStartTime + seekDelta));
    video.currentTime = target;
    hint.classList.remove('show');
    isSeeking = false;
  }
}, {passive: true});

// ====== 单击暂停/播放 ======
var lastTap = 0;
video.addEventListener('click', function() {
  var now = Date.now();
  if (now - lastTap < 300) return; // 忽略双击
  lastTap = now;
  setTimeout(function() {
    if (Date.now() - lastTap >= 280) {
      if (video.paused) video.play(); else video.pause();
    }
  }, 300);
});

// ====== 自动隐藏进度条 ======
var hideTimer;
function showControls() {
  progressBar.classList.remove('hidden');
  clearTimeout(hideTimer);
  hideTimer = setTimeout(function(){ progressBar.classList.add('hidden'); }, 3000);
}
video.addEventListener('play', showControls);
video.addEventListener('pause', function(){ progressBar.classList.remove('hidden'); clearTimeout(hideTimer); });
document.getElementById('wrap').addEventListener('touchstart', showControls, {passive:true});

// ====== 加载视频 ======
function tryHls() {
  var s = document.createElement('script');
  s.src = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.7/dist/hls.min.js';
  s.onload = function() {
    if (Hls.isSupported()) {
      var hls = new Hls({enableWorker:true, maxBufferLength:60});
      hls.loadSource(m3u8Url);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, function(){ video.play().catch(function(){}); });
    } else { fallback(); }
  };
  s.onerror = fallback;
  document.head.appendChild(s);
}
function fallback() {
  video.src = m3u8Url;
  video.addEventListener('loadedmetadata', function(){ video.play().catch(function(){}); }, {once:true});
}
if (video.canPlayType('application/vnd.apple.mpegurl')) { fallback(); }
else { tryHls(); }
<\/script>
</body>
</html>`;
  }

  // ===== Mount =====
  function ensureMount() {
    let box = document.getElementById('richy-box');
    if (box) return box;

    const style = document.createElement('style');
    style.textContent = `
      #richy-box {
        position:relative; z-index:99990;
        margin:16px auto 20px; max-width:1100px;
        background:#0b0d12; border:1px solid rgba(255,255,255,0.08);
        border-radius:16px; overflow:hidden;
        box-shadow:0 18px 50px rgba(0,0,0,0.45);
        font-family:system-ui,sans-serif;
      }
      #richy-box .richy-head {
        display:flex; align-items:center; justify-content:space-between;
        padding:12px 14px; border-bottom:1px solid rgba(255,255,255,0.06);
      }
      #richy-box .richy-head h2 { margin:0; color:#fff; font:600 14px/1.2 system-ui; }
      #richy-box .richy-actions { display:flex; gap:8px; }
      #richy-box .richy-btn {
        border:1px solid rgba(255,255,255,0.15); border-radius:8px;
        padding:7px 12px; color:#fff; background:rgba(255,255,255,0.06);
        font:600 12px/1 system-ui; cursor:pointer;
      }
      #richy-box .richy-btn--p { border-color:transparent; background:#e11d48; }
      #richy-box iframe {
        width:100%; border:none; display:block; background:#000;
        aspect-ratio:16/9; max-height:75vh;
      }
      #richy-box .richy-error {
        display:none; padding:10px 14px; color:#fda4af; font:12px/1.4 system-ui;
      }
      #richy-box.has-error .richy-error { display:block; }
      @media (max-width:720px) {
        #richy-box { margin:10px 8px 16px; border-radius:12px; }
        #richy-box .richy-head { flex-direction:column; align-items:stretch; gap:8px; }
      }
    `;
    document.documentElement.appendChild(style);

    box = document.createElement('div');
    box.id = 'richy-box';
    box.innerHTML = `
      <header class="richy-head">
        <h2>完整播放</h2>
        <div class="richy-actions">
          <button type="button" class="richy-btn richy-btn--p" id="richy-replay">重播</button>
          <button type="button" class="richy-btn" id="richy-cdn">CDN 重建</button>
        </div>
      </header>
      <iframe id="richy-frame" allow="autoplay; fullscreen; encrypted-media" allowfullscreen sandbox="allow-scripts allow-same-origin"></iframe>
      <div class="richy-error" id="richy-error"></div>
    `;

    const mount =
      document.querySelector('.player-holder') ||
      document.querySelector('.player') ||
      document.querySelector('#video_title, h1, .headline') ||
      document.querySelector('main') ||
      document.body;

    if (mount && mount.parentElement && mount !== document.body) {
      mount.parentElement.insertBefore(box, mount);
    } else {
      document.body.prepend(box);
    }

    box.querySelector('#richy-replay').addEventListener('click', () => main({ force: true }));
    box.querySelector('#richy-cdn').addEventListener('click', () => main({ forceOpenCdn: true }));
    return box;
  }

  function showError(msg) {
    const box = document.getElementById('richy-box');
    const el = document.getElementById('richy-error');
    if (box && el) { box.classList.toggle('has-error', !!msg); el.textContent = msg || ''; }
  }

  function playFull(m3u8Source) {
    wipeOfficialPlayer();
    ensureMount();
    showError('');
    const frame = document.getElementById('richy-frame');
    frame.srcdoc = buildSrcdoc(m3u8Source);
    log('player loaded', m3u8Source.type);
  }

  // ===== Main =====
  async function main(opts = {}) {
    const videoId = videoIdFromLocation();
    if (!videoId) { log('not a video page'); return; }
    if (!document.body) await new Promise(r => document.addEventListener('DOMContentLoaded', r, { once: true }));

    try {
      let m3u8Url = null, probe = null;

      if (!opts.forceOpenCdn) {
        if (/\/newembed\//.test(location.pathname)) m3u8Url = extractFromPageScripts();
        if (!m3u8Url) {
          const emb = await fetchEmbedM3u8(videoId);
          m3u8Url = emb.m3u8;
          log('embed result', emb);
        }
        if (m3u8Url) {
          probe = await probePlaylist(m3u8Url);
          if (probe.totalSec && probe.totalSec <= 20) m3u8Url = null;
        }
      }

      if (m3u8Url && !opts.forceOpenCdn) {
        playFull({ type: 'url', value: m3u8Url });
        return;
      }

      const built = await buildOpenCdnPlaylistText(videoId, probe?.segs || null);
      log('CDN playlist', built.count, 'segs');
      playFull({ type: 'text', value: built.text });

    } catch (e) {
      log('error', e);
      ensureMount(); showError(String(e.message || e));
    }
  }

  if (/\/newembed\//.test(location.pathname) || /\/video\/\d+\//.test(location.pathname)) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => main());
      window.addEventListener('load', () => setTimeout(() => main(), 300));
    } else {
      main();
    }
  }

  window.__RICHY__ = { main, playFull, buildOpenCdnPlaylistText };
})();
