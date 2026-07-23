// ==UserScript==
// @name         Richy
// @namespace    https://avjb.com/owner-security-test
// @version      2.4.0
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
      log('open CDN segment count', count);
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
      return { segs: segs.length, totalSec: Math.round(total), totalMin: (total / 60).toFixed(2), raw: text };
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
        position: relative;
        z-index: 99990;
        margin: 16px auto 20px;
        max-width: 1100px;
        color: #f5f5f5;
        font-family: "Segoe UI", system-ui, sans-serif;
        background: #0b0d12;
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 16px;
        overflow: hidden;
        box-shadow: 0 18px 50px rgba(0,0,0,0.45);
      }

      #avjb-full-poc .avjb-head {
        display: flex; align-items: center; justify-content: space-between;
        gap: 12px; padding: 12px 14px;
        border-bottom: 1px solid rgba(255,255,255,0.06);
        background: linear-gradient(180deg, rgba(255,255,255,0.03), transparent);
      }

      #avjb-full-poc .avjb-head h2 { margin:0; color:#fff; font:600 14px/1.2 system-ui,sans-serif; }

      #avjb-full-poc .avjb-actions { display:flex; flex-wrap:wrap; gap:8px; }

      #avjb-full-poc .avjb-btn {
        appearance:none; border:1px solid rgba(255,255,255,0.1); border-radius:10px;
        padding:8px 12px; cursor:pointer; color:#fff; background:rgba(255,255,255,0.04);
        font:600 12px/1 system-ui,sans-serif;
      }
      #avjb-full-poc .avjb-btn:active { background:rgba(255,92,122,0.2); }
      #avjb-full-poc .avjb-btn--p { border-color:transparent; background:linear-gradient(180deg,#ff7a93,#e11d48); }

      #avjb-full-poc .avjb-stage { background:#000; position:relative; }

      #avjb-full-poc video {
        width:100%; max-height:75vh; display:block; background:#000;
      }

      /* ===== 自定义控制栏 ===== */
      #avjb-full-poc .avjb-controls {
        display: flex; align-items: center; gap: 10px;
        padding: 10px 14px;
        background: rgba(0,0,0,0.92);
        touch-action: none;
      }

      #avjb-full-poc .avjb-playbtn {
        appearance: none; border: none; background: none; color: #fff;
        font-size: 20px; cursor: pointer; padding: 0 4px; line-height: 1;
      }

      #avjb-full-poc .avjb-time {
        color: #aaa; font: 500 11px/1 monospace; white-space: nowrap; min-width: 80px;
      }

      /* 关键：用原生 <input type="range">，浏览器内核处理触摸，JS 层无法拦截 */
      #avjb-full-poc .avjb-seek {
        -webkit-appearance: none;
        appearance: none;
        flex: 1;
        height: 6px;
        background: rgba(255,255,255,0.2);
        border-radius: 3px;
        outline: none;
        cursor: pointer;
        margin: 0;
        padding: 0;
      }
      #avjb-full-poc .avjb-seek::-webkit-slider-runnable-track {
        height: 6px; background: transparent; border-radius: 3px;
      }
      #avjb-full-poc .avjb-seek::-webkit-slider-thumb {
        -webkit-appearance: none;
        appearance: none;
        width: 20px; height: 20px;
        background: #fff;
        border-radius: 50%;
        border: 2px solid #e11d48;
        margin-top: -7px;
        box-shadow: 0 1px 4px rgba(0,0,0,0.4);
      }
      #avjb-full-poc .avjb-seek::-moz-range-thumb {
        width: 20px; height: 20px;
        background: #fff; border-radius: 50%;
        border: 2px solid #e11d48;
      }
      #avjb-full-poc .avjb-seek::-moz-range-track {
        height: 6px; background: rgba(255,255,255,0.2); border-radius: 3px;
      }

      #avjb-full-poc .avjb-fullbtn {
        appearance: none; border: none; background: none; color: #fff;
        font-size: 18px; cursor: pointer; padding: 0 4px; line-height: 1;
      }

      #avjb-full-poc .avjb-foot {
        display: none; padding: 10px 14px;
        border-top: 1px solid rgba(255,255,255,0.06);
        color: #fda4af; font: 500 12px/1.4 system-ui,sans-serif;
      }
      #avjb-full-poc.avjb-has-error .avjb-foot { display: block; }

      @media (max-width: 720px) {
        #avjb-full-poc { margin: 10px 8px 16px; border-radius: 12px; }
        #avjb-full-poc .avjb-head { flex-direction:column; align-items:stretch; }
        #avjb-full-poc .avjb-seek::-webkit-slider-thumb { width:24px; height:24px; margin-top:-9px; }
        #avjb-full-poc .avjb-seek { height: 8px; }
        #avjb-full-poc .avjb-controls { padding: 12px 14px; gap: 8px; }
      }
    `;
    document.documentElement.appendChild(style);
  }

  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) return '0:00';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    return h > 0 ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${m}:${String(s).padStart(2,'0')}`;
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
      <div class="avjb-stage">
        <video id="avjb-full-video" playsinline></video>
      </div>
      <div class="avjb-controls">
        <button type="button" class="avjb-playbtn" id="avjb-playbtn">▶</button>
        <input type="range" class="avjb-seek" id="avjb-seek" min="0" max="1000" value="0" step="1">
        <span class="avjb-time" id="avjb-time">0:00 / 0:00</span>
        <button type="button" class="avjb-fullbtn" id="avjb-fullbtn">⛶</button>
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

    box.querySelector('#poc-replay')?.addEventListener('click', () => main({ force: true }));
    box.querySelector('#poc-opencdn')?.addEventListener('click', () => main({ forceOpenCdn: true }));
    return box;
  }

  function setPlayerError(msg) {
    const box = document.getElementById('avjb-full-poc');
    const el = document.getElementById('avjb-full-status');
    if (!box || !el) return;
    if (msg) { box.classList.add('avjb-has-error'); el.textContent = msg; }
    else { box.classList.remove('avjb-has-error'); el.textContent = ''; }
  }

  function wireControls(video) {
    const seekInput = document.getElementById('avjb-seek');
    const timeLabel = document.getElementById('avjb-time');
    const playBtn = document.getElementById('avjb-playbtn');
    const fullBtn = document.getElementById('avjb-fullbtn');

    if (!seekInput || !video) return;

    let isSeeking = false;

    // Play/Pause button
    playBtn.addEventListener('click', () => {
      if (video.paused) video.play(); else video.pause();
    });
    video.addEventListener('play', () => { playBtn.textContent = '⏸'; });
    video.addEventListener('pause', () => { playBtn.textContent = '▶'; });

    // Fullscreen
    fullBtn.addEventListener('click', () => {
      const poc = document.getElementById('avjb-full-poc');
      if (document.fullscreenElement || document.webkitFullscreenElement) {
        (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      } else if (poc) {
        (poc.requestFullscreen || poc.webkitRequestFullscreen).call(poc);
      }
    });

    // Tap on video to play/pause
    video.addEventListener('click', () => {
      if (video.paused) video.play(); else video.pause();
    });

    // Time update → sync slider
    video.addEventListener('timeupdate', () => {
      if (isSeeking) return;
      const dur = video.duration || 0;
      const cur = video.currentTime || 0;
      seekInput.value = dur > 0 ? Math.round((cur / dur) * 1000) : 0;
      timeLabel.textContent = `${fmtTime(cur)} / ${fmtTime(dur)}`;
    });

    video.addEventListener('loadedmetadata', () => {
      timeLabel.textContent = `0:00 / ${fmtTime(video.duration)}`;
    });

    // <input type="range"> 的 input 事件 — 用户正在拖动（实时反馈）
    seekInput.addEventListener('input', () => {
      isSeeking = true;
      const dur = video.duration || 0;
      const targetTime = (seekInput.value / 1000) * dur;
      timeLabel.textContent = `${fmtTime(targetTime)} / ${fmtTime(dur)}`;
    });

    // change 事件 — 用户松手，执行真正的 seek
    seekInput.addEventListener('change', () => {
      const dur = video.duration || 0;
      video.currentTime = (seekInput.value / 1000) * dur;
      isSeeking = false;
    });

    // 防止 range input 上的触摸事件冒泡到页面（阻止页面全局 handler 干扰）
    ['touchstart', 'touchmove', 'touchend'].forEach(evt => {
      seekInput.addEventListener(evt, (e) => e.stopPropagation(), { passive: true });
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

    wireControls(video);
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
          if (probe.totalSec && probe.totalSec <= 20) { log('playlist too short, fallback open CDN'); m3u8 = null; }
        }
      }

      if (!m3u8 || opts.forceOpenCdn) {
        const known = probe?.segs || null;
        const built = await buildOpenCdnPlaylist(videoId, known);
        m3u8 = built.url; source = 'open-cdn-reconstructed';
        probe = { segs: built.count, totalMin: built.approxMin, totalSec: built.count * 2 };
        log('open CDN playlist', built);
      }

      state.m3u8 = m3u8; state.source = source;
      state.segs = probe?.segs; state.totalMin = probe?.totalMin;
      state.timeLimit = timeLimit ?? state.timeLimit;
      panel(state);
      if (!m3u8) { log('FAILED to get full stream'); return; }
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
