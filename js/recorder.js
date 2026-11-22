// Microphone recording. Audio is written to storage every few seconds while you record, so if the
// phone locks, a call comes in or the app is closed, everything up to that point is kept.
import * as db from './db.js';
import { uid } from './util.js';

const SLICE_MS = 3000;
// iPhone records AAC in an .m4a container; other browsers usually fall back to Opus/WebM.
const TYPES = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/aac', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];

export const canRecord = () => !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);

const sleep = ms => new Promise(r => setTimeout(r, ms));

export class Recorder {
  // Pass an AudioContext created inside the tap that starts recording (iOS only allows it there).
  constructor(ctx) {
    this.ctx = ctx;
    this.state = 'idle';           // idle | recording | paused | interrupted | stopped
    this.seq = 0;
    this.base = 0;                 // seconds recorded before the current stretch
    this.since = 0;                // when the current stretch started (performance.now)
    this.writes = Promise.resolve();
    this.onchange = null;
  }

  // Step 1: ask for the microphone. Call this first thing in the tap handler.
  async open() {
    // Narration sounds most natural with the phone's call-style voice processing turned off.
    const raw = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 };
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: raw });
    } catch (e) {
      if (e.name === 'NotAllowedError' || e.name === 'SecurityError') throw e;
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }
    try {
      if (this.ctx) {
        if (this.ctx.state === 'suspended') await this.ctx.resume();
        const src = this.ctx.createMediaStreamSource(this.stream);
        this.analyser = this.ctx.createAnalyser();
        this.analyser.fftSize = 1024;
        src.connect(this.analyser);
        this.buf = new Float32Array(this.analyser.fftSize);
      }
    } catch { /* the level meter is optional */ }
  }

  // Step 2: start recording towards `target` (see db.finalizeRecording).
  async begin(target) {
    const type = TYPES.find(t => window.MediaRecorder.isTypeSupported?.(t));
    let rec;
    try { rec = new MediaRecorder(this.stream, { ...(type ? { mimeType: type } : {}), audioBitsPerSecond: 96000 }); }
    catch { rec = new MediaRecorder(this.stream); }
    this.rec = rec;
    this.recId = uid();
    this.mime = rec.mimeType || type || 'audio/mp4';
    await db.putPending({ recId: this.recId, target, mime: this.mime, elapsed: 0, startedAt: Date.now() });

    rec.ondataavailable = e => {
      if (!e.data || !e.data.size) return;
      const seq = this.seq++, elapsed = this.elapsed();
      this.writes = this.writes.then(() => db.putChunk(this.recId, seq, e.data, elapsed)).catch(err => { this.writeError = err; });
    };
    this.stopped = new Promise(res => { rec.onstop = res; });
    rec.onerror = () => this.interrupt();
    for (const tr of this.stream.getAudioTracks()) {
      tr.onended = () => this.interrupt();
      tr.onmute = () => this.interrupt();     // iOS mutes the mic when the phone locks or a call starts
    }
    rec.start(SLICE_MS);
    this.state = 'recording';
    this.since = performance.now();
    this.keepAwake();
    this.onVis = () => this.visibility();
    document.addEventListener('visibilitychange', this.onVis);
  }

  elapsed() {
    return this.base + (this.state === 'recording' ? (performance.now() - this.since) / 1000 : 0);
  }

  pause() {
    if (this.state !== 'recording') return;
    this.base = this.elapsed();
    this.state = 'paused';
    try { this.rec.pause(); } catch { /* ignore */ }
    this.rec.requestData?.();
  }

  resume() {
    if (this.state !== 'paused') return;
    try { this.rec.resume(); } catch { /* ignore */ }
    this.since = performance.now();
    this.state = 'recording';
  }

  // 0..1 loudness for the level meter
  level() {
    if (!this.analyser || this.state !== 'recording') return 0;
    this.analyser.getFloatTimeDomainData(this.buf);
    let s = 0;
    for (let i = 0; i < this.buf.length; i++) s += this.buf[i] * this.buf[i];
    return Math.min(1, Math.sqrt(Math.sqrt(s / this.buf.length)) * 1.6);
  }

  interrupt() {
    if (this.state !== 'recording' && this.state !== 'paused') return;
    this.base = this.elapsed();
    this.state = 'interrupted';
    try { if (this.rec.state !== 'inactive') this.rec.stop(); } catch { /* ignore */ }
    this.onchange?.('interrupted');
  }

  // Stop, wait until every piece of audio is in storage, and return the recording id.
  async finish() {
    const duration = this.elapsed();
    this.base = duration;
    this.state = 'stopped';
    try { if (this.rec.state !== 'inactive') this.rec.stop(); } catch { /* ignore */ }
    await Promise.race([this.stopped, sleep(5000)]);
    await this.writes;
    await db.setPendingElapsed(this.recId, duration);
    this.close();
    if (this.writeError) throw this.writeError;
    return this.recId;
  }

  async discard() {
    this.state = 'stopped';
    try {
      if (this.rec && this.rec.state !== 'inactive') this.rec.stop();
      await Promise.race([this.stopped, sleep(3000)]);
      await this.writes;
    } catch { /* ignore */ }
    this.close();
    if (this.recId) await db.discardRecording(this.recId);
  }

  close() {
    if (this.onVis) document.removeEventListener('visibilitychange', this.onVis);
    this.stream?.getTracks().forEach(t => t.stop());
    try { this.ctx?.close(); } catch { /* ignore */ }
    try { this.wake?.release(); } catch { /* ignore */ }
    this.wake = null;
  }

  visibility() {
    if (document.hidden) {
      try { if (this.rec?.state === 'recording') this.rec.requestData(); } catch { /* ignore */ }
    } else if (this.rec?.state === 'inactive' || this.stream?.getAudioTracks().some(t => t.readyState === 'ended')) {
      this.interrupt();
    } else if (this.state === 'recording') {
      this.keepAwake();
    }
  }

  async keepAwake() {
    try { this.wake = await navigator.wakeLock?.request('screen'); } catch { /* not supported */ }
  }
}
