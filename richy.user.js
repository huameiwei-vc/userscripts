// ==UserScript==
// @name         Richy
// @namespace    https://avjb.com/owner-security-test
// @version      2.5.0
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
  const log = (...a) => console.log('%c[AVJB-FULL-POC]', 'color:#fb7185;font-weight:bold', ...a);

  function installEarlyHooks() {
    const _add = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, listener, options) {
      if (type === 'timeupdate' && typeof listener === 'function') {
        try {
          const src = Function.prototype.toString.call(listener);
          if (/timeLimit|noplayer|getElementById\(\s*['"]player['"]\s*\)/i.test(src)) {
            log('blocked timeLimit timeupdate handler');
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
            if (/timeLimit|noplayer/i.test(src)) {
              log('blocked player.on(timeupdate) limiter');
              return obj;
            }
          } catch (_) {}
        }
        return raw(evt, fn);
      };
      obj.__avjbPatched = true;
    };

    const t = setInterval(() => {
      try {
        if (window.HlsJsPlayer && window.HlsJsPlayer.prototype) {
          patchOn(window.HlsJsPlayer.prototype);
        }
      } catch (_) {}
    }, 50);
    setTimeout(() => clearInterval(t), 8000);
  }

  installEarlyHooks();

  function videoIdFromLocation() {
    return (
      (location.pathname.match(/\/video\/(\d+)\//) || [])[1] ||
      (location.pathname.match(/\/newembed\/(\d+)/) || [])[1] ||
      null
    );
  }

  function bucketOf(id) {
    return Math.floor(Number(id) / 1000) * 1000;
  }

  function extractM3u8(text) {
    if (!text) return null;
    const patterns = [
      /https?:\/\/list\.avstatic\.com\/[^'"\s\\]+\.m3u8/,
      /https?:\/\/[^'"\s\\]+\.m3u8[^'"\s\\]*/,
    ];
    for (const re of patterns) {
      const m = text.match(re);
      if (m) return m[0].replace(/\\u002F/g, '/').replace(/\\\//g, '/');
    }
    return null;
  }

  function extractFromPageScripts() {
    const text = Array.from(document.scripts).map((s) => s.textContent || '').join('\n');
    return extractM3u8(text) || extractM3u8(document.documentElement.innerHTML);
  }

  async function fetchEmbedM3u8(videoId) {
    const url = `${location.origin}/newembed/${videoId}`;
    log('fetch embed for FULL stream', url);
    const res = await fetch(url, { credentials: 'omit', cache: 'no-store' });
    const html = await res.text();
    const m3u8 = extractM3u8(html);
    const timeLimit = Number((html.match(/timeLimit\s*=\s*(\d+)/) || [])[1] || 0);
    return { status: res.status, m3u8, timeLimit, htmlLen: html.length };
  }

  async function loadHls() {
    if (window.Hls) return window.Hls;
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = HLS_CDN;
      s.onload = resolve;
      s.onerror = () => reject(new Error('hls.js load failed'));
      document.head.appendChild(s);
    });
    return window.Hls;
  }

  async function buildOpenCdnPlaylist(videoId, knownSegCount) {
    const bucket = bucketOf(videoId);
    let count = knownSegCount;
    if (!count) {
      let lo = 0, hi = 3000;
      const first = await fetch(`https://list.avstatic.com/cdn/videos/${bucket}/${videoId}/0000.jpg`, { method: 'HEAD' });
      if (!first.ok) throw new Error('open CDN first segment not readable');
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        const r = await fetch(`https://list.avstatic.com/cdn/videos/${bucket}/${videoId}/${String(mid).padStart(4, '0')}.jpg`, { method: 'HEAD' });
        if (r.ok) lo = mid; else hi = mid - 1;
      }
      count = lo + 1;
    }
    let body = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n';
    for (let i = 0; i < count; i++) {
      body += '#EXTINF:2.000000,\n';
      body += `https://list.avstatic.com/cdn/videos/${bucket}/${videoId}/${String(i).padStart(4, '0')}.jpg\n`;
    }
    body += '#EXT-X-ENDLIST\n';
    return {
      count,
      url: URL.createObjectURL(new Blob([body], { type: 'application/vnd.apple.mpegurl' })),
      approxMin: ((count * 2) / 60).toFixed(2),
    };
  }

  async function probePlaylist(m3u8) {
    try {
      const text = await (await fetch(m3u8)).text();
      const segs = text.split(/\n/).filter((l) => l && !l.startsWith('#'));
      const durs = text.split(/\n/).filter((l) => l.startsWith('#EXTINF:')).map((l) => parseFloat(l.split(':')[1]));
      const total = durs.reduce((a, b) => a + b, 0);
      return { segs: segs.length, totalSec: Math.round(total), totalMin: (total / 60).toFixed(2) };
    } catch (e) {
      return { error: String(e) };
    }
  }

  function wipeOfficialPlayer() {
    const kill = ['#layer2', '.no-player', '.paywall-v2', '.paywall-guest', '.player-wrap', '#new', '#kt_player', '.fp-player'];
    kill.forEach((sel) => {
      document.querySelectorAll(sel).forEach((el) => el.style.setProperty('display', 'none', 'important'));
    });
    try {
      if (window.player && typeof window.player.api === 'function') {
        window.player.api('pause');
        window.player.api('stop');
      }
    } catch (_) {}
  }

  function injectStyles() {
    if (document.getElementById('avjb-full-styles')) return;
    const style = document.createElement('style');
    style.id = 'avjb-full-styles';
    style.textContent = `
      #avjb-full-poc, #avjb-full-poc * { box-sizing: border-box; }
      #avjb-full-poc {
        position: relative; z-index: 99990;
        margin: 16px auto 20px; max-width: 1100px;
        color: #f5f5f5; font-family: system-ui, sans-serif;
        background: #0b0d12; border: 1px solid rgba(255,255,255,0.08);
        border-radius: 16px; overflow: hidden;
        box-shadow: 0 18px 50px rgba(0,0,0,0.45);
      }
      #avjb-full-poc .avjb-head {
        display: flex; align-items: center; justify-content: space-between;
        gap: 12px; padding: 12px 14px;
        border-bottom: 1px solid rgba(255,255,255,0.06);
      }
      #avjb-full-poc .avjb-head h2 { margin:0; color:#fff; font:600 14px/1.2 system-ui; }
      #avjb-full-poc .avjb-actions { display:flex; gap:8px; }
      #avjb-full-poc .avjb-btn {
        border:1px solid rgba(255,255,255,0.15); border-radius:8px;
        padding:7px 12px; color:#fff; background:rgba(255,255,255,0.06);
        font:600 12px/1 system-ui; cursor:pointer;
      }
      #avjb-full-poc .avjb-btn--p { border-color:transparent; background:#e11d48; }
      #avjb-full-poc video { width:100%; max-height:75vh; display:block; background:#000; }

      /* 额外进度条 — 用原生 range input */
      #avjb-full-poc .avjb-extra-seek {
        display: flex; align-items: center; gap: 8px;
        padding: 10px 14px; background: #111;
      }
      #avjb-full-poc .avjb-extra-seek input[type=range] {
        -webkit-appearance: none; appearance: none;
        flex: 1; height: 8px; margin: 0; padding: 0;
        background: rgba(255,255,255,0.15); border-radius: 4px;
        outline: none; cursor: pointer;
      }
      #avjb-full-poc .avjb-extra-seek input[type=range]::-webkit-slider-thumb {
        -webkit-appearance: none; appearance: none;
        width: 24px; height: 24px;
        background: #fff; border: 3px solid #e11d48;
        border-radius: 50%; margin-top: 0;
        box-shadow: 0 2px 6px rgba(0,0,0,0.5);
      }
      #avjb-full-poc .avjb-extra-seek input[type=range]::-moz-range-thumb {
        width: 24px; height: 24px;
        background: #fff; border: 3px solid #e11d48; border-radius: 50%;
      }
      #avjb-full-poc .avjb-extra-seek input[type=range]::-moz-range-track {
        height: 8px; background: rgba(255,255,255,0.15); border-radius: 4px;
      }
      #avjb-full-poc .avjb-extra-seek span {
        color: #ccc; font: 500 12px/1 monospace; white-space: nowrap;
      }
      #avjb-full-poc .avjb-foot {
        display:none; padding:10px 14px; color:#fda4af; font:500 12px/1.4 system-ui;
      }
      #avjb-full-poc.avjb-has-error .avjb-foot { display:block; }

      @media (max-width: 720px) {
        #avjb-full-poc { margin:10px 8px 16px; border-radius:12px; }
        #avjb-full-poc .avjb-head { flex-direction:column; align-items:stretch; }
        #avjb-full-poc .avjb-extra-seek input[type=range] { height: 10px; }
        #avjb-full-poc .avjb-extra-seek input[type=range]::-webkit-slider-thumb {
          width: 28px; height: 28px;
        }
      }
    `;
    document.documentElement.appendChild(style);
  }

  function fmtTime(s) {
    if (!isFinite(s) || s < 0) return '0:00';
    const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = Math.floor(s%60);
    return h ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}` : `${m}:${String(sec).padStart(2,'0')}`;
  }

  function ensureMount() {
    injectStyles();
    let box = document.getElementById('avjb-full-poc');
    if (box) return box;

    box = document.createElement('div');
    box.id = 'avjb-full-poc';
    box.innerHTML = `
      <header class="avjb-head">
        <h2>完整播放</h2>
        <div class="avjb-actions">
          <button type="button" class="avjb-btn avjb-btn--p" id="poc-replay">重播</button>
          <button type="button" class="avjb-btn" id="poc-opencdn">CDN 重建</button>
        </div>
      </header>
      <video id="avjb-full-video" controls playsinline></video>
      <div class="avjb-extra-seek">
        <span id="avjb-cur">0:00</span>
        <input type="range" id="avjb-range" min="0" max="10000" value="0" step="1">
        <span id="avjb-dur">0:00</span>
      </div>
      <div class="avjb-foot" id="avjb-full-status"></div>
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

    box.querySelector('#poc-replay').addEventListener('click', () => main({ force: true }));
    box.querySelector('#poc-opencdn').addEventListener('click', () => main({ forceOpenCdn: true }));
    return box;
  }

  function setPlayerError(msg) {
    const box = document.getElementById('avjb-full-poc');
    const el = document.getElementById('avjb-full-status');
    if (!box || !el) return;
    if (msg) { box.classList.add('avjb-has-error'); el.textContent = msg; }
    else { box.classList.remove('avjb-has-error'); el.textContent = ''; }
  }

  function wireSeekbar(video) {
    const range = document.getElementById('avjb-range');
    const curEl = document.getElementById('avjb-cur');
    const durEl = document.getElementById('avjb-dur');
    if (!range || !video) return;

    let dragging = false;

    video.addEventListener('loadedmetadata', () => {
      durEl.textContent = fmtTime(video.duration);
    });
    video.addEventListener('durationchange', () => {
      durEl.textContent = fmtTime(video.duration);
    });
    video.addEventListener('timeupdate', () => {
      if (dragging) return;
      const d = video.duration || 1;
      range.value = Math.round((video.currentTime / d) * 10000);
      curEl.textContent = fmtTime(video.currentTime);
    });

    // input = 拖动中实时触发
    range.addEventListener('input', () => {
      dragging = true;
      const d = video.duration || 1;
      curEl.textContent = fmtTime((range.value / 10000) * d);
    });
    // change = 松手
    range.addEventListener('change', () => {
      const d = video.duration || 1;
      video.currentTime = (range.value / 10000) * d;
      dragging = false;
    });

    // 阻止触摸事件冒泡，不让页面其他 handler 抢走
    ['touchstart','touchmove','touchend'].forEach(evtName => {
      range.addEventListener(evtName, e => e.stopPropagation(), { passive: true });
    });
  }

  async function playFull(m3u8, meta) {
    wipeOfficialPlayer();
    ensureMount();

    const video = document.getElementById('avjb-full-video');
    setPlayerError('');

    if (window.__AVJB_HLS__) {
      try { window.__AVJB_HLS__.destroy(); } catch (_) {}
    }

    const Hls = await loadHls();
    if (Hls.isSupported()) {
      const hls = new Hls({ enableWorker: true, maxBufferLength: 60 });
      window.__AVJB_HLS__ = hls;
      hls.loadSource(m3u8);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, async () => {
        try { await video.play(); } catch (_) {}
      });
      hls.on(Hls.Events.ERROR, (_, data) => {
        setPlayerError('播放失败，可尝试 CDN 重建');
        log('hls error', data);
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = m3u8;
      try { await video.play(); } catch (_) {}
    } else {
      setPlayerError('当前浏览器无法播放');
      return;
    }

    wireSeekbar(video);
    window.__AVJB_FULL__ = { m3u8, meta, video };
    log('FULL player mounted', { m3u8, meta });
  }

  function panel(state) {
    if (!state.m3u8) { ensureMount(); setPlayerError('未能获取完整流'); }
  }

  async function main(opts = {}) {
    const videoId = videoIdFromLocation();
    if (!videoId) { log('not a video page'); return; }
    if (!document.body) await new Promise((r) => document.addEventListener('DOMContentLoaded', r, { once: true }));

    const state = { videoId, source: null, m3u8: null, totalMin: null, segs: null, timeLimit: null };
    try {
      let m3u8 = null, source = null, timeLimit = null, probe = null;

      if (!opts.forceOpenCdn) {
        if (/\/newembed\//.test(location.pathname)) {
          m3u8 = extractFromPageScripts();
          source = 'embed-page-inline';
        }
        if (!m3u8) {
          const emb = await fetchEmbedM3u8(videoId);
          m3u8 = emb.m3u8; timeLimit = emb.timeLimit;
          source = 'newembed-fetch'; state.timeLimit = timeLimit;
          log('embed result', emb);
        }
        if (m3u8) {
          probe = await probePlaylist(m3u8);
          log('playlist probe', probe);
          if (probe.totalSec && probe.totalSec <= 20) { m3u8 = null; }
        }
      }

      if (!m3u8 || opts.forceOpenCdn) {
        const built = await buildOpenCdnPlaylist(videoId, probe?.segs || null);
        m3u8 = built.url; source = 'open-cdn-reconstructed';
        probe = { segs: built.count, totalMin: built.approxMin, totalSec: built.count * 2 };
        log('open CDN playlist', built);
      }

      state.m3u8 = m3u8; state.source = source;
      state.segs = probe?.segs; state.totalMin = probe?.totalMin;
      panel(state);
      if (!m3u8) { log('FAILED'); return; }
      await playFull(m3u8, { ...probe, source });
    } catch (e) {
      log('main error', e);
      panel({ ...state, m3u8: String(e) });
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

  window.__AVJB_FULL_POC__ = { main, fetchEmbedM3u8, buildOpenCdnPlaylist, playFull };
})();
