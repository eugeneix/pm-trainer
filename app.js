'use strict';

/* ================= Данные курса ================= */
const COURSE = window.COURSE || [];
const LESSONS = [];          // плоский упорядоченный список
COURSE.forEach((m, mi) => m.topics.forEach((t, ti) => t.lessons.forEach((l, li) => {
  l.id = `${mi + 1}-${ti + 1}-${li + 1}`;
  l.mi = mi; l.ti = ti; l.index = LESSONS.length;
  l.module = m; l.topic = t;
  LESSONS.push(l);
})));
const byId = Object.fromEntries(LESSONS.map(l => [l.id, l]));

/* ================= Состояние ================= */
const STORE_KEY = 'pm-trainer-v1';
const S = Object.assign({
  done: {},        // id -> timestamp
  step: {},        // id -> сколько сегментов раскрыто
  quiz: {},        // "id#n" -> {first: bool, ok: bool, tries: n}
  notes: {},       // id -> text
  last: null,
  fast: false,
  theme: null,
  openMods: { 0: true },
  minutes: 0,
}, load());

function load() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (e) { return {}; }
}
let saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch (e) { /* хранилище недоступно */ }
    if (window.onTrainerSaved) window.onTrainerSaved(S);
  }, 150);
}

/* ================= Утилиты ================= */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
  return el;
}
const norm = s => (s || '').toLowerCase().replace(/ё/g, 'е').replace(/[–—−-]/g, '-').replace(/\s+/g, ' ').trim();
const textOf = el => (el ? el.textContent : '').replace(/\s+/g, ' ').trim();
function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 2200);
}
function plural(n, a, b, c) { n = Math.abs(n) % 100; const n1 = n % 10; if (n > 10 && n < 20) return c; if (n1 > 1 && n1 < 5) return b; if (n1 === 1) return a; return c; }

/* ================= Доступность уроков ================= */
const isDone = l => !!S.done[l.id];
function isUnlocked(l) {
  if (S.fast || l.index === 0) return true;
  // в обычном режиме урок открыт, если пройден предыдущий (видео воркшопов не блокируют)
  for (let i = l.index - 1; i >= 0; i--) {
    const p = LESSONS[i];
    if (p.type === 'video') continue;
    return isDone(p);
  }
  return true;
}
function nextLesson(l) { return LESSONS[l.index + 1]; }
function prevLesson(l) { return LESSONS[l.index - 1]; }
function firstUndone() { return LESSONS.find(l => !isDone(l) && l.type !== 'video') || LESSONS[0]; }
function markDone(l) {
  if (!S.done[l.id]) { S.done[l.id] = Date.now(); save(); renderTree(); }
}

/* ================= Разбор сохранённых страниц ================= */
const parsed = new Map();
function parseLesson(l) {
  if (parsed.has(l.id)) return parsed.get(l.id);
  const doc = new DOMParser().parseFromString(l.html || '', 'text/html');
  $$('.downloadable-image__button, .visually-hidden, .chat__message-status-box, .quiz__hint, .element-hint, script, style, svg', doc).forEach(e => e.remove());
  $$('a[href]', doc).forEach(a => { a.target = '_blank'; a.rel = 'noopener'; });
  $$('img[src^="//"]', doc).forEach(i => (i.src = 'https:' + i.getAttribute('src')));
  const root = doc.querySelector('.theory-viewer') || doc.body;
  const blocks = [];
  (function flatten(node) {
    for (const ch of Array.from(node.children)) {
      if (ch.classList.contains('theory-viewer__block_layout')) flatten(ch);
      else blocks.push(ch);
    }
  })(root);
  const items = blocks.map(classify).filter(Boolean);
  let qn = 0;
  items.forEach(it => { if (it.kind === 'quiz') it.qid = `${l.id}#${qn++}`; });
  // сегменты: раскрываются по кнопкам и после блокирующих заданий
  const segs = [];
  let cur = { items: [], end: null };
  for (const it of items) {
    if (it.kind === 'gate') {
      cur.end = { type: 'gate', label: it.label };
      segs.push(cur); cur = { items: [], end: null };
    } else {
      cur.items.push(it);
      if (it.kind === 'quiz' && it.blocking) {
        cur.end = { type: 'quiz', qid: it.qid };
        segs.push(cur); cur = { items: [], end: null };
      }
    }
  }
  if (cur.items.length) segs.push(cur);
  // кнопка в самом конце урока — просто финал
  while (segs.length && segs[segs.length - 1].end && segs[segs.length - 1].end.type === 'gate' && !segs[segs.length - 1].items.length) segs.pop();
  const res = { segs, quizzes: items.filter(i => i.kind === 'quiz'), text: textOf(root) };
  parsed.set(l.id, res);
  return res;
}

function classify(el) {
  const c = el.className || '';
  const type = (c.match(/theory-viewer__block_type_([\w-]+)/) || [])[1] || '';
  if (type === 'action-button') return { kind: 'gate', label: textOf(el) || 'Дальше' };
  if (type === 'quiz-feedback') return null;
  if (type.startsWith('quiz-')) {
    const q = parseQuiz(el, type.slice(5));
    return q ? Object.assign(q, { kind: 'quiz', blocking: /quiz_blocking/.test(c) }) : null;
  }
  return { kind: 'block', type, el };
}

/* ---------- квизы ---------- */
// В сохранённых страницах ответ ученика бывал неверным — тогда правильный вариант
// восстанавливаем по пояснению к пункту.
const stems = s => norm(s).replace(/[^a-zа-я0-9 ]/g, ' ').split(' ').filter(w => w.length >= 4).map(w => w.slice(0, 5));
const ORD = ['', 'перв', 'втор', 'трет', 'четв', 'пят', 'шест', 'седьм'];
function guessAnswer(p, pool) {
  const others = pool.filter(o => o !== p.given);
  const ex = norm(p.expl.replace(/<[^>]+>/g, ' '));
  // в пояснении назван вариант, которого никто не выбирал (например, другой чат) — ключа нет
  const tags = ex.match(/#[\wа-я-]+/g) || [];
  if (tags.some(t => !pool.some(o => norm(o) === t))) return null;
  if (pool.length === 2 && others.length === 1) return others[0];
  if (!ex) return null;
  const exStems = new Set(stems(ex));
  const pick = hits => {
    const longest = hits.slice().sort((a, b) => b.length - a.length)[0];
    return hits.length === 1 || (longest && hits.every(x => longest.includes(x))) ? longest : null;
  };
  // 1) вариант целиком встречается в пояснении
  let r = pick(others.filter(o => ex.includes(norm(o))));
  if (r) return r;
  // 2) «к четвёртому шагу», «на этапе 3» → «Шаг 4. …»
  r = pick(others.filter(o => {
    const m = norm(o).match(/^(?:шаг|этап)\s*(\d)/);
    if (!m) return false;
    const n = +m[1];
    return new RegExp(`(шаг|этап)\\w*\\s*${n}\\b|${ORD[n]}\\w*\\s+(шаг|этап)|(шаг|этап)\\w*\\s+${ORD[n]}`).test(ex);
  }));
  if (r) return r;
  // 3) все значимые слова варианта есть в пояснении (с учётом окончаний)
  return pick(others.filter(o => { const st = stems(o); return st.length && st.every(s => exStems.has(s)); }));
}

function directMd(el) { return Array.from(el.children).filter(c => c.classList.contains('Markdown')); }
function parseQuiz(el, type) {
  const mds = directMd(el);
  const head = mds[0] ? mds[0].innerHTML : '';
  if (type === 'select') {
    const form = el.querySelector('.quiz-form-choice');
    const options = $$('.quiz-form-choice__option', el).map(o => ({
      html: (o.querySelector('.quiz-form-choice__option-content') || o.querySelector('.quiz-form-choice__option-label') || o).innerHTML,
      ok: o.classList.contains('quiz-form-choice__option_should-be-checked'),
    }));
    if (!options.length) return null;
    const multi = options.filter(o => o.ok).length > 1 || (!!el.querySelector('input[type=checkbox]') && !el.querySelector('input[type=radio]'));
    const expl = mds.filter(m => form && (form.compareDocumentPosition(m) & Node.DOCUMENT_POSITION_FOLLOWING)).map(m => m.innerHTML).join('');
    return { type, head, options, multi, expl };
  }
  if (type === 'choice') {
    const prompts = $$('.quiz-form-matching__prompt', el).map(p => {
      const pm = directMd(p);
      const prompt = p.querySelector('.quiz-form-matching__prompt-content');
      return {
        html: prompt ? prompt.innerHTML : '',
        given: textOf(p.querySelector('.quiz-form-matching__answer')),
        givenOk: p.classList.contains('quiz-form-matching__prompt_correct'),
        expl: pm.filter(m => m !== prompt).map(m => m.innerHTML).join(''),
      };
    });
    if (!prompts.length) return null;
    const pool = [...new Set(prompts.map(p => p.given).filter(Boolean))];
    for (const p of prompts) {
      if (p.givenOk) { p.answer = p.given; continue; }
      p.answer = guessAnswer(p, pool);
    }
    const tail = mds.slice(1).map(m => m.innerHTML).join('');
    return { type, head, prompts, pool: pool.sort((a, b) => a.localeCompare(b, 'ru')), expl: tail };
  }
  if (type === 'cards') {
    const sections = $$('.quiz__section-list-wrapper', el).map(s => ({
      title: textOf(s.querySelector('.quiz__section-content')),
      items: $$('.quiz__list-item', s).map(i => ({ html: (i.querySelector('.Markdown') || i).innerHTML, ok: !i.classList.contains('quiz__list-item_incorrect') })),
    }));
    const names = sections.map(s => s.title);
    const cards = [];
    sections.forEach(s => s.items.forEach(it => {
      let answer = s.title;
      if (!it.ok) answer = names.length === 2 ? names.find(n => n !== s.title) : null;
      cards.push({ html: it.html, answer });
    }));
    if (!cards.length) return null;
    return { type, head, names, cards, expl: mds.slice(1).map(m => m.innerHTML).join('') };
  }
  if (type === 'macaroni') {
    const left = $$('.MarkerMacaroni-List_orientation_left .quiz__option-label', el).map(x => x.innerHTML);
    const right = $$('.MarkerMacaroni-List_orientation_right .quiz__option-label', el).map(x => textOf(x));
    return { type, head, left, right, expl: mds.slice(1).map(m => m.innerHTML).join('') };
  }
  if (type === 'text') {
    const block = el.querySelector('.quiz__content-block');
    const ref = mds.filter(m => block && (block.compareDocumentPosition(m) & Node.DOCUMENT_POSITION_FOLLOWING)).map(m => m.innerHTML).join('');
    return { type, head, expl: ref };
  }
  return { type: 'raw', head: el.innerHTML, expl: '' };
}

const KIND_LABEL = { select: 'Выбери ответ', choice: 'Сопоставь', cards: 'Распредели по группам', macaroni: 'Соедини пары', text: 'Ответь своими словами', raw: 'Задание' };

/* Рендер задания. opts.onDone(ok) вызывается после первой проверки/пропуска */
function renderQuiz(q, opts = {}) {
  const box = h('div', { class: 'quiz' });
  const prev = q.qid && S.quiz[q.qid];
  const headRow = h('div', { class: 'q-kind' }, KIND_LABEL[q.type] || 'Задание');
  box.append(headRow, h('div', { class: 'q-head md', html: q.head }));
  const verdict = h('div');
  const actions = h('div', { class: 'q-actions' });
  let finished = false;
  if (prev && !opts.fresh) headRow.append(h('span', { class: 'prev-badge' }, prev.ok ? '  · ✓ уже решено' : '  · уже отвечал'));

  function record(ok) {
    if (q.qid) {
      const r = S.quiz[q.qid] || { tries: 0 };
      if (r.first === undefined && ok !== null) r.first = ok;
      r.tries++;
      r.ok = r.ok || ok === true;
      if (ok === null && r.ok === false) r.ok = false;
      S.quiz[q.qid] = r; save();
    }
    if (!finished) { finished = true; opts.onDone && opts.onDone(ok); }
  }
  function showVerdict(kind, title, html) {
    verdict.className = 'verdict ' + kind;
    verdict.innerHTML = '';
    verdict.append(h('b', {}, title));
    if (html) verdict.append(h('div', { class: 'md', html }));
  }
  const skip = () => h('button', { class: 'link-btn', onclick: () => { record(null); reveal(); } }, 'Пропустить и показать ответ');

  let reveal = () => {};

  if (q.type === 'select') {
    const sel = new Set();
    const list = h('div', { class: 'opts' });
    const btns = q.options.map((o, i) => {
      const b = h('button', { class: 'opt' + (q.multi ? ' multi' : ''), onclick: () => {
        if (box.dataset.locked) return;
        if (q.multi) { sel.has(i) ? sel.delete(i) : sel.add(i); }
        else { sel.clear(); sel.add(i); }
        btns.forEach((x, j) => x.classList.toggle('sel', sel.has(j)));
        check.disabled = !sel.size;
      } }, h('span', { class: 'mark' }), h('div', { class: 'md', html: o.html }));
      list.append(b); return b;
    });
    const hasKey = q.options.some(o => o.ok);
    const check = h('button', { class: 'btn sm', disabled: true, onclick: () => {
      box.dataset.locked = 1;
      let ok = true;
      q.options.forEach((o, i) => {
        const b = btns[i]; b.classList.remove('sel');
        if (sel.has(i) && o.ok) b.classList.add('right');
        else if (sel.has(i) && !o.ok) { b.classList.add('wrong'); ok = false; }
        else if (!sel.has(i) && o.ok) { b.classList.add('missed'); ok = false; }
      });
      if (!hasKey) { showVerdict('info', 'Сверься с пояснением', q.expl); record(null); }
      else if (ok) { showVerdict('ok', 'Верно! 🎉', q.expl); record(true); }
      else { showVerdict('bad', 'Не совсем. Правильные варианты отмечены зелёной рамкой.', q.expl); record(false); }
      actions.replaceChildren(retry());
    } }, 'Проверить');
    const retry = () => h('button', { class: 'btn ghost sm', onclick: () => {
      delete box.dataset.locked; sel.clear(); verdict.className = ''; verdict.innerHTML = '';
      btns.forEach(b => b.className = 'opt' + (q.multi ? ' multi' : ''));
      check.disabled = true; actions.replaceChildren(check, q.multi ? hint() : '', skip());
    } }, 'Решить заново');
    const hint = () => h('span', { class: 'prev-badge' }, 'можно выбрать несколько');
    reveal = () => { box.dataset.locked = 1; q.options.forEach((o, i) => { btns[i].className = 'opt' + (q.multi ? ' multi' : '') + (o.ok ? ' right' : ''); }); showVerdict('info', 'Правильный ответ отмечен зелёным', q.expl); actions.replaceChildren(retry()); };
    actions.append(check, q.multi ? hint() : '', skip());
    box.append(list, actions, verdict);
  }

  else if (q.type === 'choice') {
    const rows = q.prompts.map(p => {
      const s = h('select', {}, h('option', { value: '' }, '— выбери —'), ...q.pool.map(o => h('option', { value: o }, o)));
      const row = h('div', { class: 'match-row' }, h('div', { class: 'md', html: p.html }), s);
      s.onchange = () => { check.disabled = rows.some(r => !r.s.value); };
      return { p, s, row };
    });
    const list = h('div', {}, rows.map(r => r.row));
    const check = h('button', { class: 'btn sm', disabled: true, onclick: () => {
      let ok = true, unsure = false;
      rows.forEach(({ p, s, row }) => {
        row.querySelector('.row-expl')?.remove();
        row.classList.remove('right', 'wrong');
        let good;
        if (p.answer) good = norm(s.value) === norm(p.answer);
        else if (!p.givenOk && norm(s.value) === norm(p.given)) good = false;
        else { good = null; unsure = true; }
        if (good === true) row.classList.add('right');
        if (good === false) { row.classList.add('wrong'); ok = false; }
        if (good !== true && (p.expl || p.answer)) row.append(h('div', { class: 'row-expl md', html: (p.answer ? `<div class="paragraph"><b>Правильно: ${p.answer}</b></div>` : '') + p.expl }));
      });
      if (ok && !unsure) { showVerdict('ok', 'Всё верно! 🎉', q.expl); record(true); }
      else if (ok) { showVerdict('info', 'Почти всё сходится — по отмеченным пунктам сверься с пояснением', q.expl); record(null); }
      else { showVerdict('bad', 'Есть ошибки — смотри пояснения под пунктами', q.expl); record(false); }
    } }, 'Проверить');
    reveal = () => {
      rows.forEach(({ p, s, row }) => {
        if (p.answer) s.value = p.answer;
        row.querySelector('.row-expl')?.remove();
        if (p.expl || !p.answer) row.append(h('div', { class: 'row-expl md', html: p.expl || '' }));
      });
      showVerdict('info', 'Ответы подставлены', q.expl);
    };
    actions.append(check, skip());
    box.append(list, actions, verdict);
  }

  else if (q.type === 'cards') {
    const order = opts.noShuffle ? q.cards : shuffle(q.cards);
    const rows = order.map(c => {
      const btns = q.names.map(n => h('button', { onclick: () => {
        row.dataset.v = n; btns.forEach(b => b.classList.toggle('sel', b.textContent === n));
        check.disabled = rows.some(r => !r.row.dataset.v);
      } }, n));
      const row = h('div', { class: 'card-row' }, h('div', { class: 'md', html: c.html }), h('div', { class: 'seg-btns' }, btns));
      return { c, row, btns };
    });
    const check = h('button', { class: 'btn sm', disabled: true, onclick: () => {
      let ok = true, unsure = false;
      rows.forEach(({ c, row }) => {
        row.classList.remove('right', 'wrong'); row.querySelector('.fix')?.remove();
        if (!c.answer) { unsure = true; return; }
        const good = row.dataset.v === c.answer;
        row.classList.add(good ? 'right' : 'wrong');
        if (!good) { ok = false; row.append(h('div', { class: 'fix' }, '→ ' + c.answer)); }
      });
      if (ok && !unsure) { showVerdict('ok', 'Всё верно! 🎉', q.expl); record(true); }
      else if (ok) { showVerdict('info', 'Готово. Часть карточек проверь сам по пояснению', q.expl); record(null); }
      else { showVerdict('bad', 'Есть ошибки — правильные группы подписаны под карточками', q.expl); record(false); }
    } }, 'Проверить');
    reveal = () => { rows.forEach(({ c, row, btns }) => { if (c.answer) { row.dataset.v = c.answer; btns.forEach(b => b.classList.toggle('sel', b.textContent === c.answer)); } }); showVerdict('info', 'Ответы подставлены', q.expl); };
    actions.append(check, skip());
    box.append(h('div', { class: 'cards' }, rows.map(r => r.row)), actions, verdict);
  }

  else if (q.type === 'macaroni') {
    const rows = q.left.map(l => {
      const s = h('select', {}, h('option', { value: '' }, '— пара —'), ...q.right.map(r => h('option', { value: r }, r)));
      return h('div', { class: 'mac-row' }, h('div', { class: 'md', html: l }), s);
    });
    const check = h('button', { class: 'btn sm', onclick: () => { showVerdict('info', 'Сверь свои пары с разбором', q.expl); record(null); } }, 'Показать разбор');
    actions.append(check);
    box.append(h('div', {}, rows), actions, verdict);
  }

  else if (q.type === 'text') {
    const ta = h('textarea', { placeholder: 'Напиши свой ответ — потом сравни с эталоном' });
    if (q.qid && S.quiz[q.qid] && S.quiz[q.qid].answer) ta.value = S.quiz[q.qid].answer;
    ta.oninput = () => { if (q.qid) { S.quiz[q.qid] = Object.assign(S.quiz[q.qid] || { tries: 0 }, { answer: ta.value }); save(); } };
    const check = h('button', { class: 'btn sm', onclick: () => {
      showVerdict('info', q.expl ? 'Эталонный ответ — сравни со своим' : 'Ответ сохранён', q.expl); record(null);
    } }, 'Сравнить с эталоном');
    actions.append(check);
    box.classList.add('q-text');
    box.append(ta, actions, verdict);
  }

  else {
    box.append(actions);
    actions.append(h('button', { class: 'btn sm', onclick: () => record(null) }, 'Готово'));
  }
  return box;
}

/* ---------- обычные блоки ---------- */
const AVATAR_COLORS = ['#5a3fd6', '#e0703a', '#1f9d8b', '#c0407a', '#3b7be0', '#8a6d1f'];
function avatarColor(name) { let s = 0; for (const ch of name) s += ch.charCodeAt(0); return AVATAR_COLORS[s % AVATAR_COLORS.length]; }

function renderBlock(it) {
  const el = it.el;
  if (it.type === 'dialog') {
    const chat = h('div', { class: 'chat' });
    let lastAuthor = '';
    $$('.chat__messages-stack', el).forEach(st => {
      const right = st.className.includes('side_right');
      const author = textOf(st.querySelector('.chat__message-author')) || lastAuthor;
      lastAuthor = author;
      const msgs = h('div', { class: 'msgs' });
      $$('.chat__message', st).forEach((m, i) => {
        const b = h('div', { class: 'bubble' });
        if (i === 0 && author) b.append(h('div', { class: 'author' }, author));
        $$('.Markdown, img', m).filter(x => !x.closest('.Markdown') || x.classList.contains('Markdown')).forEach(x => b.append(h('div', { class: 'md', html: x.outerHTML })));
        msgs.append(b);
      });
      const ini = (author || '?').trim()[0] || '?';
      chat.append(h('div', { class: 'msg-stack ' + (right ? 'right' : 'left') }, h('div', { class: 'avatar', style: `background:${avatarColor(author)}` }, ini.toUpperCase()), msgs));
    });
    return chat;
  }
  if (it.type === 'cut-container') {
    const d = h('details', { class: 'cut' }, h('summary', {}, textOf(el.querySelector('.theory-viewer__cut-container-title-content')) || 'Подробнее'));
    const inner = el.querySelector('.theory-viewer__cut-container-content');
    if (inner) $$(':scope > *', inner).forEach(ch => {
      const sub = classify(ch);
      if (sub && sub.kind === 'block') d.append(renderBlock(sub));
    });
    return d;
  }
  const md = el.matches('.Markdown') ? el : el.querySelector('.Markdown');
  return h('div', { class: 'md', html: (md || el).innerHTML });
}

/* ================= Экраны ================= */
const view = () => $('#view');
let currentLesson = null;

/* Блок «ИИ: краткий пересказ урока»: текст из data/summaries.js, строки «• …» — список, «Метка: …» — жирная метка */
function aiSummaryBox(l) {
  const text = (window.SUMMARIES || {})[l.id];
  if (!text) return null;
  const esc = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const label = s => esc(s).replace(/^([^:•]{2,40}):(\s|$)/, '<b>$1:</b>$2');
  let html = '', list = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('•')) {
      if (!list) { html += '<ul>'; list = true; }
      html += `<li>${label(line.slice(1).trim())}</li>`;
    } else {
      if (list) { html += '</ul>'; list = false; }
      html += `<p>${label(line)}</p>`;
    }
  }
  if (list) html += '</ul>';

  const copyBtn = h('button', { class: 'btn ghost sm', onclick: e => {
    e.preventDefault();
    const full = `${l.title}\n${l.module.title} · ${l.topic.title}\n\n${text}`;
    const done = () => { copyBtn.textContent = '✓ Скопировано'; setTimeout(() => (copyBtn.textContent = '📋 Скопировать'), 1800); };
    const fallback = () => {
      const ta = h('textarea', { style: 'position:fixed;opacity:0' });
      ta.value = full; document.body.append(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (err) { toast('Не удалось скопировать'); }
      ta.remove();
    };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(full).then(done, fallback);
    else fallback();
  } }, '📋 Скопировать');

  return h('details', { class: 'ai-sum' },
    h('summary', {}, h('span', { class: 'ai-ico' }, '✦'), 'ИИ: краткий пересказ урока'),
    h('div', { class: 'ai-body', html }),
    h('div', { class: 'ai-actions' }, copyBtn, h('span', { class: 'ai-note' }, 'Сгенерировано ИИ по материалам урока')));
}

function renderLesson(l) {
  currentLesson = l;
  S.last = l.id; save();
  const v = view();
  v.innerHTML = '';
  const page = h('div', { class: 'page' });
  v.append(page);
  v.scrollTop = 0;

  page.append(
    h('div', { class: 'crumbs' }, `${l.module.title} · ${l.topic.title}`),
    h('h1', { class: 'lesson-title' }, l.title),
  );
  const meta = h('div', { class: 'lesson-meta' },
    h('span', { class: 'tag' }, `Урок ${l.index + 1} из ${LESSONS.length}`),
    isDone(l) ? h('span', { class: 'tag ok' }, '✓ пройден') : null,
    S.fast ? h('span', { class: 'tag fast' }, '⚡ быстрый режим') : null);
  page.append(meta);
  const summary = aiSummaryBox(l);
  if (summary) page.append(summary);

  if (!isUnlocked(l)) {
    const p = LESSONS.slice(0, l.index).reverse().find(x => x.type !== 'video' && !isDone(x));
    page.append(h('div', { class: 'missing' },
      h('p', {}, '🔒 Этот урок откроется, когда ты пройдёшь предыдущие. Можно включить ⚡ быстрый режим — тогда открыто всё.'),
      p ? h('a', { class: 'btn', href: '#/l/' + p.id }, 'К уроку «' + p.title + '»') : null));
    return;
  }

  if (l.type === 'video') {
    const vw = h('div', { class: 'video-wrap' });
    const vid = h('video', { controls: true, preload: 'metadata', src: l.video });
    vid.addEventListener('error', () => vw.replaceWith(h('div', { class: 'missing' }, window.ONLINE ? 'Видео воркшопов доступно только в локальной версии тренажёра.' : 'Видео не найдено в папке «video». Убедись, что файл ', window.ONLINE ? '' : h('code', {}, l.video), window.ONLINE ? '' : ' на месте.')));
    vid.addEventListener('ended', () => markDone(l));
    vw.append(vid);
    page.append(vw);
    if (l.attach) page.append(h('p', {}, '📎 ', h('a', { href: l.attach.href, download: true }, l.attach.title)));
    page.append(h('p', { class: 'sub', style: 'margin-top:14px' }, 'Запись воркшопа. Отметь как просмотренное, когда досмотришь (или просто нажми «Далее»).'));
    page.append(finishCard(l, true));
    page.append(notesBox(l), lessonNav(l));
    return;
  }

  const P = parseLesson(l);
  const content = h('div', { class: 'content' });
  page.append(content);
  const total = P.segs.length;
  let shown = S.fast ? total : Math.min(Math.max(S.step[l.id] || 1, 1), total);
  if (isDone(l)) shown = total;

  const tail = h('div');
  page.append(tail, notesBox(l), lessonNav(l));

  function segEl(seg, i, isLast) {
    const box = h('div', { class: 'seg' });
    let quizEl = null;
    seg.items.forEach(it => {
      if (it.kind === 'quiz') {
        quizEl = renderQuiz(it, { onDone: () => gateBtn && (gateBtn.disabled = false) });
        box.append(quizEl);
      } else box.append(renderBlock(it));
    });
    let gateBtn = null;
    if (seg.end && i < total - 1) {
      if (S.fast) {
        if (seg.end.type === 'gate') box.append(h('div', { class: 'gate-sep' }, seg.end.label));
      } else if (isLast) {
        const label = seg.end.type === 'gate' ? seg.end.label : 'Дальше';
        gateBtn = h('button', { class: 'btn', onclick: () => advance() }, label + ' →');
        const g = h('div', { class: 'gate' }, gateBtn);
        if (seg.end.type === 'quiz' && !S.quiz[seg.end.qid]) {
          gateBtn.disabled = true;
          g.prepend(h('button', { class: 'link-btn', onclick: () => advance() }, 'пропустить задание'));
        }
        box.append(g);
      }
    }
    return box;
  }

  function draw() {
    content.innerHTML = '';
    P.segs.slice(0, shown).forEach((s, i) => content.append(segEl(s, i, i === shown - 1)));
    tail.innerHTML = '';
    if (shown >= total) {
      if (!S.fast) markDone(l);
      tail.append(finishCard(l));
    }
  }
  function advance() {
    const old = content.lastElementChild;
    old && old.querySelector('.gate')?.remove();
    shown = Math.min(shown + 1, total);
    S.step[l.id] = shown; save();
    const el = segEl(P.segs[shown - 1], shown - 1, true);
    content.append(el);
    if (shown >= total) { markDone(l); draw(); }
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  currentLesson.advance = () => {
    const btn = $('.gate .btn', content);
    if (btn && !btn.disabled) btn.click();
    else if (shown >= total || S.fast) go(l, +1);
  };
  draw();
}

function finishCard(l, video) {
  const next = nextLesson(l);
  const btn = next
    ? h('button', { class: 'btn', onclick: () => go(l, +1) }, 'Следующий урок →')
    : h('a', { class: 'btn', href: '#/home' }, 'К итогам курса');
  return h('div', { class: 'finish' },
    h('div', { class: 'big' }, video ? '🎬' : '🎉'),
    h('div', {}, h('h3', {}, video ? 'Воркшоп' : 'Урок пройден!'), h('p', {}, next ? 'Дальше: ' + next.title : 'Это последний урок курса')),
    btn);
}

function go(l, dir) {
  if (dir > 0) markDone(l);
  const t = dir > 0 ? nextLesson(l) : prevLesson(l);
  if (t) location.hash = '#/l/' + t.id;
}

function lessonNav(l) {
  const p = prevLesson(l), n = nextLesson(l);
  return h('div', { class: 'lesson-nav' },
    p ? h('a', { class: 'btn ghost', href: '#/l/' + p.id }, '← ' + p.title) : h('span'),
    n ? h('button', { class: 'btn ' + (S.fast ? '' : 'ghost'), onclick: () => {
      if (!S.fast && !isDone(l) && l.type !== 'video') { toast('Сначала пройди урок до конца — или включи ⚡ быстрый режим'); return; }
      go(l, +1);
    } }, 'Далее →') : h('span'));
}

function notesBox(l) {
  const ta = h('textarea', { placeholder: 'Твои заметки к уроку: ключевые мысли, формулы, идеи…' });
  ta.value = S.notes[l.id] || '';
  ta.oninput = () => { if (ta.value.trim()) S.notes[l.id] = ta.value; else delete S.notes[l.id]; save(); };
  const d = h('details', { class: 'notes-box' }, h('summary', {}, '📝 Мой конспект к уроку' + (S.notes[l.id] ? ' (есть заметки)' : '')), ta);
  if (S.notes[l.id]) d.open = true;
  return d;
}

/* ---------- главная ---------- */
function stats() {
  const real = LESSONS.filter(l => l.type !== 'video');
  const done = real.filter(isDone).length;
  const q = Object.values(S.quiz);
  const firstOk = q.filter(r => r.first === true).length;
  const graded = q.filter(r => r.first !== undefined).length;
  return { total: real.length, done, pct: Math.round(done / real.length * 100), solved: q.length, acc: graded ? Math.round(firstOk / graded * 100) : null };
}

function renderHome() {
  currentLesson = null;
  const st = stats();
  const last = byId[S.last];
  const cont = last && !isDone(last) && last.type !== 'video' ? last : firstUndone();
  const C = 2 * Math.PI * 52;
  const page = h('div', { class: 'page' });
  page.append(h('div', { class: 'hero' },
    h('div', {},
      h('h1', {}, st.done ? 'С возвращением!' : 'Курс «Продакт-менеджер»'),
      h('p', {}, st.done ? `Продолжаем: ${cont.title}` : '5 модулей, 10 спринтов, 114 уроков и записи воркшопов. Поехали!'),
      h('a', { class: 'btn', href: '#/l/' + cont.id }, st.done ? 'Продолжить обучение →' : 'Начать обучение →')),
    h('div', { class: 'ring', html: `<svg width="120" height="120"><circle cx="60" cy="60" r="52" stroke="rgba(255,255,255,.25)" stroke-width="10" fill="none"/><circle cx="60" cy="60" r="52" stroke="#fff" stroke-width="10" fill="none" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - st.pct / 100)}"/></svg><span>${st.pct}%</span>` })));
  page.append(h('div', { class: 'stats' },
    h('div', { class: 'stat' }, h('b', {}, `${st.done}/${st.total}`), h('span', {}, 'уроков пройдено')),
    h('div', { class: 'stat' }, h('b', {}, st.solved), h('span', {}, 'заданий решено')),
    h('div', { class: 'stat' }, h('b', {}, st.acc == null ? '—' : st.acc + '%'), h('span', {}, 'верно с первой попытки')),
    h('div', { class: 'stat' }, h('b', {}, Object.keys(S.notes).length), h('span', {}, 'уроков с конспектом'))));
  const cards = h('div', { class: 'mod-cards' });
  COURSE.forEach((m, mi) => {
    const ls = LESSONS.filter(l => l.mi === mi && l.type !== 'video');
    const d = ls.filter(isDone).length;
    const first = ls.find(l => !isDone(l)) || ls[0];
    cards.append(h('a', { class: 'mod-card', href: '#/l/' + first.id },
      h('div', { class: 'mod-num' }, mi + 1),
      h('div', { class: 'info' },
        h('h3', {}, m.title.replace(/^Модуль \d+\.\s*/, '')),
        h('small', {}, `${d} из ${ls.length} ${plural(ls.length, 'урока', 'уроков', 'уроков')} · ${m.topics.length} ${plural(m.topics.length, 'тема', 'темы', 'тем')}`),
        h('div', { class: 'bar' }, h('i', { style: `width:${ls.length ? d / ls.length * 100 : 0}%` })))));
  });
  page.append(h('h2', {}, 'Программа'), cards);
  page.append(h('div', { class: 'tip', html:
    '<b>Как заниматься.</b> В обычном режиме урок раскрывается по шагам, как на платформе: читаешь блок, жмёшь кнопку, решаешь задание. Следующий урок открывается после текущего.<br>' +
    '<b>⚡ Быстрый режим</b> (переключатель вверху) — урок показан целиком, задания не блокируют, все уроки открыты. Кнопка «Далее» всегда ведёт вперёд.<br>' +
    'Горячие клавиши: <kbd>→</kbd> или <kbd>Enter</kbd> — следующий шаг, <kbd>←</kbd> — предыдущий урок, <kbd>/</kbd> — поиск.' }));
  page.append(h('div', { class: 'q-actions', style: 'margin-top:18px' },
    h('button', { class: 'btn ghost sm', onclick: exportProgress }, '💾 Сохранить прогресс в файл'),
    h('label', { class: 'btn ghost sm' }, '📂 Загрузить прогресс', h('input', { type: 'file', accept: '.json', hidden: true, onchange: importProgress })),
    h('button', { class: 'link-btn', onclick: () => { if (confirm('Сбросить весь прогресс, ответы и конспекты?')) { localStorage.removeItem(STORE_KEY); location.reload(); } } }, 'сбросить прогресс')));
  view().replaceChildren(page);
  view().scrollTop = 0;
}

function download(name, text, type) {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  document.body.append(a); a.click(); a.remove();
}
function exportProgress() { download('pm-trainer-progress.json', JSON.stringify(S, null, 1), 'application/json'); }
function importProgress(e) {
  const f = e.target.files[0]; if (!f) return;
  f.text().then(t => { Object.assign(S, JSON.parse(t)); save(); toast('Прогресс загружен'); renderTree(); route(); })
    .catch(() => toast('Не удалось прочитать файл'));
}

/* ---------- поиск ---------- */
let searchIndex = null;
function renderSearch(q) {
  currentLesson = null;
  const page = h('div', { class: 'page' }, h('h1', { class: 'h-page' }, 'Поиск'));
  const nq = norm(q);
  if (nq.length < 2) { page.append(h('p', { class: 'sub' }, 'Введи хотя бы 2 символа')); view().replaceChildren(page); return; }
  if (!searchIndex) searchIndex = LESSONS.map(l => ({ l, t: l.type === 'video' ? l.title : parseLesson(l).text }));
  const res = [];
  for (const { l, t } of searchIndex) {
    const nt = norm(t); const i = nt.indexOf(nq);
    const inTitle = norm(l.title).includes(nq);
    if (i < 0 && !inTitle) continue;
    let snip = i >= 0 ? t.replace(/\s+/g, ' ').slice(Math.max(0, i - 80), i + 160) : '';
    res.push({ l, snip, score: (inTitle ? 10 : 0) + (nt.split(nq).length - 1) });
  }
  res.sort((a, b) => b.score - a.score);
  page.append(h('p', { class: 'sub' }, `${res.length} ${plural(res.length, 'урок', 'урока', 'уроков')} по запросу «${q}»`));
  const esc = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  res.slice(0, 60).forEach(({ l, snip }) => page.append(h('a', { class: 'result', href: '#/l/' + l.id },
    h('small', {}, l.module.title + ' · ' + l.topic.title), h('b', {}, l.title),
    snip ? h('p', { html: '…' + esc(snip).replace(re, m => `<mark>${m}</mark>`) + '…' }) : null)));
  if (!res.length) page.append(h('div', { class: 'empty' }, 'Ничего не нашлось 🤷'));
  view().replaceChildren(page);
}

/* ---------- работа над ошибками ---------- */
function findQuiz(qid) {
  const l = byId[qid.split('#')[0]];
  return l && { l, q: parseLesson(l).quizzes.find(x => x.qid === qid) };
}
function renderMistakes() {
  currentLesson = null;
  const page = h('div', { class: 'page' }, h('h1', { class: 'h-page' }, 'Работа над ошибками'),
    h('p', { class: 'sub' }, 'Задания, которые не получились с первой попытки. Реши их ещё раз — когда ответишь верно, задание уйдёт из списка.'));
  const list = Object.entries(S.quiz).filter(([, r]) => r.first === false && !r.fixed).map(([id]) => findQuiz(id)).filter(x => x && x.q);
  if (!list.length) page.append(h('div', { class: 'empty' }, Object.keys(S.quiz).length ? 'Ошибок нет — отличная работа! 💪' : 'Пока пусто. Проходи уроки — сюда попадут задания, где ты ошибся.'));
  list.forEach(({ l, q }) => {
    page.append(h('div', { class: 'crumbs', style: 'margin-top:22px' }, h('a', { href: '#/l/' + l.id }, l.title)));
    page.append(renderQuiz(q, { fresh: true, onDone: ok => { if (ok) { S.quiz[q.qid].fixed = true; save(); toast('Исправлено! ✓'); } } }));
  });
  view().replaceChildren(page); view().scrollTop = 0;
}

/* ---------- повторение (тренировка по модулю) ---------- */
function renderReview(mod) {
  currentLesson = null;
  const page = h('div', { class: 'page' }, h('h1', { class: 'h-page' }, '🎯 Повторение'),
    h('p', { class: 'sub' }, 'Случайные задания из курса — проверь, что запомнил. Засчитывается только первая проверка.'));
  const sel = h('select', {}, h('option', { value: 'all' }, 'Весь курс'), COURSE.map((m, i) => h('option', { value: i }, m.title)));
  sel.value = mod == null ? 'all' : mod;
  const cnt = h('select', {}, [5, 10, 20].map(n => h('option', { value: n }, n + ' заданий')));
  cnt.value = 10;
  page.append(h('div', { class: 'review-top' }, sel, cnt, h('button', { class: 'btn', onclick: () => start() }, 'Начать')));
  const area = h('div');
  page.append(area);
  function start() {
    const pool = LESSONS.filter(l => l.type !== 'video' && (sel.value === 'all' || l.mi === +sel.value))
      .flatMap(l => parseLesson(l).quizzes.filter(q => ['select', 'choice', 'cards'].includes(q.type)).map(q => ({ l, q })));
    const set = shuffle(pool).slice(0, +cnt.value);
    let answered = 0, right = 0;
    area.innerHTML = '';
    const score = h('div');
    set.forEach(({ l, q }, i) => {
      area.append(h('div', { class: 'crumbs', style: 'margin-top:22px' }, `${i + 1} / ${set.length} · `, h('a', { href: '#/l/' + l.id }, l.title)));
      area.append(renderQuiz(Object.assign({}, q, { qid: null }), { fresh: true, onDone: ok => {
        answered++; if (ok) right++;
        if (answered === set.length) {
          score.replaceChildren(h('div', { class: 'finish' }, h('div', { class: 'score' }, `${right}/${set.length}`),
            h('div', {}, h('h3', {}, right === set.length ? 'Идеально!' : right >= set.length * 0.7 ? 'Хороший результат' : 'Стоит повторить темы'), h('p', {}, 'Нажми «Начать», чтобы получить новый набор заданий')),
            h('button', { class: 'btn', onclick: () => { start(); view().scrollTop = 0; } }, 'Ещё раз')));
          score.scrollIntoView({ behavior: 'smooth' });
        }
      } }));
    });
    area.append(score);
  }
  view().replaceChildren(page); view().scrollTop = 0;
}

/* ---------- конспект ---------- */
function renderNotes() {
  currentLesson = null;
  const ids = LESSONS.filter(l => S.notes[l.id]);
  const page = h('div', { class: 'page' }, h('h1', { class: 'h-page' }, '📝 Мой конспект'),
    h('p', { class: 'sub' }, 'Все заметки, которые ты оставил в уроках, по порядку курса.'));
  if (ids.length) page.append(h('div', { class: 'q-actions', style: 'margin-bottom:18px' }, h('button', { class: 'btn sm', onclick: () => {
    const md = ids.map(l => `## ${l.title}\n_${l.module.title} · ${l.topic.title}_\n\n${S.notes[l.id]}\n`).join('\n');
    download('Конспект продакт-менеджер.md', '# Конспект курса «Продакт-менеджер»\n\n' + md, 'text/markdown');
  } }, '⬇ Скачать конспект (.md)')));
  else page.append(h('div', { class: 'empty' }, 'Заметок пока нет. Внизу каждого урока есть блок «Мой конспект».'));
  ids.forEach(l => page.append(h('a', { class: 'result', href: '#/l/' + l.id }, h('small', {}, l.topic.title), h('b', {}, l.title), h('p', { style: 'white-space:pre-wrap' }, S.notes[l.id]))));
  view().replaceChildren(page); view().scrollTop = 0;
}

/* ---------- тест по курсу ---------- */
const TEST_MODES = [
  { id: 'short', icon: '⚡', title: 'Короткий тест', desc: '15 случайных вопросов по всему курсу', pick: b => shuffle(b).slice(0, 15) },
  { id: 'full', icon: '🏆', title: 'Большой тест', desc: 'Все вопросы по всем пяти модулям', pick: b => shuffle(b) },
];
function renderTest() {
  currentLesson = null;
  const bank = window.TESTS || [];
  S.tests = S.tests || {};
  const page = h('div', { class: 'page' }, h('h1', { class: 'h-page' }, '🎓 Тест'),
    h('p', { class: 'sub' }, `Итоговое тестирование по материалам курса — ${bank.length} ${plural(bank.length, 'вопрос', 'вопроса', 'вопросов')}. Ответ проверяется сразу, с пояснением.`));
  const best = id => S.tests[id] ? `Лучший результат: ${S.tests[id].best}%` : 'Ещё не проходили';
  const card = (id, icon, title, desc, pick) => h('button', { class: 'mod-card test-card', onclick: () => runTest(id, title, pick(bank)) },
    h('div', { class: 'mod-num' }, icon),
    h('div', { class: 'info' }, h('h3', {}, title), h('small', {}, desc), h('div', { class: 'test-best' }, best(id))));
  const cards = h('div', { class: 'mod-cards' });
  TEST_MODES.forEach(m => cards.append(card(m.id, m.icon, m.title, m.desc, m.pick)));
  page.append(cards, h('h2', {}, 'Тест по модулю'));
  const mods = h('div', { class: 'mod-cards' });
  COURSE.forEach((m, mi) => {
    const qs = bank.filter(q => q.m === mi + 1);
    if (qs.length) mods.append(card('m' + (mi + 1), mi + 1, m.title.replace(/^Модуль \d+\.\s*/, ''), `${qs.length} ${plural(qs.length, 'вопрос', 'вопроса', 'вопросов')}`, () => shuffle(qs)));
  });
  page.append(mods);
  view().replaceChildren(page); view().scrollTop = 0;

  function runTest(id, title, qs) {
    let i = 0, right = 0;
    const wrong = [];
    const area = h('div', { class: 'page' });
    view().replaceChildren(area);
    const step = () => {
      view().scrollTop = 0;
      if (i >= qs.length) return finish();
      const q = qs[i];
      const opts = shuffle(q.o.map((t, k) => ({ t, ok: k === q.a })));
      const verdict = h('div');
      const next = h('button', { class: 'btn', hidden: true, onclick: () => { i++; step(); } }, i + 1 < qs.length ? 'Следующий вопрос →' : 'Результат →');
      let answered = false;
      const btns = opts.map(o => h('button', { class: 'opt', onclick: () => {
        if (answered) return; answered = true;
        btns.forEach((b, k) => { if (opts[k].ok) b.classList.add('right'); });
        if (o.ok) { right++; } else { b(o).classList.add('wrong'); wrong.push(q); }
        verdict.className = 'verdict ' + (o.ok ? 'ok' : 'bad');
        verdict.replaceChildren(h('b', {}, o.ok ? 'Верно! 🎉' : 'Неверно'), h('div', {}, q.e));
        next.hidden = false;
      } }, h('span', { class: 'mark' }), h('div', {}, o.t)));
      const b = o => btns[opts.indexOf(o)];
      area.replaceChildren(
        h('div', { class: 'review-top' }, h('a', { href: '#/test', class: 'link-btn' }, '← к выбору теста'), h('span', { class: 'prev-badge' }, `${title} · ${i + 1} / ${qs.length} · верно ${right}`)),
        h('div', { class: 'bar test-bar' }, h('i', { style: `width:${i / qs.length * 100}%` })),
        h('div', { class: 'quiz' }, h('div', { class: 'q-kind' }, `Модуль ${q.m}`), h('h3', { class: 'test-q' }, q.q),
          h('div', { class: 'opts' }, btns), verdict, h('div', { class: 'q-actions' }, next)));
    };
    const finish = () => {
      const pct = Math.round(right / qs.length * 100);
      const prev = S.tests[id];
      S.tests[id] = { best: Math.max(pct, prev ? prev.best : 0), last: pct, date: Date.now() }; save();
      const byMod = {};
      qs.forEach(q => { byMod[q.m] = byMod[q.m] || [0, 0]; byMod[q.m][1]++; });
      qs.forEach(q => { if (!wrong.includes(q)) byMod[q.m][0]++; });
      const grade = pct >= 90 ? 'Отлично — материал усвоен!' : pct >= 70 ? 'Хороший результат' : pct >= 50 ? 'Неплохо, но стоит повторить темы' : 'Стоит вернуться к урокам';
      area.replaceChildren(
        h('div', { class: 'finish' }, h('div', { class: 'score' }, `${pct}%`),
          h('div', {}, h('h3', {}, grade), h('p', {}, `${right} из ${qs.length} верно`)),
          h('button', { class: 'btn', onclick: () => runTest(id, title, shuffle(qs)) }, 'Пройти ещё раз')),
        h('h2', {}, 'По модулям'),
        h('div', { class: 'mod-cards' }, Object.keys(byMod).sort().map(m => {
          const [r, n] = byMod[m];
          return h('div', { class: 'mod-card' }, h('div', { class: 'mod-num' }, m),
            h('div', { class: 'info' }, h('h3', {}, COURSE[m - 1].title.replace(/^Модуль \d+\.\s*/, '')), h('small', {}, `${r} из ${n}`),
              h('div', { class: 'bar' }, h('i', { style: `width:${r / n * 100}%` }))));
        })),
        wrong.length ? h('h2', {}, 'Ошибки — разбор') : null,
        ...wrong.map(q => h('div', { class: 'result' }, h('small', {}, `Модуль ${q.m}`), h('b', {}, q.q),
          h('p', {}, '✓ ' + q.o[q.a]), h('p', {}, q.e))),
        h('p', {}, h('a', { href: '#/test', class: 'btn ghost' }, '← К выбору теста')));
      view().scrollTop = 0;
    };
    step();
  }
}

/* ================= Сайдбар ================= */
function renderTree() {
  const tree = $('#tree');
  const scroll = tree.scrollTop;
  tree.innerHTML = '';
  const cur = currentLesson && currentLesson.id;
  COURSE.forEach((m, mi) => {
    const ls = LESSONS.filter(l => l.mi === mi && l.type !== 'video');
    const pct = Math.round(ls.filter(isDone).length / ls.length * 100);
    const open = !!S.openMods[mi];
    const wrap = h('div', { class: 't-module' + (open ? ' open' : '') });
    wrap.append(h('button', { onclick: () => { S.openMods[mi] = !S.openMods[mi]; save(); wrap.classList.toggle('open'); } },
      h('span', { class: 'chev' }, '▶'), m.title, h('span', { class: 'm-pct' }, pct + '%')));
    const topics = h('div', { class: 't-topics' });
    m.topics.forEach(t => {
      topics.append(h('div', { class: 't-topic' }, t.title));
      t.lessons.forEach(l => {
        const locked = !isUnlocked(l);
        const icon = l.type === 'video' ? h('span', { class: 'st vid' }, isDone(l) ? '✅' : '🎬')
          : locked ? h('span', { class: 'st lock' }, '🔒')
          : h('span', { class: 'st' + (isDone(l) ? ' done' : '') + (l.id === cur ? ' cur' : '') }, isDone(l) ? '✓' : '');
        topics.append(h('a', { class: 't-lesson' + (l.id === cur ? ' active' : '') + (locked ? ' locked' : ''), href: '#/l/' + l.id }, icon, h('span', {}, l.title)));
      });
    });
    wrap.append(topics);
    tree.append(wrap);
  });
  tree.scrollTop = scroll;
  const st = stats();
  $('#sideBar').style.width = st.pct + '%';
  $('#sideText').textContent = st.pct + '%';
  const active = $('.t-lesson.active', tree);
  if (active && !renderTree.scrolled) { active.scrollIntoView({ block: 'center' }); renderTree.scrolled = true; }
}

/* ================= Роутинг ================= */
function route() {
  const hash = decodeURIComponent(location.hash.slice(1)) || '/home';
  const [, page, arg] = hash.split('/');
  $('#sidebar').classList.remove('show');
  if (page === 'l' && byId[arg]) {
    const l = byId[arg];
    if (!S.openMods[l.mi]) { S.openMods[l.mi] = true; save(); }
    renderTree.scrolled = false;
    renderLesson(l);
  }
  else if (page === 'search') renderSearch(arg || '');
  else if (page === 'mistakes') renderMistakes();
  else if (page === 'review') renderReview(arg);
  else if (page === 'notes') renderNotes();
  else if (page === 'test') renderTest();
  else renderHome();
  renderTree();
}

/* ================= Инициализация ================= */
function applyTheme() {
  const t = S.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.dataset.theme = t;
}
applyTheme();
$('#themeBtn').onclick = () => { S.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; save(); applyTheme(); };
$('#menuBtn').onclick = () => $('#sidebar').classList.toggle('show');
const fm = $('#fastMode');
fm.checked = S.fast;
fm.onchange = () => { S.fast = fm.checked; save(); toast(S.fast ? '⚡ Быстрый режим: всё открыто, задания не блокируют' : 'Обычный режим: пошагово, как на платформе'); route(); };

let searchT;
$('#searchInput').addEventListener('input', e => {
  clearTimeout(searchT);
  const v = e.target.value.trim();
  searchT = setTimeout(() => { if (v) location.hash = '#/search/' + encodeURIComponent(v); else location.hash = '#/home'; }, 300);
});

document.addEventListener('keydown', e => {
  const tag = (e.target.tagName || '').toLowerCase();
  if (['input', 'textarea', 'select'].includes(tag)) return;
  if (e.key === '/') { e.preventDefault(); $('#searchInput').focus(); return; }
  if (!currentLesson) return;
  if (e.key === 'ArrowRight' || (e.key === 'Enter' && tag !== 'button')) { e.preventDefault(); currentLesson.advance ? currentLesson.advance() : go(currentLesson, +1); }
  if (e.key === 'ArrowLeft') { const p = prevLesson(currentLesson); if (p) location.hash = '#/l/' + p.id; }
});

document.addEventListener('click', e => {
  const img = e.target.closest('.content img, .quiz img');
  if (img) { const lb = $('#lightbox'); $('img', lb).src = img.src; lb.hidden = false; }
});
$('#lightbox').onclick = () => ($('#lightbox').hidden = true);

setInterval(() => { if (document.visibilityState === 'visible') { S.minutes++; save(); } }, 60000);
window.addEventListener('hashchange', route);
route();
