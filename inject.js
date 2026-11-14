// Twitch Reklamfri v1.0.1
// Körs i sidans egen kontext (MAIN world) innan Twitch laddar.
// B: byter reklamfyllda spellistor mot en reklamfri reservström.
// A: reserv – om ingen reklamfri ström finns tas reklamsegmenten bort och
//    spelaren tystas/döljs tills reklamen är slut.
(() => {
  'use strict';
  if (window.__ttvabInstalled) return;
  window.__ttvabInstalled = true;

  const TAG = '[TTV-AB]';
  const OrigWorker = window.Worker;
  const workers = new Set();
  const gqlHeaders = {};
  const WANTED_HEADERS = [
    'client-integrity', 'x-device-id', 'device-id',
    'client-version', 'client-session-id', 'authorization'
  ];

  // ───────────────────────── Kod som körs INUTI Twitchs video-worker ─────────────────────────
  function workerMain() {
    const TAG = '[TTV-AB worker]';
    const realFetch = self.fetch.bind(self);
    const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
    const PLAYER_TYPES = [
      ['embed', 'web'],
      ['popout', 'web'],
      ['site', 'web'],
      ['autoplay', 'android'],
      ['picture-by-picture', 'web']
    ];
    const RETRY_MS = 15000;

    let headers = {};
    const streams = new Map();   // media-spellistans URL -> { channel, res, fr, bw }
    const channels = new Map();  // kanal -> { usherUrl, backup, failedAt }
    let lastState = 'none';

    function post(msg) {
      try { self.postMessage(Object.assign({ __ttvab: true }, msg)); } catch (e) { /* ignorera */ }
    }
    function log(...args) { post({ type: 'log', args: args.map(String) }); }
    function setState(s) {
      if (s === lastState) return;
      lastState = s;
      post({ type: 'state', state: s });
    }

    // Ta emot headers från huvudsidan innan Twitchs egen worker-kod ser meddelandet.
    self.addEventListener('message', (e) => {
      const d = e.data;
      if (d && d.__ttvab === 'headers') {
        e.stopImmediatePropagation();
        headers = d.headers || {};
      }
    });

    function hasAds(text) {
      return text.includes('stitched') || text.includes('X-TV-TWITCH-AD');
    }

    function stripAds(text) {
      const lines = text.split('\n');
      const out = [];
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        if (l.startsWith('#EXTINF') && !l.includes(',live')) { i++; continue; } // hoppa över reklamsegment + dess URL
        if (l.startsWith('#EXT-X-TWITCH-PREFETCH')) continue;
        if (l.startsWith('#EXT-X-DATERANGE') && (l.includes('stitched') || l.includes('TWITCH-AD'))) continue;
        out.push(l);
      }
      return out.join('\n');
    }

    function parseMaster(text, baseUrl) {
      const lines = text.split('\n');
      const out = [];
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        if (!l.startsWith('#EXT-X-STREAM-INF')) continue;
        const res = (l.match(/RESOLUTION=(\d+x\d+)/) || [])[1] || '';
        const fr = (l.match(/FRAME-RATE=([\d.]+)/) || [])[1] || '';
        const bw = Number((l.match(/[^-]BANDWIDTH=(\d+)/) || [])[1] || 0);
        const next = (lines[i + 1] || '').trim();
        if (next && !next.startsWith('#')) out.push({ res, fr, bw, url: new URL(next, baseUrl).href });
      }
      return out;
    }

    function pickVariant(variants, info) {
      if (!info) return variants[0];
      return variants.find(v => v.res === info.res && v.fr === info.fr)
        || variants.find(v => v.res === info.res)
        || variants.slice().sort((a, b) => Math.abs(a.bw - info.bw) - Math.abs(b.bw - info.bw))[0];
    }

    async function getToken(channel, playerType, platform, withAuth) {
      const body = {
        operationName: 'PlaybackAccessToken_Template',
        query: 'query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!, $platform: String!) { streamPlaybackAccessToken(channelName: $login, params: {platform: $platform, playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) { value signature __typename } videoPlaybackAccessToken(id: $vodID, params: {platform: $platform, playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isVod) { value signature __typename } }',
        variables: { login: channel, isLive: true, vodID: '', isVod: false, playerType, platform }
      };
      const h = { 'Client-ID': CLIENT_ID, 'Content-Type': 'text/plain;charset=UTF-8' };
      if (headers['client-integrity']) h['Client-Integrity'] = headers['client-integrity'];
      const dev = headers['x-device-id'] || headers['device-id'];
      if (dev) h['X-Device-Id'] = dev;
      if (headers['client-version']) h['Client-Version'] = headers['client-version'];
      if (headers['client-session-id']) h['Client-Session-Id'] = headers['client-session-id'];
      if (withAuth && headers['authorization']) h['Authorization'] = headers['authorization'];

      const r = await realFetch('https://gql.twitch.tv/gql', { method: 'POST', headers: h, body: JSON.stringify(body) });
      if (!r.ok) throw new Error('gql HTTP ' + r.status);
      const j = await r.json();
      const t = j && j.data && j.data.streamPlaybackAccessToken;
      if (!t || !t.value) throw new Error('ingen token' + (j && j.errors ? ' (' + JSON.stringify(j.errors).slice(0, 120) + ')' : ''));
      return t;
    }

    async function tryPlayerType(channel, ch, info, pt, pf, withAuth) {
      const tok = await getToken(channel, pt, pf, withAuth);
      const u = new URL(ch.usherUrl);
      u.searchParams.set('sig', tok.signature);
      u.searchParams.set('token', tok.value);
      u.searchParams.set('p', String(Math.floor(Math.random() * 1e7)));
      const mr = await realFetch(u.href);
      if (!mr.ok) throw new Error('usher HTTP ' + mr.status);
      const variants = parseMaster(await mr.text(), u.href);
      if (!variants.length) throw new Error('inga varianter');
      const v = pickVariant(variants, info);
      const pr = await realFetch(v.url);
      if (!pr.ok) throw new Error('spellista HTTP ' + pr.status);
      const text = await pr.text();
      if (hasAds(text)) throw new Error('har också reklam');
      return { type: pt, mediaUrl: v.url, text };
    }

    async function findBackup(channel, info) {
      const ch = channels.get(channel);
      if (!ch || !ch.usherUrl) return null;
      for (const [pt, pf] of PLAYER_TYPES) {
        for (const withAuth of [false, true]) {
          if (withAuth && !headers['authorization']) continue;
          try {
            return await tryPlayerType(channel, ch, info, pt, pf, withAuth);
          } catch (e) {
            log('reserv', pt + (withAuth ? '+inloggad' : ''), 'gick inte:', e.message);
          }
        }
      }
      return null;
    }

    function infoFor(url) {
      const info = streams.get(url);
      if (info) return info;
      if (channels.size === 1) return { channel: channels.keys().next().value, res: '', fr: '', bw: 0 };
      return null;
    }

    async function handleMedia(url, text) {
      const info = infoFor(url);
      const ch = info && channels.get(info.channel);

      if (!hasAds(text)) {
        if (ch && ch.backup) { ch.backup = null; log('reklamen slut – tillbaka till originalströmmen'); }
        if (ch) ch.failedAt = 0;
        setState('none');
        return text;
      }

      if (!ch) { setState('stripped'); return stripAds(text); }

      // Redan på en reservström – fortsätt använda den så länge den är ren.
      if (ch.backup) {
        try {
          const r = await realFetch(ch.backup.mediaUrl);
          if (r.ok) {
            const t = await r.text();
            if (!hasAds(t)) { setState('backup'); return t; }
          }
        } catch (e) { /* leta ny nedan */ }
        ch.backup = null;
      }

      if (!ch.failedAt || Date.now() - ch.failedAt > RETRY_MS) {
        const b = await findBackup(info.channel, info);
        if (b) {
          ch.backup = { mediaUrl: b.mediaUrl, type: b.type };
          ch.failedAt = 0;
          log('reklam hittad – använder reservström:', b.type);
          setState('backup');
          return b.text;
        }
        ch.failedAt = Date.now();
        log('ingen reklamfri reservström – tar bort reklamsegment och döljer spelaren');
      }
      setState('stripped');
      return stripAds(text);
    }

    self.fetch = async function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || String(input);
      if (!url.includes('.m3u8')) return realFetch(input, init);

      const resp = await realFetch(input, init);
      if (!resp.ok) return resp;

      try {
        // Huvudspellista (usher) – spara kanal och varianter.
        if (url.includes('/api/channel/hls/')) {
          const channel = (url.match(/\/api\/channel\/hls\/([^./?]+)\.m3u8/) || [])[1];
          if (channel) {
            const text = await resp.clone().text();
            let ch = channels.get(channel);
            if (!ch) { ch = {}; channels.set(channel, ch); }
            ch.usherUrl = url;
            ch.backup = null;
            ch.failedAt = 0;
            for (const v of parseMaster(text, url)) {
              streams.set(v.url, { channel, res: v.res, fr: v.fr, bw: v.bw });
            }
            log('kanal laddad:', channel);
          }
          return resp;
        }

        // Media-spellista – kontrollera reklam.
        const text = await resp.text();
        const out = await handleMedia(url, text);
        return new Response(out, { status: resp.status, statusText: resp.statusText, headers: resp.headers });
      } catch (e) {
        log('fel i fetch-hook:', e && e.message);
        throw e;
      }
    };

    log('aktiv');
  }

  // ───────────────────────── Huvudsidan ─────────────────────────

  function broadcastHeaders() {
    for (const w of workers) {
      try { w.postMessage({ __ttvab: 'headers', headers: gqlHeaders }); } catch (e) { /* ignorera */ }
    }
  }

  // Fånga Twitchs GQL-headers (integritet, enhets-id m.m.) så reservströmmen får giltig token.
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.includes('gql.twitch.tv')) {
        let h = init && init.headers;
        if (!h && typeof Request !== 'undefined' && input instanceof Request) h = input.headers;
        if (h) {
          let changed = false;
          const set = (k, v) => {
            k = String(k).toLowerCase();
            if (WANTED_HEADERS.includes(k) && v && gqlHeaders[k] !== v) { gqlHeaders[k] = v; changed = true; }
          };
          if (h instanceof Headers) h.forEach((v, k) => set(k, v));
          else if (Array.isArray(h)) h.forEach(([k, v]) => set(k, v));
          else Object.keys(h).forEach(k => set(k, h[k]));
          if (changed) broadcastHeaders();
        }
      }
    } catch (e) { /* ignorera */ }
    return origFetch.apply(this, arguments);
  };

  function getSourceSync(url) {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url, false);
    xhr.send();
    return (xhr.status === 200 || xhr.status === 0) ? xhr.responseText : null;
  }

  const WORKER_CODE = '(' + workerMain.toString() + ')();\n';

  class PatchedWorker extends OrigWorker {
    constructor(url, opts) {
      let finalUrl = url;
      let patched = false;
      try {
        const s = String(url instanceof URL ? url.href : url);
        if (!(opts && opts.type === 'module')) {
          let body = null;
          if (s.startsWith('blob:')) {
            const src = getSourceSync(s);
            if (src && /twitch|ivs|wasmworker/i.test(src)) body = src;
          } else if (/twitch|ivs|ttvnw|wasmworker/i.test(s)) {
            body = 'importScripts(' + JSON.stringify(new URL(s, location.href).href) + ');';
          }
          if (body) {
            finalUrl = URL.createObjectURL(new Blob([WORKER_CODE + body], { type: 'text/javascript' }));
            patched = true;
          }
        }
      } catch (e) {
        console.warn(TAG, 'kunde inte patcha worker:', e);
      }

      super(finalUrl, opts);

      if (patched) {
        workers.add(this);
        this.addEventListener('message', (e) => {
          const d = e.data;
          if (d && d.__ttvab === true) {
            e.stopImmediatePropagation();
            onWorkerMsg(d);
          }
        });
        try { this.postMessage({ __ttvab: 'headers', headers: gqlHeaders }); } catch (e) { /* ignorera */ }
        console.log(TAG, 'video-worker patchad');
      }
    }
    terminate() {
      workers.delete(this);
      return super.terminate();
    }
  }
  window.Worker = PatchedWorker;

  // ───────────── Reserv A: tysta + dölj spelaren när reklam ändå syns ─────────────
  const adActive = { worker: false, dom: false };
  let weMuted = false;
  let overlay = null;

  function onWorkerMsg(d) {
    if (d.type === 'log') console.log(TAG, ...(d.args || []));
    if (d.type === 'state') {
      adActive.worker = d.state === 'stripped';
      if (d.state === 'backup') console.log(TAG, 'reklam ersatt med reservström');
      update();
    }
  }

  function findContainer(video) {
    return (video && (video.closest('.video-player__container')
      || video.closest('[data-a-target="video-player"]')
      || video.parentElement)) || null;
  }

  function update() {
    const on = adActive.worker || adActive.dom;
    const video = document.querySelector('video');
    if (on) {
      if (video && !video.muted) { video.muted = true; weMuted = true; }
      const c = findContainer(video);
      if (c && (!overlay || !c.contains(overlay))) {
        if (overlay) overlay.remove();
        overlay = document.createElement('div');
        overlay.textContent = 'Reklam blockeras – streamen fortsätter strax';
        overlay.style.cssText = 'position:absolute;inset:0;z-index:9999;background:#000;color:#bbb;' +
          'display:flex;align-items:center;justify-content:center;font:600 16px sans-serif;pointer-events:none;';
        if (getComputedStyle(c).position === 'static') c.style.position = 'relative';
        c.appendChild(overlay);
      }
    } else {
      if (weMuted && video) video.muted = false;
      weMuted = false;
      if (overlay) { overlay.remove(); overlay = null; }
    }
  }

  setInterval(() => {
    const dom = !!document.querySelector('[data-a-target="video-ad-label"],[data-a-target="video-ad-countdown"]');
    if (dom !== adActive.dom) { adActive.dom = dom; update(); }
    else if (adActive.dom || adActive.worker) update();
  }, 500);

  console.log(TAG, 'v1.0.1 laddad');
})();
