// Backups: one .zip per book holding the audio plus a book.json with titles and chapter order.
import * as db from './db.js';
import { makeZip, readZip } from './zip.js';

const ext = mime => (/mp4|aac|m4a/.test(mime) ? 'm4a' : /webm/.test(mime) ? 'webm' : /ogg/.test(mime) ? 'ogg' : /wav/.test(mime) ? 'wav' : 'audio');
const safe = s => String(s).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Untitled';
const pad = n => String(n).padStart(2, '0');

function audioName(ch, k, mime) {
  const label = ch.name ? safe(ch.name) : `Chapter ${ch.number}`;
  return `${pad(ch.number)} ${label}${ch.parts.length > 1 ? ` (part ${k + 1})` : ''}.${ext(mime)}`;
}

export async function exportBook(bookId) {
  const book = await db.getBook(bookId);
  const chapters = await db.chaptersOf(bookId);
  const manifest = { app: 'audiobooks', version: 1, exportedAt: new Date().toISOString(), book: { title: book.title }, chapters: [] };
  const entries = [];
  for (const ch of chapters) {
    const parts = [];
    for (let k = 0; k < ch.parts.length; k++) {
      const p = ch.parts[k];
      const blob = await db.getAudio(p.audioId);
      if (!blob) continue;
      const file = 'audio/' + audioName(ch, k, p.mime);
      entries.push({ name: file, blob });
      parts.push({ file, duration: p.duration, mime: p.mime });
    }
    manifest.chapters.push({ number: ch.number, name: ch.name, parts });
  }
  entries.unshift({ name: 'book.json', blob: new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }) });
  const zip = await makeZip(entries);
  return new File([zip], `${safe(book.title)} - audiobook backup.zip`, { type: 'application/zip' });
}

export async function importBackup(file) {
  const files = new Map((await readZip(file)).map(e => [e.name, e.blob]));
  const mf = files.get('book.json');
  if (!mf) throw new Error("That file isn't an audiobook backup.");
  let m;
  try { m = JSON.parse(await mf.text()); } catch { throw new Error('The backup file is damaged.'); }
  if (m.app !== 'audiobooks' || !Array.isArray(m.chapters)) throw new Error("That file isn't an audiobook backup.");

  const chapters = m.chapters.slice().sort((a, b) => a.number - b.number).map(c => ({
    name: c.name || '',
    parts: (c.parts || []).map(p => {
      const blob = files.get(p.file);
      if (!blob) throw new Error(`The backup is missing ${p.file}.`);
      return { blob: new Blob([blob], { type: p.mime }), duration: +p.duration || 0, mime: p.mime };
    }),
  })).filter(c => c.parts.length);

  const existing = new Set((await db.listBooks()).map(b => b.title));
  let title = m.book?.title || 'Restored book';
  if (existing.has(title)) title += ' (restored)';
  return db.importBook(title, chapters);
}

// The audio of one chapter as shareable files (one per recorded part).
export async function chapterFiles(chapterId) {
  const ch = await db.getChapter(chapterId);
  const book = await db.getBook(ch.bookId);
  const out = [];
  for (let k = 0; k < ch.parts.length; k++) {
    const p = ch.parts[k];
    const blob = await db.getAudio(p.audioId);
    if (blob) out.push(new File([blob], `${safe(book.title)} - ${audioName(ch, k, p.mime)}`, { type: p.mime }));
  }
  return out;
}

// Opens the iPhone share sheet (Save to Files, AirDrop...). Call it directly from a tap.
// Falls back to a plain download where sharing files isn't supported.
export async function shareFiles(files, title) {
  if (navigator.canShare?.({ files })) {
    try { await navigator.share({ files, title }); return 'shared'; }
    catch (e) { if (e.name === 'AbortError') return 'cancelled'; throw e; }
  }
  for (const f of files) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(f);
    a.download = f.name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }
  return 'downloaded';
}
