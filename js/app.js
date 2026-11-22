// Screens and interaction. Routes: #/listen, #/book/<id>, #/record, #/backup
import * as db from './db.js';
import { Recorder, canRecord } from './recorder.js';
import { Player } from './player.js';
import { exportBook, importBackup, chapterFiles, shareFiles } from './backup.js';
import { esc, clamp, fmtTime, fmtLong, fmtBytes, ago, plural, chapterTitle, settings, icon, coverClass } from './util.js';

const $ = s => document.querySelector(s);
const view = $('#view');
const player = new Player($('#audio'));
player.mode = settings.get('mode', 'book');
player.setRate(settings.get('rate', 1));

const NEW = 'new';
const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];
const PLAY_ACTIONS = new Set(['continue', 'from-start', 'play-ch']);

// What's typed into the Record form. `target` is set when adding onto / re-recording a chapter.
const form = { bookId: settings.get('recordBook', null), title: '', number: null, touched: false, name: '', target: null };
let formChapters = [];
let rec = null;            // the Recorder while recording
let starting = false, stopping = false;
let saved = null;          // the last recording saved, shown on the Record tab
let resumeHint = null;     // the book to offer in the mini player before anything has played
const prepared = new Map(); // bookId -> backup File ready to save
const preparing = new Set();
let renderSeq = 0, lastRoute = '';
let seeking = false;

/* ---------- where you're up to ---------- */

const totalOf = chs => chs.reduce((s, c) => s + c.duration, 0);

// From the saved bookmark, work out where "Continue" should start.
function where(chs, prog) {
  if (!chs.length) return { state: 'empty', index: 0, time: 0, listened: 0 };
  if (!prog) return { state: 'new', index: 0, time: 0, listened: 0 };
  let i = chs.findIndex(c => c.id === prog.chapterId);
  let time = prog.time || 0;
  if (i < 0) { i = clamp((prog.number || 1) - 1, 0, chs.length - 1); time = 0; } // that chapter was deleted
  if (time >= chs[i].duration - 0.5) {
    // Finished that chapter: continue with the next one (including one recorded since).
    if (i + 1 < chs.length) { i++; time = 0; }
    else return { state: 'done', index: i, time: chs[i].duration, listened: totalOf(chs) };
  }
  const listened = totalOf(chs.slice(0, i)) + time;
  return { state: listened > 0 ? 'started' : 'new', index: i, time, listened };
}

function statusLine(w, chs) {
  if (w.state === 'empty') return 'No chapters yet';
  if (w.state === 'new') return 'Not started';
  if (w.state === 'done') return 'Finished';
  return `Up to chapter ${chs[w.index].number} · ${fmtTime(w.time)}`;
}

const cover = (title, cls = '') => `<span class="cover ${coverClass(title)} ${cls}">${icon('book')}</span>`;
const bar = pct => `<span class="bar"><i style="width:${clamp(Math.round(pct), 0, 100)}%"></i></span>`;

/* ---------- rendering ---------- */

function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

async function render() {
  const n = ++renderSeq;
  const route = location.hash.replace(/^#\/?/, '');
  const [tab = 'listen', id] = route.split('/');
  let html;
  try {
    if (tab === 'record') html = await recordHTML();
    else if (tab === 'backup') html = await backupHTML();
    else if (tab === 'book' && id) html = await bookHTML(id);
    else html = await libraryHTML();
  } catch (e) {
    console.error(e);
    html = `<div class="card"><p>Something went wrong: ${esc(e.message)}</p></div>`;
  }
  if (n !== renderSeq || html == null) return;
  view.innerHTML = html;
  if (route !== lastRoute) { window.scrollTo(0, 0); lastRoute = route; }
  setTabs(tab === 'record' || tab === 'backup' ? tab : 'listen');
}

function setTabs(active) {
  for (const a of document.querySelectorAll('#tabs a')) {
    const on = a.dataset.tab === active;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    if (a.dataset.tab === 'record') a.classList.toggle('live', !!rec);
  }
}

/* ---------- Listen: library ---------- */

async function libraryHTML() {
  const books = await db.listBooks();
  if (!books.length) {
    return `<header class="top"><h1>Your audiobooks</h1></header>
      <div class="card empty">
        ${cover('start', 'lg')}
        <h2>Record your first chapter</h2>
        <p class="muted">Pick a title, read a chapter aloud, and it shows up here ready to listen to.</p>
        <a class="btn primary" href="#/record">${icon('mic')} Start recording</a>
      </div>`;
  }
  const rows = await Promise.all(books.map(async b => {
    const [chs, prog] = await Promise.all([db.chaptersOf(b.id), db.getProgress(b.id)]);
    return { b, chs, w: where(chs, prog), total: totalOf(chs) };
  }));
  const recent = r => Math.max(r.b.playedAt || 0, r.b.updatedAt || 0);
  rows.sort((x, y) => recent(y) - recent(x));
  return `<header class="top"><h1>Your audiobooks</h1></header>
    <div class="books">${rows.map(({ b, chs, w, total }) => `
      <a class="card book" href="#/book/${b.id}">
        ${cover(b.title)}
        <span class="book-main">
          <strong>${esc(b.title)}</strong>
          <span class="muted small">${plural(chs.length, 'chapter')} · ${fmtLong(total)}</span>
          ${bar(total ? (w.listened / total) * 100 : 0)}
          <span class="small ${w.state === 'started' ? 'accent' : 'muted'}">${esc(statusLine(w, chs))}</span>
        </span>
      </a>`).join('')}
    </div>`;
}

/* ---------- Listen: one book ---------- */

async function bookHTML(id) {
  const b = await db.getBook(id);
  if (!b) { location.replace('#/listen'); return null; }
  const [chs, prog] = await Promise.all([db.chaptersOf(id), db.getProgress(id)]);
  const w = where(chs, prog), total = totalOf(chs);
  const current = player.book?.id === id ? player.chapter?.id : null;

  let actions;
  if (!chs.length) {
    actions = `<a class="btn primary wide" href="#/record" data-act="record-into" data-book="${id}">${icon('mic')} Record chapter 1</a>`;
  } else if (w.state === 'started') {
    actions = `<button class="btn primary wide" data-act="continue" data-book="${id}">${icon('play', 'fill')} Continue · chapter ${chs[w.index].number}, ${fmtTime(w.time)}</button>
      <button class="btn wide" data-act="from-start" data-book="${id}">Play from the start</button>`;
  } else {
    actions = `<button class="btn primary wide" data-act="from-start" data-book="${id}">${icon('play', 'fill')} ${w.state === 'done' ? 'Play again from the start' : 'Play from the start'}</button>`;
  }

  const mode = player.mode;
  const modeSwitch = chs.length ? `
    <div class="seg" role="group" aria-label="When a chapter ends">
      <button data-act="mode" data-mode="book" aria-pressed="${mode === 'book'}">Whole book</button>
      <button data-act="mode" data-mode="chapter" aria-pressed="${mode === 'chapter'}">One chapter</button>
    </div>
    <p class="small muted seg-note">${mode === 'book' ? 'Plays on into the next chapter.' : 'Stops at the end of each chapter.'}</p>` : '';

  const list = chs.map((c, i) => {
    const done = w.state === 'done' || i < w.index;
    const isCur = c.id === current;
    return `<li class="ch${isCur ? ' current' : ''}">
      <button class="ch-main" data-act="play-ch" data-book="${id}" data-ch="${c.id}" aria-label="Play ${esc(chapterTitle(c))}">
        <span class="ch-mark">${isCur ? icon('play', 'fill') : done ? icon('check') : ''}</span>
        <span class="ch-name">${esc(chapterTitle(c))}${c.parts.length > 1 ? ` <span class="faint small">· ${c.parts.length} parts</span>` : ''}</span>
        <span class="muted small mono">${fmtTime(c.duration)}</span>
      </button>
      <button class="icon-btn" data-act="ch-menu" data-ch="${c.id}" aria-label="Options for ${esc(chapterTitle(c))}">${icon('more')}</button>
    </li>`;
  }).join('');

  return `<header class="top">
      <a class="back" href="#/listen">${icon('chev-left')} Library</a>
      <button class="icon-btn" data-act="book-menu" data-book="${id}" aria-label="Book options">${icon('more')}</button>
    </header>
    <section class="book-head">
      ${cover(b.title, 'lg')}
      <div><h1>${esc(b.title)}</h1><p class="muted small">${plural(chs.length, 'chapter')} · ${fmtLong(total)}</p></div>
    </section>
    ${chs.length ? `${bar(total ? (w.listened / total) * 100 : 0)}<p class="small muted status">${esc(statusLine(w, chs))}</p>` : ''}
    <div class="stack">${actions}</div>
    ${modeSwitch}
    ${chs.length ? `<h2 class="section">Chapters</h2><ul class="chapters">${list}</ul>` : ''}
    ${chs.length ? `<a class="btn wide subtle" href="#/record" data-act="record-into" data-book="${id}">${icon('mic')} Record a chapter</a>` : ''}`;
}

/* ---------- Record ---------- */

function numberHint(n, chs) {
  const count = chs.length;
  if (!Number.isInteger(n) || n < 1) return 'Enter a chapter number.';
  if (n > count + 1) return count ? `This book has ${plural(count, 'chapter')}, so this will be chapter ${count + 1}.` : 'This will be chapter 1.';
  if (n === count + 1) return count ? `Goes after chapter ${count}.` : 'The first chapter of this book.';
  const c = chs[n - 1];
  return `Goes in as chapter ${n}. The current chapter ${n}${c.name ? ` (“${c.name}”)` : ''} becomes chapter ${n + 1}${n < count ? ', and the chapters after it move down one' : ''}.`;
}

function targetLabel(target, chs) {
  if (target.mode === 'new') {
    const n = clamp(target.number, 1, chs.length + 1);
    return target.name ? `${n} · ${target.name}` : `Chapter ${n}`;
  }
  const c = chs.find(x => x.id === target.chapterId);
  const t = c ? chapterTitle(c) : 'chapter';
  return target.mode === 'append' ? `Adding onto ${t}` : `Re-recording ${t}`;
}

async function recordHTML() {
  if (rec) return recordingHTML();
  if (!canRecord()) {
    return `<header class="top"><h1>Record</h1></header>
      <div class="card"><p>Recording needs the microphone, which isn't available here.</p>
      <p class="small muted">On iPhone, open the app from its home-screen icon. It must be loaded over https (the GitHub Pages address), not from a file.</p></div>`;
  }
  const books = (await db.listBooks()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  if (form.bookId !== NEW && !books.some(b => b.id === form.bookId)) form.bookId = books[0]?.id || NEW;
  const isNew = form.bookId === NEW;
  const chs = isNew ? [] : await db.chaptersOf(form.bookId);
  formChapters = chs;
  if (form.target && !chs.some(c => c.id === form.target.chapterId)) form.target = null;
  if (!form.touched) form.number = chs.length + 1;

  const bookField = books.length ? `
    <label class="field"><span>Book</span>
      <select id="f-book">
        ${books.map(b => `<option value="${b.id}"${b.id === form.bookId ? ' selected' : ''}>${esc(b.title)}</option>`).join('')}
        <option value="${NEW}"${isNew ? ' selected' : ''}>New book…</option>
      </select>
    </label>` : '';
  const titleField = isNew ? `
    <label class="field"><span>${books.length ? 'New book title' : 'Book title'}</span>
      <input id="f-title" value="${esc(form.title)}" placeholder="The long road" autocomplete="off" autocapitalize="words" enterkeyhint="next">
    </label>` : '';

  let chapterFields;
  if (form.target) {
    const c = chs.find(x => x.id === form.target.chapterId);
    chapterFields = `<div class="banner">
      ${form.target.mode === 'append'
        ? `Adding onto the end of <strong>${esc(chapterTitle(c))}</strong>. It will play straight on from what's already there.`
        : `Re-recording <strong>${esc(chapterTitle(c))}</strong>. The old recording is replaced when you save.`}
      <button class="link" data-act="target-cancel">Record a new chapter instead</button>
    </div>`;
  } else {
    chapterFields = `<div class="row2">
        <label class="field num"><span>Chapter</span>
          <input id="f-num" type="number" inputmode="numeric" min="1" step="1" value="${form.number ?? ''}">
        </label>
        <label class="field"><span>Name <span class="faint">(optional)</span></span>
          <input id="f-name" value="${esc(form.name)}" placeholder="Leaving home" autocomplete="off" autocapitalize="sentences">
        </label>
      </div>
      <p id="f-hint" class="hint small">${esc(numberHint(form.number, chs))}</p>`;
  }

  const savedCard = saved && saved.bookId === form.bookId ? `
    <div class="card saved">
      <p>${icon('check')} Saved <strong>${esc(saved.title)}</strong> · ${fmtTime(saved.duration)}${saved.interrupted ? '<br><span class="small muted">Recording stopped early (the phone locked or another app used the mic).</span>' : ''}</p>
      <div class="row-btns">
        <button class="btn small" data-act="play-ch" data-book="${saved.bookId}" data-ch="${saved.chapterId}">${icon('play', 'fill')} Play it</button>
        <button class="btn small" data-act="add-to" data-ch="${saved.chapterId}">${icon('plus')} Record more onto it</button>
      </div>
    </div>` : '';

  const recorded = chs.length ? `
    <h2 class="section">Already recorded</h2>
    <ul class="chapters">${chs.map(c => `
      <li class="ch">
        <button class="ch-main" data-act="ch-menu" data-ch="${c.id}">
          <span class="ch-name">${esc(chapterTitle(c))}${c.parts.length > 1 ? ` <span class="faint small">· ${c.parts.length} parts</span>` : ''}</span>
          <span class="muted small mono">${fmtTime(c.duration)}</span>
        </button>
        <button class="icon-btn" data-act="ch-menu" data-ch="${c.id}" aria-label="Options for ${esc(chapterTitle(c))}">${icon('more')}</button>
      </li>`).join('')}
    </ul>` : '';

  return `<header class="top"><h1>Record</h1></header>
    ${savedCard}
    <div class="card form">
      ${bookField}${titleField}${chapterFields}
      <p id="f-err" class="err small" role="alert" hidden></p>
    </div>
    <div class="rec-start">
      <button class="rec-btn" data-act="rec-start" aria-label="Start recording"><span></span></button>
      <span class="muted small">Tap to start recording</span>
    </div>
    ${recorded}`;
}

function recordingHTML() {
  const paused = rec.state === 'paused';
  return `<header class="top"><h1>Recording</h1></header>
    <section class="card recording${paused ? ' paused' : ''}">
      <p class="muted small">${esc(rec.info.bookTitle)}</p>
      <h2>${esc(rec.info.label)}</h2>
      <div id="rec-time" class="rec-time mono">${fmtTime(rec.elapsed())}</div>
      <div class="meter" aria-hidden="true"><i id="rec-meter"></i></div>
      <p class="rec-state small"><span class="dot"></span>${paused ? 'Paused' : 'Recording'}</p>
      <div class="rec-controls">
        <button class="btn" data-act="rec-pause">${paused ? `${icon('mic')} Resume` : `${icon('pause', 'fill')} Pause`}</button>
        <button class="btn primary" data-act="rec-stop">${icon('check')} Stop and save</button>
      </div>
      <button class="link danger" data-act="rec-discard">Discard this recording</button>
    </section>
    <p class="note small muted">Keep the screen on and the app open while you record. If the phone locks or a call comes in, recording stops and everything up to that point is saved.</p>`;
}

function fieldError(msg, focusSel) {
  const el = $('#f-err');
  if (el) { el.textContent = msg; el.hidden = false; } else toast(msg, 6000);
  if (focusSel) $(focusSel)?.focus();
}
const clearError = () => { const el = $('#f-err'); if (el) el.hidden = true; };

function micMessage(e) {
  if (e?.name === 'NotAllowedError' || e?.name === 'SecurityError') {
    return 'The app isn’t allowed to use the microphone. Allow it when asked. If you said no before, turn the microphone back on for Safari in the iPhone Settings app.';
  }
  if (e?.name === 'NotFoundError') return 'No microphone was found.';
  return `The microphone couldn’t start. ${e?.message || ''}`;
}

async function startRecording() {
  if (rec || starting) return;
  const isNew = form.bookId === NEW;
  const title = form.title.trim();
  if (isNew && !title) return fieldError('Enter a title for the new book first.', '#f-title');
  if (!form.target && !(form.number >= 1)) return fieldError('Enter a chapter number.', '#f-num');

  starting = true;
  // iOS only allows audio processing to start inside the tap, so create this before awaiting anything.
  let ctx = null;
  try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { /* meter is optional */ }
  const r = new Recorder(ctx);
  try {
    await r.open();
  } catch (e) {
    r.close();
    starting = false;
    return fieldError(micMessage(e));
  }
  player.pause();

  let bookId = form.bookId, bookTitle = title, createdBook = false;
  try {
    if (isNew) {
      const b = await db.createBook(title);
      bookId = b.id; createdBook = true;
      form.bookId = bookId; form.title = '';
      settings.set('recordBook', bookId);
    } else {
      bookTitle = (await db.getBook(bookId))?.title || '';
    }
    const target = form.target ? { ...form.target, bookId } : { mode: 'new', bookId, number: form.number, name: form.name.trim() };
    const label = targetLabel(target, isNew ? [] : formChapters);
    await r.begin(target);
    r.info = { bookId, bookTitle, label, createdBook };
    r.onchange = state => { if (state === 'interrupted') stopRecording(true); };
    rec = r;
    saved = null;
  } catch (e) {
    r.close();
    if (createdBook) await dropIfEmpty(bookId);
    fieldError(`Recording couldn’t start. ${e.message || ''}`);
  } finally {
    starting = false;
  }
  if (rec) { render(); requestAnimationFrame(recLoop); }
}

function recLoop() {
  if (!rec) return;
  const t = document.getElementById('rec-time');
  if (t) t.textContent = fmtTime(rec.elapsed());
  const m = document.getElementById('rec-meter');
  if (m) m.style.width = Math.round(rec.level() * 100) + '%';
  requestAnimationFrame(recLoop);
}

async function stopRecording(interrupted = false) {
  if (!rec || stopping) return;
  stopping = true;
  const r = rec;
  try {
    const recId = await r.finish();
    const res = await db.finalizeRecording(recId);
    rec = null;
    if (!res) {
      toast('Nothing was recorded.');
      if (r.info.createdBook) await dropIfEmpty(r.info.bookId);
    } else {
      saved = { bookId: res.book.id, chapterId: res.chapter.id, title: chapterTitle(res.chapter), duration: res.duration, interrupted };
      form.target = null; form.touched = false; form.name = '';
      toast(interrupted ? 'Recording stopped early. What you recorded is saved.' : `Saved ${chapterTitle(res.chapter)}`, interrupted ? 6000 : 3500);
      navigator.storage?.persist?.().catch(() => {});
      await player.refresh();
    }
  } catch (e) {
    rec = null;
    r.close();
    toast(`Couldn’t finish saving: ${e.message}. It will be recovered next time the app opens.`, 8000);
  } finally {
    stopping = false;
  }
  render();
}

async function discardRecording() {
  if (!rec) return;
  if (!confirm('Discard this recording? It won’t be saved.')) return;
  const r = rec;
  rec = null;
  await r.discard();
  if (r.info.createdBook) await dropIfEmpty(r.info.bookId);
  toast('Recording discarded');
  render();
}

// A book created for a recording that was then discarded shouldn't be left behind empty.
async function dropIfEmpty(bookId) {
  if (!(await db.chaptersOf(bookId)).length) {
    await db.deleteBook(bookId);
    if (form.bookId === bookId) form.bookId = null;
  }
}

/* ---------- Backup ---------- */

async function backupHTML() {
  const books = (await db.listBooks()).sort((a, b) => a.title.localeCompare(b.title));
  const st = await db.stats();
  let persisted = null;
  try { persisted = (await navigator.storage?.persisted?.()) ?? null; } catch { /* unsupported */ }

  const rows = await Promise.all(books.map(async b => {
    const n = (await db.chaptersOf(b.id)).length;
    const changed = b.backedUpAt && b.updatedAt > b.backedUpAt;
    const note = !b.backedUpAt ? 'not backed up yet' : `backed up ${ago(b.backedUpAt)}${changed ? ', changed since' : ''}`;
    let btn;
    if (prepared.has(b.id)) btn = `<button class="btn small primary" data-act="bk-save" data-book="${b.id}">${icon('share')} Save file</button>`;
    else if (preparing.has(b.id)) btn = `<button class="btn small" disabled>Preparing…</button>`;
    else btn = `<button class="btn small" data-act="bk-make" data-book="${b.id}"${n ? '' : ' disabled'}>Back up</button>`;
    return `<li class="bk">
      <span class="bk-main"><strong>${esc(b.title)}</strong>
        <span class="small ${!b.backedUpAt || changed ? 'warn' : 'muted'}">${plural(n, 'chapter')}, ${note}</span></span>
      ${btn}
    </li>`;
  }));

  return `<header class="top"><h1>Backup</h1></header>
    <section class="card">
      <h2>On this phone</h2>
      <p>${fmtLong(st.seconds)} of recordings in ${plural(books.length, 'book')}, using ${fmtBytes(st.bytes)}.</p>
      <p class="small muted">Your recordings are stored only inside this app on this phone. Removing the app from your home screen deletes them, so back up each book and keep the file in iCloud Drive or Files.</p>
      ${persisted === false ? `<button class="btn small" data-act="persist">Ask the phone to keep recordings when storage is low</button>` : ''}
      ${persisted ? `<p class="small good">${icon('check')} Protected from automatic clean-up</p>` : ''}
    </section>
    ${books.length ? `
      <h2 class="section">Back up a book</h2>
      <p class="small muted">Makes one file holding all of a book's chapters. Tap <strong>Save file</strong>, then choose “Save to Files” and pick iCloud Drive, or AirDrop it to your computer.</p>
      <ul class="card bk-list">${rows.join('')}</ul>` : ''}
    <h2 class="section">Restore</h2>
    <p class="small muted">Pick a backup file to bring a book back. It's added as a new book, so nothing you have now is overwritten.</p>
    <label class="btn wide">${icon('download')} Restore from a backup file
      <input id="restore" class="visually-hidden" type="file" accept=".zip,application/zip">
    </label>`;
}

async function makeBackup(id) {
  preparing.add(id);
  render();
  try { prepared.set(id, await exportBook(id)); }
  catch (e) { toast(`Backup failed: ${e.message}`, 6000); }
  preparing.delete(id);
  render();
}

// Runs straight from the tap: iOS only opens the share sheet in direct response to one.
function saveBackup(id) {
  const file = prepared.get(id);
  if (!file) return;
  shareFiles([file], file.name).then(async res => {
    if (res === 'cancelled') return;
    prepared.delete(id);
    await db.updateBook(id, { backedUpAt: Date.now() });
    toast(res === 'shared' ? 'Backup saved' : 'Backup downloaded');
    render();
  }).catch(e => toast(`Couldn’t share the file: ${e.message}`, 6000));
}

async function restore(file) {
  toast('Restoring…', 120000);
  try {
    const { book, count } = await importBackup(file);
    toast(`Restored “${book.title}” with ${plural(count, 'chapter')}`);
    go('#/book/' + book.id);
  } catch (e) {
    toast(e.message, 7000);
  }
}

/* ---------- menus ---------- */

// Bottom sheet of choices. Resolves with the chosen id, or null. An option's `tap` runs inside the tap itself.
function sheet(title, options) {
  const d = $('#sheet');
  return new Promise(resolve => {
    d.innerHTML = `<form method="dialog">
      ${title ? `<p class="sheet-title">${esc(title)}</p>` : ''}
      ${options.map(o => `<button class="sheet-opt${o.danger ? ' danger' : ''}${o.on ? ' on' : ''}" value="${esc(o.id)}">${esc(o.label)}</button>`).join('')}
      <button class="sheet-opt cancel" value="">Cancel</button>
    </form>`;
    d.onclick = e => {
      if (e.target === d) { d.close(''); return; }
      const b = e.target.closest('button[value]');
      options.find(o => b && o.id === b.value)?.tap?.();
    };
    d.onclose = () => resolve(d.returnValue || null);
    d.returnValue = '';
    d.showModal();
  });
}

async function chapterMenu(id) {
  const c = await db.getChapter(id);
  if (!c) return;
  const title = chapterTitle(c);
  const pick = await sheet(title, [
    { id: 'play', label: 'Play from the start of this chapter', tap: () => player.unlock() },
    { id: 'append', label: 'Record more onto the end' },
    { id: 'replace', label: 'Re-record this chapter' },
    { id: 'rename', label: 'Rename' },
    { id: 'move', label: 'Change chapter number' },
    { id: 'share', label: 'Share the audio' },
    { id: 'delete', label: 'Delete chapter', danger: true },
  ]);
  switch (pick) {
    case 'play':
      return playFrom(c.bookId, c.id, 0);
    case 'append':
    case 'replace':
      form.bookId = c.bookId; form.target = { mode: pick, chapterId: c.id };
      settings.set('recordBook', c.bookId);
      return go('#/record');
    case 'rename': {
      const v = prompt('Chapter name (leave it empty to show just the number)', c.name);
      if (v === null) return;
      await db.renameChapter(c.id, v.trim());
      break;
    }
    case 'move': {
      const count = (await db.chaptersOf(c.bookId)).length;
      const v = prompt(`Move to chapter number (1 to ${count}). The chapters in between shift to make room.`, String(c.number));
      if (v === null) return;
      const n = parseInt(v, 10);
      if (!(n >= 1)) { toast('Enter a whole number.'); return; }
      await db.moveChapter(c.id, n);
      break;
    }
    case 'share': {
      const files = await chapterFiles(c.id);
      if (!files.length) { toast('No audio found for this chapter.'); return; }
      await sheet(`${title} is ready to share`, [
        { id: 'go', label: files.length > 1 ? `Share ${files.length} audio files` : 'Share audio file', tap: () => { shareFiles(files, title).catch(e => toast(e.message)); } },
      ]);
      return;
    }
    case 'delete':
      if (!confirm(`Delete ${title}? Its recording will be gone for good.`)) return;
      await db.deleteChapter(c.id);
      toast(`Deleted ${title}`);
      break;
    default:
      return;
  }
  await player.refresh();
  render();
}

async function bookMenu(id) {
  const b = await db.getBook(id);
  if (!b) return;
  const pick = await sheet(b.title, [
    { id: 'rename', label: 'Rename book' },
    { id: 'backup', label: 'Back up this book' },
    { id: 'delete', label: 'Delete book', danger: true },
  ]);
  if (pick === 'rename') {
    const v = prompt('Book title', b.title);
    if (!v || !v.trim()) return;
    await db.updateBook(id, { title: v.trim(), updatedAt: Date.now() });
    await player.refresh();
    render();
  } else if (pick === 'backup') {
    go('#/backup');
  } else if (pick === 'delete') {
    const n = (await db.chaptersOf(id)).length;
    if (!confirm(`Delete “${b.title}” and its ${plural(n, 'chapter')}? This can’t be undone, so back it up first if you might want it again.`)) return;
    if (player.book?.id === id) player.unload();
    if (resumeHint?.bookId === id) resumeHint = null;
    await db.deleteBook(id);
    toast('Book deleted');
    syncPlayer();
    go('#/listen');
  }
}

/* ---------- playback ---------- */

async function playFrom(bookId, chapterId, time) {
  if (rec) { toast('Stop recording before playing.'); return; }
  resumeHint = null;
  const ok = await player.open(bookId, chapterId, time, true);
  if (!ok) toast('This book has no chapters yet.');
}

async function continueBook(bookId) {
  if (player.book?.id === bookId && player.playing) return openPlayer();
  const [chs, prog] = await Promise.all([db.chaptersOf(bookId), db.getProgress(bookId)]);
  if (!chs.length) return;
  const w = where(chs, prog);
  if (w.state === 'done') return playFrom(bookId, chs[0].id, 0);
  // Step back a few seconds so you catch the end of the last sentence.
  return playFrom(bookId, chs[w.index].id, w.time > 3 ? w.time - 3 : 0);
}

const rateLabel = r => `${r}×`;

function sleepLabel() {
  const s = player.sleep;
  if (!s) return 'Sleep timer';
  if (s.type === 'chapter') return 'End of chapter';
  return `${Math.max(1, Math.ceil((s.until - Date.now()) / 60000))} min left`;
}

function syncPlayer() {
  const c = player.chapter;
  const mini = $('#mini'), open = $('#mini-open'), toggle = $('#mini-toggle');
  if (c) {
    mini.hidden = false;
    open.dataset.act = 'np-open'; delete open.dataset.book;
    toggle.dataset.act = 'toggle'; delete toggle.dataset.book;
    $('#mini-title').textContent = chapterTitle(c);
    $('#mini-sub').textContent = player.book.title;
  } else if (resumeHint) {
    mini.hidden = false;
    open.dataset.act = toggle.dataset.act = 'continue';
    open.dataset.book = toggle.dataset.book = resumeHint.bookId;
    $('#mini-title').textContent = resumeHint.title;
    $('#mini-sub').textContent = resumeHint.sub;
    $('#mini-bar').style.width = resumeHint.pct + '%';
  } else {
    mini.hidden = true;
  }
  document.body.classList.toggle('has-mini', !mini.hidden);

  const playing = player.playing;
  for (const b of document.querySelectorAll('.js-toggle')) {
    b.innerHTML = icon(playing ? 'pause' : 'play', 'fill');
    b.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }
  if (!c) { closePlayer(); return; }
  $('#np-book').textContent = player.book.title;
  $('#np-title').textContent = chapterTitle(c);
  $('#np-sub').textContent = `Chapter ${c.number} of ${player.chapters.length}`;
  $('#np-cover').className = `np-cover cover ${coverClass(player.book.title)}`;
  $('#np-speed').textContent = rateLabel(player.rate);
  syncTime();
}

function syncTime() {
  if (!player.chapter) return;
  const d = player.duration, p = player.position;
  const s = $('#np-seek');
  if (!seeking) {
    s.max = String(d || 0);
    s.value = String(p);
    $('#np-pos').textContent = fmtTime(p);
  }
  $('#np-left').textContent = '-' + fmtTime(Math.max(0, d - p));
  $('#mini-bar').style.width = (d ? (p / d) * 100 : 0) + '%';
  $('#np-sleep').textContent = sleepLabel();
}

function openPlayer() {
  if (!player.chapter) return;
  $('#np').hidden = false;
  document.body.classList.add('np-open');
  syncPlayer();
}

function closePlayer() {
  $('#np').hidden = true;
  document.body.classList.remove('np-open');
}

const onBookPage = id => id && location.hash === `#/book/${id}`;

let wasPlaying = false;
player.addEventListener('change', () => {
  syncPlayer();
  // Refresh the book page's "Up to..." line when playback pauses.
  if (wasPlaying && !player.playing && onBookPage(player.book?.id)) render();
  wasPlaying = player.playing;
});
player.addEventListener('time', syncTime);
player.addEventListener('chapter', () => { if (onBookPage(player.book?.id)) render(); });
player.addEventListener('finished', () => {
  const last = player.i === player.chapters.length - 1;
  toast(last ? 'That’s the end of the book.' : `End of ${chapterTitle(player.chapter)}`);
  if (onBookPage(player.book?.id)) render();
});
player.addEventListener('sleep', () => toast('Sleep timer: paused'));
player.addEventListener('error', () => toast('That chapter couldn’t be played.'));

const seekEl = $('#np-seek');
seekEl.addEventListener('input', () => { seeking = true; $('#np-pos').textContent = fmtTime(+seekEl.value); });
seekEl.addEventListener('change', async () => { await player.seek(+seekEl.value); seeking = false; syncTime(); });

async function sleepMenu() {
  const s = player.sleep;
  const pick = await sheet('Sleep timer', [
    { id: '15', label: '15 minutes' }, { id: '30', label: '30 minutes' },
    { id: '45', label: '45 minutes' }, { id: '60', label: '1 hour' },
    { id: 'chapter', label: 'End of this chapter', on: s?.type === 'chapter' },
    ...(s ? [{ id: 'off', label: 'Turn off', danger: true }] : []),
  ]);
  if (!pick) return;
  player.setSleep(pick === 'off' ? null : pick === 'chapter' ? 'chapter' : +pick);
  if (pick !== 'off') toast(pick === 'chapter' ? 'Will pause at the end of this chapter' : `Will pause in ${pick} minutes`);
}

/* ---------- events ---------- */

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const act = el.dataset.act, d = el.dataset;
  if (PLAY_ACTIONS.has(act)) player.unlock(); // must happen inside the tap, before any await
  switch (act) {
    case 'continue': return continueBook(d.book);
    case 'from-start': return playFrom(d.book, null, 0);
    case 'play-ch': return playFrom(d.book, d.ch, 0);
    case 'mode':
      player.mode = d.mode;
      settings.set('mode', d.mode);
      return render();
    case 'ch-menu': return chapterMenu(d.ch);
    case 'book-menu': return bookMenu(d.book);
    case 'record-into':
      form.bookId = d.book; form.target = null; form.touched = false;
      settings.set('recordBook', d.book);
      return; // the link itself goes to #/record
    case 'add-to':
      form.target = { mode: 'append', chapterId: d.ch };
      return render();
    case 'target-cancel':
      form.target = null;
      return render();
    case 'rec-start': return startRecording();
    case 'rec-pause':
      if (rec) { rec.state === 'paused' ? rec.resume() : rec.pause(); render(); }
      return;
    case 'rec-stop': return stopRecording();
    case 'rec-discard': return discardRecording();
    case 'bk-make': return makeBackup(d.book);
    case 'bk-save': return saveBackup(d.book);
    case 'persist':
      return navigator.storage?.persist?.().then(ok => { toast(ok ? 'Recordings are protected from clean-up' : 'The phone didn’t allow it this time'); render(); });
    case 'np-open': return openPlayer();
    case 'np-close': return closePlayer();
    case 'toggle': return player.toggle();
    case 'back15': return player.skip(-15);
    case 'fwd30': return player.skip(30);
    case 'prev': return player.prev();
    case 'next': return player.next();
    case 'speed': {
      const r = SPEEDS[(SPEEDS.indexOf(player.rate) + 1) % SPEEDS.length];
      player.setRate(r);
      settings.set('rate', r);
      return;
    }
    case 'sleep': return sleepMenu();
    case 'np-chapters':
      closePlayer();
      return go('#/book/' + player.book.id);
  }
});

view.addEventListener('input', e => {
  const t = e.target;
  if (t.id === 'f-num') {
    const n = parseInt(t.value, 10);
    form.number = Number.isFinite(n) ? n : null;
    form.touched = t.value !== '';
    const h = $('#f-hint');
    if (h) h.textContent = numberHint(form.number, formChapters);
    clearError();
  } else if (t.id === 'f-name') {
    form.name = t.value;
  } else if (t.id === 'f-title') {
    form.title = t.value;
    clearError();
  }
});

view.addEventListener('change', e => {
  const t = e.target;
  if (t.id === 'f-book') {
    form.bookId = t.value; form.touched = false; form.target = null;
    if (t.value !== NEW) settings.set('recordBook', t.value);
    render();
  } else if (t.id === 'restore') {
    const file = t.files?.[0];
    t.value = '';
    if (file) restore(file);
  }
});

window.addEventListener('hashchange', render);
window.addEventListener('beforeunload', e => { if (rec) { e.preventDefault(); e.returnValue = ''; } });

let toastTimer;
function toast(msg, ms = 3500) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

/* ---------- start-up ---------- */

// A recording that was cut off (app closed, phone restarted) is saved as a chapter.
async function recoverRecordings() {
  for (const p of await db.listPending()) {
    try {
      const res = await db.finalizeRecording(p.recId);
      if (res) toast(`Recovered a recording that was cut off: ${chapterTitle(res.chapter)} in “${res.book.title}”.`, 8000);
    } catch (e) { console.error(e); }
  }
}

// Offer the most recently played book in the mini player, ready to continue.
async function findResumeHint() {
  const all = await db.listProgress();
  all.sort((a, b) => b.updatedAt - a.updatedAt);
  for (const p of all) {
    const [book, chs] = await Promise.all([db.getBook(p.bookId), db.chaptersOf(p.bookId)]);
    if (!book || !chs.length) continue;
    const w = where(chs, p);
    if (w.state === 'done') return;
    const c = chs[w.index];
    resumeHint = { bookId: book.id, title: chapterTitle(c), sub: `${book.title} · continue from ${fmtTime(w.time)}`, pct: c.duration ? (w.time / c.duration) * 100 : 0 };
    return;
  }
}

async function boot() {
  if (!location.hash || location.hash === '#') location.replace('#/listen');
  try { await recoverRecordings(); } catch (e) { console.error(e); }
  try { await findResumeHint(); } catch (e) { console.error(e); }
  syncPlayer();
  render();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

boot();
