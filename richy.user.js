// ==UserScript==
// @name         Richy
// @namespace    https://avjb.com/owner-security-test
// @version      3.0.0
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

  const HLS_CDN = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.7/dist/hls.min.js';
  const PLYR_JS = 'https://cdn.jsdelivr.net/npm/plyr@3.7.8/dist/plyr.min.js';
  const PLYR_CSS = 'https://cdn.jsdelivr.net/npm/plyr@3.7.8/dist/plyr.css';
  const log = (...a) => console.log('%c[Richy]', 'color:#fb7185;font-weight:bold', ...a);

  // ===== Early hooks: block timeLimit =====
  function installEarlyHooks() {
    const _add = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, listener, options) {
      if (type === 'timeupdate' && typeof listener === 'function') {
        try {
          const src = Function.prototype.toString.call(listener);
          if (/timeLimit|noplayer|getElementById\(\s*['"]player['"]\s*\)/i.test(src)) {
            log('blocked timeLimit handler');
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
            if (/timeLimit|noplayer/i.test(src)) { log('blocked player.on limiter'); return obj; }
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

  async function buildOpenCdnPlaylist(videoId, knownCount) {
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
    return { count, url: URL.createObjectURL(new Blob([body], { type: 'application/vnd.apple.mpegurl' })) };
  }

  async function probePlaylist(m3u8) {
    try {
      const text = await (await fetch(m3u8)).text();
      const durs = text.split('\n').filter(l => l.startsWith('#EXTINF:')).map(l => parseFloat(l.split(':')[1]));
      const total = durs.reduce((a, b) => a + b, 0);
      return { segs: durs.length, totalSec: Math.round(total) };
    } catch (e) { return { error: String(e) }; }
  }

  // ===== Load external resources =====
  function loadCSS(href) {
    if (document.querySelector(`link[href="${href}"]`)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet'; link.href = href;
    document.head.appendChild(link);
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
      const s = document.createElement('script');
      s.src = src; s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  async function loadHls() {
    if (window.Hls) return window.Hls;
    await loadScript(HLS_CDN);
    return window.Hls;
  }

  async function loadPlyr() {
    if (window.Plyr) return window.Plyr;
    loadCSS(PLYR_CSS);
    await loadScript(PLYR_JS);
    return window.Plyr;
  }

  // ===== Wipe original player =====
  function wipeOfficialPlayer() {
    ['#layer2','.no-player','.paywall-v2','.paywall-guest','.player-wrap','#new','#kt_player','.fp-player']
      .forEach(sel => document.querySelectorAll(sel).forEach(el => el.style.setProperty('display','none','important')));
    try { if (window.player?.api) { window.player.api('pause'); window.player.api('stop'); } } catch(_){}
  }

  // ===== Mount & Play =====
  function injectCustomStyles() {
    if (document.getElementById('richy-styles')) return;
    const s = document.createElement('style');
    s.id = 'richy-styles';
    s.textContent = `
      #richy-box {
        position: relative; z-index: 99990;
        margin: 16px auto 20px; max-width: 1100px;
        background: #0b0d12; border: 1px solid rgba(255,255,255,0.08);
        border-radius: 16px; overflow: hidden;
        box-shadow: 0 18px 50px rgba(0,0,0,0.45);
      }
      #richy-box .richy-head {
        display:flex; align-items:center; justify-content:space-between;
        padding:12px 14px; border-bottom:1px solid rgba(255,255,255,0.06);
      }
      #richy-box .richy-head h2 { margin:0; color:#fff; font:600 14px/1.2 system-ui,sans-serif; }
      #richy-box .richy-actions { display:flex; gap:8px; }
      #richy-box .richy-btn {
        border:1px solid rgba(255,255,255,0.15); border-radius:8px;
        padding:7px 12px; color:#fff; background:rgba(255,255,255,0.06);
        font:600 12px/1 system-ui; cursor:pointer;
      }
      #richy-box .richy-btn--p { border-color:transparent; background:#e11d48; }
      #richy-box .richy-stage { background:#000; }
      #richy-box .richy-stage video { width:100%; display:block; }
      #richy-box .richy-error {
        display:none; padding:10px 14px; color:#fda4af; font:500 12px/1.4 system-ui;
      }
      #richy-box.has-error .richy-error { display:block; }

      /* Plyr overrides for better mobile touch */
      #richy-box .plyr { --plyr-color-main: #e11d48; }
      #richy-box .plyr__progress input[type=range] {
        height: 12px !important;
      }
      #richy-box .plyr__progress input[type=range]::-webkit-slider-thumb {
        width: 22px !important; height: 22px !important;
        -webkit-appearance: none !important;
      }

      @media (max-width: 720px) {
        #richy-box { margin:10px 8px 16px; border-radius:12px; }
        #richy-box .richy-head { flex-direction:column; align-items:stretch; gap:8px; }
        #richy-box .plyr__progress input[type=range] { height: 14px !important; }
        #richy-box .plyr__progress input[type=range]::-webkit-slider-thumb {
          width: 26px !important; height: 26px !important;
        }
      }
    `;
    document.documentElement.appendChild(s);
  }

  function ensureMount() {
    injectCustomStyles();
    let box = document.getElementById('richy-box');
    if (box) return box;

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
      <div class="richy-stage">
        <video id="richy-video" playsinline></video>
      </div>
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

  async function playFull(m3u8) {
    wipeOfficialPlayer();
    ensureMount();
    showError('');

    const video = document.getElementById('richy-video');

    // Destroy previous instances
    if (window.__RICHY_HLS__) { try { window.__RICHY_HLS__.destroy(); } catch(_){} }
    if (window.__RICHY_PLYR__) { try { window.__RICHY_PLYR__.destroy(); } catch(_){} }

    const [Hls, Plyr] = await Promise.all([loadHls(), loadPlyr()]);

    // Init Plyr
    const plyr = new Plyr(video, {
      controls: ['play-large', 'play', 'progress', 'current-time', 'duration', 'mute', 'volume', 'fullscreen'],
      clickToPlay: true,
      hideControls: true,
      tooltips: { controls: false, seek: true },
      fullscreen: { enabled: true, fallback: true, iosNative: true },
    });
    window.__RICHY_PLYR__ = plyr;

    // Init HLS
    if (Hls.isSupported()) {
      const hls = new Hls({ enableWorker: true, maxBufferLength: 60 });
      window.__RICHY_HLS__ = hls;
      hls.loadSource(m3u8);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => { video.play().catch(()=>{}); });
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) showError('播放失败，可尝试 CDN 重建');
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // iOS native HLS
      video.src = m3u8;
      video.addEventListener('loadedmetadata', () => { video.play().catch(()=>{}); }, { once: true });
    } else {
      showError('浏览器不支持播放');
      return;
    }

    log('Plyr + HLS mounted', m3u8);
  }

  // ===== Main =====
  async function main(opts = {}) {
    const videoId = videoIdFromLocation();
    if (!videoId) { log('not a video page'); return; }
    if (!document.body) await new Promise(r => document.addEventListener('DOMContentLoaded', r, { once: true }));

    try {
      let m3u8 = null, probe = null;

      if (!opts.forceOpenCdn) {
        if (/\/newembed\//.test(location.pathname)) {
          m3u8 = extractFromPageScripts();
        }
        if (!m3u8) {
          const emb = await fetchEmbedM3u8(videoId);
          m3u8 = emb.m3u8;
          log('embed result', emb);
        }
        if (m3u8) {
          probe = await probePlaylist(m3u8);
          if (probe.totalSec && probe.totalSec <= 20) { m3u8 = null; }
        }
      }

      if (!m3u8 || opts.forceOpenCdn) {
        const built = await buildOpenCdnPlaylist(videoId, probe?.segs || null);
        m3u8 = built.url;
        log('open CDN playlist', built.count, 'segments');
      }

      if (!m3u8) { ensureMount(); showError('未能获取完整流'); return; }
      await playFull(m3u8);
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

  window.__RICHY__ = { main, playFull, buildOpenCdnPlaylist };
})();
