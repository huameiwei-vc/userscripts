// ==UserScript==
// @name         Richy
// @namespace    https://avjb.com/owner-security-test
// @version      2.3.0
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

  /** 尽早废掉 embed 页的 timeLimit 注册（document-start） */
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
    const n = Number(id);
    return Math.floor(n / 1000) * 1000;
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
    const text = Array.from(document.scripts)
      .map((s) => s.textContent || '')
      .join('\n');
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
      let lo = 0;
      let hi = 3000;
      const first = await fetch(
        `https://list.avstatic.com/cdn/videos/${bucket}/${videoId}/0000.jpg`,
        { method: 'HEAD' }
      );
      if (!first.ok) throw new Error('open CDN first segment not readable — CDN 可能已加固');

      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        const r = await fetch(
          `https://list.avstatic.com/cdn/videos/${bucket}/${videoId}/${String(mid).padStart(4, '0')}.jpg`,
          { method: 'HEAD' }
        );
        if (r.ok) lo = mid;
        else hi = mid - 1;
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
      const durs = text
        .split(/\n/)
        .filter((l) => l.startsWith('#EXTINF:'))
        .map((l) => parseFloat(l.split(':')[1]));
      const total = durs.reduce((a, b) => a + b, 0);
      return { segs: segs.length, totalSec: Math.round(total), totalMin: (total / 60).toFixed(2), raw: text };
    } catch (e) {
      return { error: String(e) };
    }
  }

  function wipeOfficialPlayer() {
    const kill = [
      '#layer2',
      '.no-player',
      '.paywall-v2',
      '.paywall-guest',
      '.player-wrap',
      '#new',
      '#kt_player',
      '.fp-player',
    ];
    kill.forEach((sel) => {
      document.querySelectorAll(sel).forEach((el) => {
        el.style.setProperty('display', 'none', 'important');
      });
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
      #avjb-full-poc, #avjb-full-poc * {
        box-sizing: border-box;
      }

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
        overflow: visible;
        box-shadow: 0 18px 50px rgba(0,0,0,0.45);
      }

      #avjb-full-poc .avjb-shell__head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 12px 14px;
        border-bottom: 1px solid rgba(255,255,255,0.06);
        background: linear-gradient(180deg, rgba(255,255,255,0.03), transparent);
        border-radius: 16px 16px 0 0;
      }

      #avjb-full-poc .avjb-shell__title {
        margin: 0;
        color: #fff;
        font: 600 14px/1.2 "Segoe UI", system-ui, sans-serif;
      }

      #avjb-full-poc .avjb-shell__actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }

      #avjb-full-poc .avjb-btn {
        appearance: none;
        border: 1px solid rgba(255,255,255,0.1);
        border-radius: 10px;
        padding: 8px 12px;
        cursor: pointer;
        color: #fff;
        background: rgba(255,255,255,0.04);
        font: 600 12px/1 "Segoe UI", system-ui, sans-serif;
        transition: background .15s ease, border-color .15s ease;
      }

      #avjb-full-poc .avjb-btn:hover {
        background: rgba(255,92,122,0.14);
        border-color: rgba(255,92,122,0.4);
      }

      #avjb-full-poc .avjb-btn--primary {
        border-color: transparent;
        background: linear-gradient(180deg, #ff7a93, #e11d48);
      }

      #avjb-full-poc .avjb-btn--primary:hover {
        background: linear-gradient(180deg, #ff8da2, #f43f5e);
      }

      #avjb-full-poc .avjb-shell__stage {
        position: relative;
        background: #000;
      }

      #avjb-full-poc #avjb-full-video {
        width: 100%;
        max-height: 75vh;
        display: block;
        background: #000;
      }

      /* Custom seekbar */
      #avjb-full-poc .avjb-seekbar {
        position: relative;
        width: 100%;
        height: 36px;
        display: flex;
        align-items: center;
        padding: 0 14px;
        background: rgba(0,0,0,0.85);
        touch-action: none;
        user-select: none;
        -webkit-user-select: none;
      }

      #avjb-full-poc .avjb-seekbar__track {
        position: relative;
        flex: 1;
        height: 6px;
        background: rgba(255,255,255,0.2);
        border-radius: 3px;
        overflow: visible;
      }

      #avjb-full-poc .avjb-seekbar__filled {
        position: absolute;
        top: 0;
        left: 0;
        height: 100%;
        background: #e11d48;
        border-radius: 3px;
        pointer-events: none;
      }

      #avjb-full-poc .avjb-seekbar__thumb {
        position: absolute;
        top: 50%;
        width: 18px;
        height: 18px;
        background: #fff;
        border-radius: 50%;
        transform: translate(-50%, -50%);
        box-shadow: 0 1px 4px rgba(0,0,0,0.5);
        pointer-events: none;
      }

      #avjb-full-poc .avjb-seekbar__time {
        color: #ccc;
        font: 500 11px/1 monospace;
        margin-left: 10px;
        white-space: nowrap;
        min-width: 90px;
      }

      /* Fullscreen seekbar */
      #avjb-full-poc:fullscreen .avjb-seekbar,
      #avjb-full-poc:-webkit-full-screen .avjb-seekbar {
        position: absolute;
        bottom: 0;
        left: 0;
        right: 0;
        z-index: 99999;
        background: rgba(0,0,0,0.7);
        height: 44px;
        padding: 0 16px;
      }

      #avjb-full-poc:fullscreen #avjb-full-video,
      #avjb-full-poc:-webkit-full-screen #avjb-full-video {
        max-height: 100vh;
        height: 100%;
      }

      #avjb-full-poc .avjb-shell__foot {
        display: none;
        padding: 10px 14px;
        border-top: 1px solid rgba(255,255,255,0.06);
        color: #fda4af;
        font: 500 12px/1.4 "Segoe UI", system-ui, sans-serif;
      }

      #avjb-full-poc.avjb-has-error .avjb-shell__foot {
        display: block;
      }

      @media (max-width: 720px) {
        #avjb-full-poc {
          margin: 10px 8px 16px;
          border-radius: 12px;
        }
        #avjb-full-poc .avjb-shell__head {
          flex-direction: column;
          align-items: stretch;
          border-radius: 12px 12px 0 0;
        }
        #avjb-full-poc .avjb-seekbar__thumb {
          width: 22px;
          height: 22px;
        }
        #avjb-full-poc .avjb-seekbar {
          height: 44px;
        }
        #avjb-full-poc .avjb-seekbar__track {
          height: 8px;
          border-radius: 4px;
        }
      }
    `;
    document.documentElement.appendChild(style);
  }

  function formatTime(sec) {
    if (!isFinite(sec) || sec < 0) return '0:00';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    return `${m}:${String(s).padStart(2,'0')}`;
  }

  /** 自定义触摸进度条 — 完全绕过原生控件的触摸问题 */
  function attachSeekbar(video, container) {
    const bar = document.createElement('div');
    bar.className = 'avjb-seekbar';
    bar.innerHTML = `
      <div class="avjb-seekbar__track">
        <div class="avjb-seekbar__filled"></div>
        <div class="avjb-seekbar__thumb"></div>
      </div>
      <div class="avjb-seekbar__time">0:00 / 0:00</div>
    `;
    container.appendChild(bar);

    const track = bar.querySelector('.avjb-seekbar__track');
    const filled = bar.querySelector('.avjb-seekbar__filled');
    const thumb = bar.querySelector('.avjb-seekbar__thumb');
    const timeLabel = bar.querySelector('.avjb-seekbar__time');

    let seeking = false;

    function updateUI() {
      if (seeking) return;
      const dur = video.duration || 0;
      const cur = video.currentTime || 0;
      const pct = dur > 0 ? (cur / dur) * 100 : 0;
      filled.style.width = pct + '%';
      thumb.style.left = pct + '%';
      timeLabel.textContent = `${formatTime(cur)} / ${formatTime(dur)}`;
    }

    video.addEventListener('timeupdate', updateUI);
    video.addEventListener('loadedmetadata', updateUI);
    video.addEventListener('durationchange', updateUI);

    function seekTo(clientX) {
      const rect = track.getBoundingClientRect();
      let pct = (clientX - rect.left) / rect.width;
      pct = Math.max(0, Math.min(1, pct));
      filled.style.width = (pct * 100) + '%';
      thumb.style.left = (pct * 100) + '%';
      const dur = video.duration || 0;
      const targetTime = pct * dur;
      timeLabel.textContent = `${formatTime(targetTime)} / ${formatTime(dur)}`;
      return targetTime;
    }

    // Touch events — the whole point
    bar.addEventListener('touchstart', (e) => {
      e.preventDefault();
      e.stopPropagation();
      seeking = true;
      const touch = e.touches[0];
      seekTo(touch.clientX);
    }, { passive: false });

    bar.addEventListener('touchmove', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!seeking) return;
      const touch = e.touches[0];
      seekTo(touch.clientX);
    }, { passive: false });

    bar.addEventListener('touchend', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!seeking) return;
      seeking = false;
      const touch = e.changedTouches[0];
      const time = seekTo(touch.clientX);
      video.currentTime = time;
    }, { passive: false });

    // Mouse events for desktop fallback
    bar.addEventListener('mousedown', (e) => {
      e.preventDefault();
      seeking = true;
      seekTo(e.clientX);

      const onMove = (ev) => { seekTo(ev.clientX); };
      const onUp = (ev) => {
        seeking = false;
        const time = seekTo(ev.clientX);
        video.currentTime = time;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    // Fullscreen toggle on double-tap / double-click the video
    let lastTap = 0;
    video.addEventListener('click', () => {
      const now = Date.now();
      if (now - lastTap < 300) {
        const poc = document.getElementById('avjb-full-poc');
        if (document.fullscreenElement || document.webkitFullscreenElement) {
          (document.exitFullscreen || document.webkitExitFullscreen).call(document);
        } else if (poc) {
          (poc.requestFullscreen || poc.webkitRequestFullscreen).call(poc);
        }
      }
      lastTap = now;
    });

    return bar;
  }

  function ensureMount() {
    injectStyles();
    let box = document.getElementById('avjb-full-poc');
    if (box) return box;

    box = document.createElement('div');
    box.id = 'avjb-full-poc';
    box.innerHTML = `
      <header class="avjb-shell__head">
        <h2 class="avjb-shell__title">完整播放</h2>
        <div class="avjb-shell__actions">
          <button type="button" class="avjb-btn avjb-btn--primary" id="poc-replay">重播</button>
          <button type="button" class="avjb-btn" id="poc-opencdn">CDN 重建</button>
        </div>
      </header>
      <div class="avjb-shell__stage">
        <video id="avjb-full-video" playsinline></video>
      </div>
      <div class="avjb-shell__foot" id="avjb-full-status"></div>
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
    const statusEl = document.getElementById('avjb-full-status');
    if (!box || !statusEl) return;
    if (msg) {
      box.classList.add('avjb-has-error');
      statusEl.textContent = msg;
    } else {
      box.classList.remove('avjb-has-error');
      statusEl.textContent = '';
    }
  }

  async function playFull(m3u8, meta) {
    wipeOfficialPlayer();
    ensureMount();

    const video = document.getElementById('avjb-full-video');
    const stage = document.querySelector('#avjb-full-poc .avjb-shell__stage');
    setPlayerError('');

    // Remove old seekbar if replaying
    const oldBar = document.querySelector('#avjb-full-poc .avjb-seekbar');
    if (oldBar) oldBar.remove();

    if (window.__AVJB_HLS__) {
      try {
        window.__AVJB_HLS__.destroy();
      } catch (_) {}
    }

    const Hls = await loadHls();
    if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        maxBufferLength: 60,
      });
      window.__AVJB_HLS__ = hls;
      hls.loadSource(m3u8);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, async () => {
        try {
          await video.play();
        } catch (_) {}
      });
      hls.on(Hls.Events.ERROR, (_, data) => {
        setPlayerError('播放失败，可尝试 CDN 重建');
        log('hls error', data);
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = m3u8;
      try {
        await video.play();
      } catch (_) {}
    } else {
      setPlayerError('当前浏览器无法播放');
      return;
    }

    // Attach custom seekbar (works on mobile touch)
    attachSeekbar(video, stage);

    // Single tap to play/pause
    video.addEventListener('click', (e) => {
      // Don't interfere with double-tap fullscreen
      setTimeout(() => {
        if (Date.now() - (video.__lastTap || 0) > 300) {
          if (video.paused) video.play(); else video.pause();
        }
      }, 310);
    });

    window.__AVJB_FULL__ = { m3u8, meta, video };
    log('FULL player mounted', { m3u8, meta });
  }

  function panel(state) {
    if (!state.m3u8) {
      ensureMount();
      setPlayerError('未能获取完整流');
    }
  }

  async function main(opts = {}) {
    const videoId = videoIdFromLocation();
    if (!videoId) {
      log('not a video page');
      return;
    }

    if (!document.body) {
      await new Promise((r) => document.addEventListener('DOMContentLoaded', r, { once: true }));
    }

    const state = { videoId, source: null, m3u8: null, totalMin: null, segs: null, timeLimit: null };

    try {
      let m3u8 = null;
      let source = null;
      let timeLimit = null;
      let probe = null;

      if (!opts.forceOpenCdn) {
        if (/\/newembed\//.test(location.pathname)) {
          m3u8 = extractFromPageScripts();
          source = 'embed-page-inline';
        }

        if (!m3u8) {
          const emb = await fetchEmbedM3u8(videoId);
          m3u8 = emb.m3u8;
          timeLimit = emb.timeLimit;
          source = 'newembed-fetch';
          state.timeLimit = timeLimit;
          log('embed result', emb);
        }

        if (m3u8) {
          probe = await probePlaylist(m3u8);
          log('playlist probe', probe);
          if (probe.totalSec && probe.totalSec <= 20) {
            log('playlist too short, fallback open CDN');
            m3u8 = null;
          }
        }
      }

      if (!m3u8 || opts.forceOpenCdn) {
        const known = probe?.segs || null;
        const built = await buildOpenCdnPlaylist(videoId, known);
        m3u8 = built.url;
        source = 'open-cdn-reconstructed';
        probe = { segs: built.count, totalMin: built.approxMin, totalSec: built.count * 2 };
        log('open CDN playlist', built);
      }

      state.m3u8 = m3u8;
      state.source = source;
      state.segs = probe?.segs;
      state.totalMin = probe?.totalMin;
      state.timeLimit = timeLimit ?? state.timeLimit;

      panel(state);

      if (!m3u8) {
        log('FAILED to get full stream');
        return;
      }

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
