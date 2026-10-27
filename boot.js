'use strict';
/* Вход (Supabase Auth), расшифровка курса и синхронизация прогресса. Без внешних библиотек. */
(function () {
  const URL_ = 'https://psgclyumoancyppchfln.supabase.co';
  const KEY = 'sb_publishable_1f2WJgA3HLrjaFOA81eLnw_tiEetvdX';
  const SESS = 'pm-trainer-session', STORE = 'pm-trainer-v1', TS = 'pm-trainer-sync-ts';
  window.ONLINE = true;
  const $ = s => document.querySelector(s);
  let session = null, cryptoKey = null;

  const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { } };

  /* ---------- Auth ---------- */
  async function authReq(grant, body) {
    const r = await fetch(`${URL_}/auth/v1/token?grant_type=${grant}`, {
      method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error_description || j.msg || 'Ошибка входа');
    session = { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() + (j.expires_in - 60) * 1000, uid: j.user.id };
    lsSet(SESS, JSON.stringify({ refresh_token: session.refresh_token }));
    return session;
  }
  async function token() {
    if (session && Date.now() < session.expires_at) return session.access_token;
    await authReq('refresh_token', { refresh_token: session.refresh_token });
    return session.access_token;
  }
  async function rest(path, opt = {}) {
    const t = await token();
    const r = await fetch(`${URL_}/rest/v1/${path}`, Object.assign({}, opt, {
      headers: Object.assign({ apikey: KEY, Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, opt.headers || {}),
    }));
    if (!r.ok) throw new Error('REST ' + r.status);
    const body = await r.text(); return body ? JSON.parse(body) : null;
  }

  /* ---------- Crypto ---------- */
  const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  async function initKey() {
    const rows = await rest('app_secrets?select=k&id=eq.1');
    cryptoKey = await crypto.subtle.importKey('raw', b64(rows[0].k), 'AES-CBC', false, ['decrypt']);
  }
  async function decrypt(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error('fetch ' + url);
    const buf = new Uint8Array(await r.arrayBuffer());
    return crypto.subtle.decrypt({ name: 'AES-CBC', iv: buf.slice(0, 16) }, cryptoKey, buf.slice(16));
  }
  async function runData(name) {
    const text = new TextDecoder().decode(await decrypt(`enc/${name}.enc`));
    const s = document.createElement('script'); s.text = text; document.head.append(s);
  }

  /* ---------- Картинки ---------- */
  const imgCache = new Map();
  function loadImg(img) {
    const p = img.getAttribute('data-enc'); if (!p) return;
    img.removeAttribute('data-enc');
    if (!imgCache.has(p)) {
      imgCache.set(p, decrypt(`enc/${p}.enc`).then(b => URL.createObjectURL(new Blob([b], { type: p.endsWith('.png') ? 'image/png' : p.endsWith('.gif') ? 'image/gif' : p.endsWith('.svg') ? 'image/svg+xml' : p.endsWith('.webp') ? 'image/webp' : 'image/jpeg' }))));
    }
    imgCache.get(p).then(u => { img.src = u; }).catch(() => { img.alt = 'не удалось загрузить'; });
  }
  function watchImages() {
    const scan = n => { if (n.nodeType !== 1) return; if (n.matches && n.matches('img[data-enc]')) loadImg(n); n.querySelectorAll && n.querySelectorAll('img[data-enc]').forEach(loadImg); };
    new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(scan))).observe(document.body, { childList: true, subtree: true });
    scan(document.body);
  }

  /* ---------- Синхронизация прогресса ---------- */
  const setState = t => { const e = $('#syncState'); if (e) e.textContent = t; };
  function mergeDone(a, b) { const r = Object.assign({}, a || {}); for (const k in (b || {})) r[k] = Math.max(r[k] || 0, b[k]); return r; }
  async function pullRemote() {
    const rows = await rest(`progress?select=data,updated_at&user_id=eq.${session.uid}`);
    return rows[0] || null;
  }
  async function push(data) {
    const now = new Date().toISOString();
    await rest('progress', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify({ user_id: session.uid, data, updated_at: now }) });
    lsSet(TS, now);
  }
  async function initialSync() {
    setState('☁ …');
    let local = {}; try { local = JSON.parse(lsGet(STORE)) || {}; } catch (e) { }
    const remote = await pullRemote();
    const localTs = lsGet(TS) || '';
    let result = local;
    if (remote && remote.data && Object.keys(remote.data).length) {
      const remoteNewer = remote.updated_at > localTs;
      result = Object.assign({}, remoteNewer ? remote.data : local);
      result.done = mergeDone(local.done, remote.data.done);
      lsSet(STORE, JSON.stringify(result));
      lsSet(TS, remote.updated_at);
    }
    if (!remote || JSON.stringify(result) !== JSON.stringify(remote.data)) await push(result);
    setState('☁ ✓');
  }
  let pushT;
  window.onTrainerSaved = S => {
    clearTimeout(pushT);
    setState('☁ …');
    pushT = setTimeout(() => push(JSON.parse(JSON.stringify(S))).then(() => setState('☁ ✓')).catch(() => setState('☁ ⚠')), 1500);
  };
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible' || !session) return;
    try {
      const remote = await pullRemote();
      if (remote && remote.updated_at > (lsGet(TS) || '')) {
        let local = {}; try { local = JSON.parse(lsGet(STORE)) || {}; } catch (e) { }
        const r = Object.assign({}, remote.data); r.done = mergeDone(local.done, remote.data.done);
        lsSet(STORE, JSON.stringify(r)); lsSet(TS, remote.updated_at); location.reload();
      }
    } catch (e) { }
  });

  /* ---------- Запуск ---------- */
  async function start() {
    $('#gateMsg').textContent = 'Загрузка курса…';
    await initKey();
    await Promise.all(['course', 'summaries', 'tests'].map(runData));
    await initialSync();
    $('#gate').hidden = true; $('#appRoot').hidden = false;
    watchImages();
    $('#logoutBtn').onclick = () => { try { localStorage.removeItem(SESS); localStorage.removeItem(STORE); localStorage.removeItem(TS); } catch (e) { } location.reload(); };
    const s = document.createElement('script'); s.src = 'app.js'; document.body.append(s);
  }

  async function init() {
    const saved = lsGet(SESS);
    if (saved) {
      try { await authReq('refresh_token', { refresh_token: JSON.parse(saved).refresh_token }); await start(); return; }
      catch (e) { try { localStorage.removeItem(SESS); } catch (_) { } $('#gateMsg').textContent = 'Войдите снова'; }
    }
    $('#loginForm').onsubmit = async ev => {
      ev.preventDefault();
      $('#gateMsg').textContent = 'Вхожу…';
      try {
        await authReq('password', { email: $('#lgEmail').value.trim(), password: $('#lgPass').value });
        $('#lgPass').value = '';
        await start();
      } catch (e) { $('#gateMsg').textContent = 'Не удалось войти: ' + e.message; }
    };
  }
  init();
})();
