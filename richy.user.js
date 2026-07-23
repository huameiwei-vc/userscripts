// ==UserScript==
// @name         Richy
// @namespace    https://avjb.com/owner-security-test
// @version      3.2.0
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
          if (/timeLimit|noplayer|getElementById\(\s*['"]player['"]\s*\)/i.test(src)) {
            return;
          }
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

  // 返回 playlist 文本内容（不是 blob URL）
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

  // ===== Wipe original player =====
  function wipeOfficialPlayer() {
    ['#layer2','.no-player','.paywall-v2','.paywall-guest','.player-wrap','#new','#kt_player','.fp-player']
      .forEach(sel => document.querySelectorAll(sel).forEach(el => el.style.setProperty('display','none','important')));
    try { if (window.player?.api) { window.player.api('pause'); window.player.api('stop'); } } catch(_){}
  }

  // ===== iframe srcdoc 内容 =====
  // m3u8Source: { type: 'url', value: 'https://...' } 或 { type: 'text', value: '#EXTM3U...' }
  function buildSrcdoc(m3u8Source) {
    // 根据类型决定 iframe 里怎么拿 m3u8
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
html, body { width:100%; height:100%; background:#000; overflow:hidden; }
video { width:100%; height:100%; object-fit:contain; }
</style>
</head>
<body>
<video id="v" controls playsinline></video>
<script>
${initScript}

var video = document.getElementById('v');

function tryHls() {
  var s = document.createElement('script');
  s.src = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.7/dist/hls.min.js';
  s.onload = function() {
    if (Hls.isSupported()) {
      var hls = new Hls({ enableWorker:true, maxBufferLength:60 });
      hls.loadSource(m3u8Url);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, function(){ video.play().catch(function(){}); });
    } else {
      fallback();
    }
  };
  s.onerror = fallback;
  document.head.appendChild(s);
}

function fallback() {
  video.src = m3u8Url;
  video.addEventListener('loadedmetadata', function(){ video.play().catch(function(){}); }, {once:true});
}

// iOS Safari 原生支持 HLS，不需要 hls.js
if (video.canPlayType('application/vnd.apple.mpegurl')) {
  fallback();
} else {
  tryHls();
}
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

  // m3u8Source: { type:'url', value } 或 { type:'text', value }
  function playFull(m3u8Source) {
    wipeOfficialPlayer();
    ensureMount();
    showError('');

    const frame = document.getElementById('richy-frame');
    frame.srcdoc = buildSrcdoc(m3u8Source);
    log('iframe player loaded', m3u8Source.type);
  }

  // ===== Main =====
  async function main(opts = {}) {
    const videoId = videoIdFromLocation();
    if (!videoId) { log('not a video page'); return; }
    if (!document.body) await new Promise(r => document.addEventListener('DOMContentLoaded', r, { once: true }));

    try {
      let m3u8Url = null, probe = null;

      if (!opts.forceOpenCdn) {
        if (/\/newembed\//.test(location.pathname)) {
          m3u8Url = extractFromPageScripts();
        }
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

      // 有真实 URL → 直接传给 iframe
      if (m3u8Url && !opts.forceOpenCdn) {
        playFull({ type: 'url', value: m3u8Url });
        return;
      }

      // 没有 URL 或强制 CDN → 构建 playlist 文本传给 iframe
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
