// All data lives in IndexedDB on the device.
//   books     {id, title, createdAt, updatedAt, playedAt, backedUpAt}
//   chapters  {id, bookId, number, name, parts:[{audioId, duration, mime}], duration, createdAt}
//   audio     {id, blob}
//   progress  {bookId, chapterId, number, time, updatedAt}   one bookmark per book
//   pending   {recId, target, mime, elapsed, startedAt}       a recording in progress
//   chunks    {recId, seq, blob}                              its audio so far, saved every few seconds
import { uid, clamp } from './util.js';

let opening = null;

export function open() {
  if (!opening) {
    opening = new Promise((resolve, reject) => {
      const r = indexedDB.open('audiobooks', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('books', { keyPath: 'id' });
        d.createObjectStore('chapters', { keyPath: 'id' }).createIndex('bookId', 'bookId');
        d.createObjectStore('audio', { keyPath: 'id' });
        d.createObjectStore('progress', { keyPath: 'bookId' });
        d.createObjectStore('pending', { keyPath: 'recId' });
        d.createObjectStore('chunks', { keyPath: ['recId', 'seq'] });
      };
      r.onsuccess = () => { const d = r.result; d.onversionchange = () => d.close(); resolve(d); };
      r.onerror = () => { opening = null; reject(r.error); };
      r.onblocked = () => { opening = null; reject(new Error('Close other copies of the app and try again.')); };
    });
  }
  return opening;
}

const P = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const S = (t, name) => t.objectStore(name);

// Run `body` inside one transaction; resolves with its result once the transaction commits.
async function run(names, mode, body) {
  const d = await open();
  const t = d.transaction(names, mode);
  const done = new Promise((res, rej) => {
    t.oncomplete = res;
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('Saving failed.'));
  });
  let result;
  try {
    result = await body(t);
  } catch (e) {
    try { t.abort(); } catch { /* already finished */ }
    await done.catch(() => {});
    throw e;
  }
  await done;
  return result;
}

const chunkRange = recId => IDBKeyRange.bound([recId, 0], [recId, Infinity]);
const byNumber = (a, b) => a.number - b.number;
const sumDur = parts => parts.reduce((s, p) => s + (p.duration || 0), 0);

async function chaptersIn(t, bookId) {
  return (await P(S(t, 'chapters').index('bookId').getAll(bookId))).sort(byNumber);
}

// Give the chapters in `list` the numbers 1..n in list order, writing only the ones that changed.
function renumber(t, list) {
  list.forEach((c, i) => {
    if (c.number !== i + 1) { c.number = i + 1; S(t, 'chapters').put(c); }
  });
}

async function touch(t, bookId, field = 'updatedAt') {
  const b = await P(S(t, 'books').get(bookId));
  if (b) { b[field] = Date.now(); S(t, 'books').put(b); }
  return b;
}

const newBook = title => ({ id: uid(), title, createdAt: Date.now(), updatedAt: Date.now(), playedAt: 0, backedUpAt: 0 });

/* ---------- books ---------- */

export const listBooks = () => run(['books'], 'readonly', t => P(S(t, 'books').getAll()));
export const getBook = id => run(['books'], 'readonly', t => P(S(t, 'books').get(id)));

export async function createBook(title) {
  const b = newBook(title);
  await run(['books'], 'readwrite', t => P(S(t, 'books').put(b)));
  return b;
}

export const updateBook = (id, patch) => run(['books'], 'readwrite', async t => {
  const b = await P(S(t, 'books').get(id));
  if (!b) return null;
  Object.assign(b, patch);
  S(t, 'books').put(b);
  return b;
});

export const deleteBook = id => run(['books', 'chapters', 'audio', 'progress'], 'readwrite', async t => {
  for (const c of await chaptersIn(t, id)) {
    c.parts.forEach(p => S(t, 'audio').delete(p.audioId));
    S(t, 'chapters').delete(c.id);
  }
  S(t, 'progress').delete(id);
  S(t, 'books').delete(id);
});

/* ---------- chapters ---------- */

export const chaptersOf = bookId => run(['chapters'], 'readonly', t => chaptersIn(t, bookId));
export const getChapter = id => run(['chapters'], 'readonly', t => P(S(t, 'chapters').get(id)));

export const renameChapter = (id, name) => run(['chapters', 'books'], 'readwrite', async t => {
  const c = await P(S(t, 'chapters').get(id));
  if (!c) return;
  c.name = name;
  S(t, 'chapters').put(c);
  await touch(t, c.bookId);
});

// Move a chapter to a new number; the chapters in between shift by one to make room.
export const moveChapter = (id, number) => run(['chapters', 'books'], 'readwrite', async t => {
  const c = await P(S(t, 'chapters').get(id));
  if (!c) return;
  const list = await chaptersIn(t, c.bookId);
  const [item] = list.splice(list.findIndex(x => x.id === id), 1);
  list.splice(clamp(number, 1, list.length + 1) - 1, 0, item);
  renumber(t, list);
  await touch(t, c.bookId);
});

// Delete a chapter; later chapters move up to close the gap.
export const deleteChapter = id => run(['chapters', 'audio', 'books'], 'readwrite', async t => {
  const c = await P(S(t, 'chapters').get(id));
  if (!c) return;
  c.parts.forEach(p => S(t, 'audio').delete(p.audioId));
  S(t, 'chapters').delete(id);
  renumber(t, (await chaptersIn(t, c.bookId)).filter(x => x.id !== id));
  await touch(t, c.bookId);
});

// The player measures real durations; fix small drift in the stored one.
export const updatePartDuration = (id, k, duration) => run(['chapters'], 'readwrite', async t => {
  const c = await P(S(t, 'chapters').get(id));
  if (!c || !c.parts[k]) return null;
  c.parts[k].duration = duration;
  c.duration = sumDur(c.parts);
  S(t, 'chapters').put(c);
  return c;
});

export const getAudio = id => run(['audio'], 'readonly', async t => (await P(S(t, 'audio').get(id)))?.blob || null);

/* ---------- listening position ---------- */

export const getProgress = bookId => run(['progress'], 'readonly', t => P(S(t, 'progress').get(bookId)));
export const listProgress = () => run(['progress'], 'readonly', t => P(S(t, 'progress').getAll()));

export const putProgress = p => run(['progress', 'books'], 'readwrite', async t => {
  S(t, 'progress').put(p);
  await touch(t, p.bookId, 'playedAt');
});

/* ---------- recording in progress ---------- */

export const putPending = p => run(['pending'], 'readwrite', t => P(S(t, 'pending').put(p)));
export const listPending = () => run(['pending'], 'readonly', t => P(S(t, 'pending').getAll()));

export const putChunk = (recId, seq, blob, elapsed) => run(['chunks', 'pending'], 'readwrite', async t => {
  S(t, 'chunks').put({ recId, seq, blob });
  const p = await P(S(t, 'pending').get(recId));
  if (p) { p.elapsed = elapsed; S(t, 'pending').put(p); }
});

export const setPendingElapsed = (recId, elapsed) => run(['pending'], 'readwrite', async t => {
  const p = await P(S(t, 'pending').get(recId));
  if (p) { p.elapsed = elapsed; S(t, 'pending').put(p); }
});

export const discardRecording = recId => run(['chunks', 'pending'], 'readwrite', t => {
  S(t, 'chunks').delete(chunkRange(recId));
  S(t, 'pending').delete(recId);
});

// Turn a finished (or cut-off) recording into chapter audio. Used both after "Stop and save" and to
// recover a recording the app was closed in the middle of. Everything is written in one transaction,
// so a recording can't be saved twice.
//   target.mode 'new'     -> insert as chapter `number`; that chapter and later ones move down one
//   target.mode 'append'  -> add onto the end of chapter `chapterId`
//   target.mode 'replace' -> replace the audio of chapter `chapterId`
export async function finalizeRecording(recId) {
  const pending = await run(['pending'], 'readonly', t => P(S(t, 'pending').get(recId)));
  if (!pending) return null;
  const chunks = await run(['chunks'], 'readonly', t => P(S(t, 'chunks').getAll(chunkRange(recId))));
  chunks.sort((a, b) => a.seq - b.seq);
  const blob = new Blob(chunks.map(c => c.blob), { type: pending.mime });

  return run(['books', 'chapters', 'audio', 'pending', 'chunks'], 'readwrite', async t => {
    S(t, 'chunks').delete(chunkRange(recId));
    S(t, 'pending').delete(recId);
    if (!blob.size) return null;

    const tg = { ...pending.target };
    let book = await P(S(t, 'books').get(tg.bookId));
    if (!book) { book = newBook('Recovered recordings'); tg.mode = 'new'; tg.number = Infinity; }
    let ch = tg.chapterId ? await P(S(t, 'chapters').get(tg.chapterId)) : null;
    if (tg.mode !== 'new' && !ch) { tg.mode = 'new'; tg.number = Infinity; }

    const audioId = uid();
    S(t, 'audio').put({ id: audioId, blob });
    const part = { audioId, duration: Math.max(0, pending.elapsed || 0), mime: pending.mime };

    if (tg.mode === 'new') {
      const list = await chaptersIn(t, book.id);
      ch = { id: uid(), bookId: book.id, number: 0, name: tg.name || '', parts: [part], duration: part.duration, createdAt: Date.now() };
      list.splice(clamp(tg.number || Infinity, 1, list.length + 1) - 1, 0, ch);
      renumber(t, list);
    } else {
      if (tg.mode === 'replace') { ch.parts.forEach(p => S(t, 'audio').delete(p.audioId)); ch.parts = []; }
      ch.parts.push(part);
      ch.duration = sumDur(ch.parts);
      S(t, 'chapters').put(ch);
    }
    book.updatedAt = Date.now();
    S(t, 'books').put(book);
    return { book, chapter: ch, mode: tg.mode, duration: part.duration };
  });
}

/* ---------- backup and storage ---------- */

// chapters: [{name, parts:[{blob, duration, mime}]}] in order
export const importBook = (title, chapters) => run(['books', 'chapters', 'audio'], 'readwrite', t => {
  const book = newBook(title);
  S(t, 'books').put(book);
  chapters.forEach((c, i) => {
    const parts = c.parts.map(p => {
      const audioId = uid();
      S(t, 'audio').put({ id: audioId, blob: p.blob });
      return { audioId, duration: p.duration, mime: p.mime };
    });
    S(t, 'chapters').put({ id: uid(), bookId: book.id, number: i + 1, name: c.name || '', parts, duration: sumDur(parts), createdAt: Date.now() });
  });
  return { book, count: chapters.length };
});

export const stats = () => run(['chapters', 'audio'], 'readonly', async t => {
  const chapters = await P(S(t, 'chapters').getAll());
  const audio = await P(S(t, 'audio').getAll());
  return { seconds: chapters.reduce((s, c) => s + c.duration, 0), bytes: audio.reduce((s, a) => s + (a.blob?.size || 0), 0) };
});
