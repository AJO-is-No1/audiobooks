// Playback. One <audio> element plays a chapter; a chapter can be made of several recorded parts
// (when you record more onto the end), which play back to back as if they were one file.
import * as db from './db.js';
import { clamp, chapterTitle } from './util.js';

// A tenth of a second of silence, played inside a tap so iOS lets the app start audio later on.
const SILENCE = (() => {
  const n = 800, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true); v.setUint32(28, 16000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * 2, true);
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return 'data:audio/wav;base64,' + btoa(s);
})();

export class Player extends EventTarget {
  constructor(el) {
    super();
    this.el = el;
    this.book = null;
    this.chapters = [];
    this.i = -1;            // index of the current chapter
    this.part = 0;          // index of the current part within the chapter
    this.offsets = [];      // start time of each part within the chapter
    this.mode = 'book';     // 'book' = carry on into the next chapter, 'chapter' = stop at the end of each
    this.rate = 1;
    this.sleep = null;      // {type:'time', until} | {type:'chapter'}
    this.atEnd = false;
    this.busy = false;      // true while a new source is loading
    this.quiet = false;     // true while the unlock silence is playing
    this.lastSave = 0;

    const live = fn => (...a) => { if (!this.busy && !this.quiet) fn(...a); };
    el.addEventListener('timeupdate', live(() => this.tick()));
    el.addEventListener('ended', live(() => this.partEnded()));
    el.addEventListener('play', live(() => this.emit()));
    el.addEventListener('pause', live(() => { this.save(true); this.emit(); }));
    el.addEventListener('error', live(() => this.emit('error')));
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.save(true); });
    window.addEventListener('pagehide', () => this.save(true));
    this.mediaSession();
  }

  emit(type = 'change') { this.dispatchEvent(new Event(type)); }

  get chapter() { return this.chapters[this.i] || null; }
  get playing() { return !!this.chapter && !this.el.paused && !this.el.ended; }
  get duration() { return this.chapter?.duration || 0; }
  get position() {
    const c = this.chapter;
    if (!c) return 0;
    if (this.atEnd) return c.duration;
    return clamp((this.offsets[this.part] || 0) + (this.el.currentTime || 0), 0, c.duration);
  }

  // Call synchronously inside a tap, before anything that awaits, when the tap will start playback.
  unlock() {
    if (this.unlocked) return;
    this.unlocked = true;
    this.quiet = true;
    this.el.src = SILENCE;
    this.el.play().catch(() => {});
  }

  async open(bookId, chapterId, time = 0, autoplay = true) {
    const [book, chapters] = await Promise.all([db.getBook(bookId), db.chaptersOf(bookId)]);
    if (!book || !chapters.length) return false;
    this.book = book;
    this.chapters = chapters;
    const i = Math.max(0, chapters.findIndex(c => c.id === chapterId));
    await this.loadChapter(i, time, autoplay);
    return true;
  }

  async loadChapter(i, time, autoplay) {
    this.i = i;
    this.atEnd = false;
    this.computeOffsets();
    const { part, offset } = this.locate(time);
    await this.loadPart(part, offset, autoplay);
    this.updateMetadata();
    if (autoplay) this.save(true);
    this.emit('chapter');
    this.emit();
  }

  computeOffsets() {
    let acc = 0;
    this.offsets = this.chapter.parts.map(p => { const o = acc; acc += p.duration; return o; });
  }

  locate(t) {
    const parts = this.chapter.parts;
    let k = parts.length - 1;
    for (let j = 0; j < parts.length; j++) if (t < this.offsets[j] + parts[j].duration) { k = j; break; }
    return { part: k, offset: Math.max(0, t - this.offsets[k]) };
  }

  async loadPart(k, offset, autoplay) {
    const c = this.chapter;
    this.busy = true;
    this.part = k;
    try {
      const blob = await db.getAudio(c.parts[k].audioId);
      if (!blob) throw new Error('missing audio');
      if (this.url) URL.revokeObjectURL(this.url);
      this.url = URL.createObjectURL(blob);
      const el = this.el;
      this.quiet = false;
      await new Promise(res => {
        const done = () => { el.removeEventListener('loadedmetadata', done); el.removeEventListener('error', done); res(); };
        el.addEventListener('loadedmetadata', done);
        el.addEventListener('error', done);
        el.src = this.url;
        el.load();
      });
      el.defaultPlaybackRate = el.playbackRate = this.rate;
      this.fixDuration(c, k);
      if (offset > 0.05) { try { el.currentTime = offset; } catch { /* ignore */ } }
    } finally {
      this.busy = false;
    }
    if (autoplay) await this.play();
  }

  // Stored durations come from the recording timer; if the file reports something slightly
  // different, trust the file.
  fixDuration(c, k) {
    const real = this.el.duration, stored = c.parts[k].duration;
    if (!isFinite(real) || real <= 0 || Math.abs(real - stored) < 0.3 || Math.abs(real - stored) > Math.max(2, stored * 0.1)) return;
    c.parts[k].duration = real;
    c.duration = c.parts.reduce((s, p) => s + p.duration, 0);
    this.computeOffsets();
    db.updatePartDuration(c.id, k, real).catch(() => {});
  }

  async play() {
    if (!this.chapter) return;
    if (this.atEnd) {
      // Finished this chapter: play on into the next one, or start this one again if it was the last.
      return this.loadChapter(this.i + 1 < this.chapters.length ? this.i + 1 : this.i, 0, true);
    }
    try { await this.el.play(); } catch (e) { if (e.name !== 'AbortError') this.emit('error'); }
  }

  pause() { if (this.chapter) this.el.pause(); }
  toggle() { return this.playing ? this.pause() : this.play(); }

  async seek(t) {
    const c = this.chapter;
    if (!c) return;
    const was = this.playing;
    t = clamp(t, 0, Math.max(0, c.duration - 0.2));
    this.atEnd = false;
    const { part, offset } = this.locate(t);
    if (part !== this.part) await this.loadPart(part, offset, was);
    else this.el.currentTime = offset;
    this.save(true);
    this.emit();
  }

  skip(delta) { return this.seek(this.position + delta); }

  async next() {
    if (this.i + 1 < this.chapters.length) await this.loadChapter(this.i + 1, 0, this.playing || this.atEnd);
  }

  async prev() {
    if (this.position > 3 || this.i === 0) await this.seek(0);
    else await this.loadChapter(this.i - 1, 0, this.playing || this.atEnd);
  }

  setRate(r) {
    this.rate = r;
    this.el.defaultPlaybackRate = this.el.playbackRate = r;
    this.emit();
  }

  setSleep(v) {
    this.sleep = v === 'chapter' ? { type: 'chapter' } : v ? { type: 'time', until: Date.now() + v * 60000 } : null;
    this.emit();
  }

  async partEnded() {
    const c = this.chapter;
    if (!c) return;
    if (this.part + 1 < c.parts.length) return this.loadPart(this.part + 1, 0, true);
    // Chapter finished.
    this.atEnd = true;
    await this.save(true);
    if (this.sleep?.type === 'chapter') { this.sleep = null; this.emit('sleep'); this.emit(); return; }
    if (this.mode === 'book' && this.i + 1 < this.chapters.length) return this.loadChapter(this.i + 1, 0, true);
    this.emit('finished');
    this.emit();
  }

  tick() {
    this.save();
    if (this.sleep?.type === 'time' && Date.now() >= this.sleep.until) {
      this.sleep = null;
      this.pause();
      this.emit('sleep');
    }
    this.positionState();
    this.emit('time');
  }

  // Remember the listening position: every 5 s while playing, and immediately on pause, seek,
  // chapter change and when the app goes into the background.
  save(force = false) {
    const c = this.chapter;
    if (!c || !this.book || this.busy || this.quiet) return;
    const now = Date.now();
    if (!force && now - this.lastSave < 5000) return;
    this.lastSave = now;
    return db.putProgress({ bookId: this.book.id, chapterId: c.id, number: c.number, time: this.position, updatedAt: now }).catch(() => {});
  }

  // After chapters are renamed, renumbered or deleted.
  async refresh() {
    if (!this.book) return;
    const [book, list] = await Promise.all([db.getBook(this.book.id), db.chaptersOf(this.book.id)]);
    const cur = this.chapter;
    const i = cur ? list.findIndex(c => c.id === cur.id) : -1;
    const same = i >= 0 && list[i].parts.map(p => p.audioId).join() === cur.parts.map(p => p.audioId).join();
    if (!book || !same) return this.unload();
    this.book = book;
    this.chapters = list;
    this.i = i;
    this.updateMetadata();
    this.emit('chapter');
    this.emit();
  }

  unload() {
    this.el.pause();
    this.el.removeAttribute('src');
    this.el.load();
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
    this.book = null;
    this.chapters = [];
    this.i = -1;
    this.atEnd = false;
    this.emit('chapter');
    this.emit();
  }

  /* ---------- lock screen and headphone controls ---------- */

  mediaSession() {
    const ms = navigator.mediaSession;
    if (!ms) return;
    const on = (action, fn) => { try { ms.setActionHandler(action, fn); } catch { /* unsupported action */ } };
    on('play', () => this.play());
    on('pause', () => this.pause());
    on('seekbackward', d => this.skip(-(d?.seekOffset || 15)));
    on('seekforward', d => this.skip(d?.seekOffset || 30));
    on('previoustrack', () => this.prev());
    on('nexttrack', () => this.next());
    on('seekto', d => this.seek(d.seekTime));
  }

  updateMetadata() {
    const c = this.chapter;
    if (!c || !navigator.mediaSession || !window.MediaMetadata) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: chapterTitle(c),
      artist: this.book.title,
      album: this.book.title,
      artwork: [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
    });
  }

  positionState() {
    const c = this.chapter;
    try {
      if (c && c.duration > 0) navigator.mediaSession?.setPositionState?.({ duration: c.duration, position: this.position, playbackRate: this.rate });
    } catch { /* ignore */ }
  }
}
