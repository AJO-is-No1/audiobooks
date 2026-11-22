# Audiobooks

A home-screen web app for recording your own audiobooks chapter by chapter on an iPhone and listening back.
Plain HTML/CSS/JavaScript with no build step and no server code. Recordings never leave the phone: they are
stored in the app's own storage (IndexedDB) on the device.

## Screens

- **Listen**: your books, each with its progress. A book's page has Continue, Play from the start, a
  Whole book / One chapter switch, and the chapter list (tap a chapter to play from its start).
- **Record**: pick a book (or start a new one), enter the chapter number (filled in with the next one)
  and an optional name, and tap the red button.
  - Entering an earlier number inserts the new chapter there: the old chapter with that number and
    every later one move down one (new 3 → old 3 becomes 4, old 4 becomes 5).
  - A chapter's ⋯ menu can record more onto its end (several sittings play back as one chapter),
    re-record it, rename it, change its number, share its audio or delete it.
- **Backup**: makes one `.zip` per book (audio plus `book.json` with names and order) to save via the
  share sheet, and restores from one.

The listening position is saved every few seconds, and on pause, chapter change and when the app is
backgrounded. Continue steps back 3 seconds. Audio is written to storage every 3 seconds while recording,
and a recording that was cut off is recovered as a chapter the next time the app opens.

## Files

| Path | What it does |
| --- | --- |
| `index.html`, `css/app.css` | Page shell, icons and styles |
| `js/app.js` | Screens, routing and interaction |
| `js/db.js` | IndexedDB storage, chapter numbering, recording recovery |
| `js/recorder.js` | Microphone recording (MediaRecorder), level meter, keep-awake |
| `js/player.js` | Playback, multi-part chapters, bookmark saving, lock-screen controls, sleep timer |
| `js/backup.js`, `js/zip.js` | Backup and restore |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline support and home-screen install |
| `tools/serve.ps1` | Local test server (`powershell -NoProfile -ExecutionPolicy Bypass -File tools\serve.ps1`, then http://localhost:8766) |
| `tools/make-icons.ps1` | Redraws the app icons |

## Using it on the iPhone

The microphone only works over https, so the app has to be hosted (GitHub Pages) and then added to the
home screen from Safari (Share → Add to Home Screen). Always open it from that icon: iOS keeps the
home-screen app's storage separate from Safari's.

### First-run checklist

1. Record a short test chapter. Allow the microphone when asked, and check the level meter moves.
2. Play it back. Check it's loud, from the speaker, and not quiet from the earpiece.
3. Lock the phone while it plays. Check audio continues and the lock-screen controls work.
4. Lock the phone while recording. Check that when you reopen it, the recording up to that point is saved.
5. Record more onto that chapter, then check it plays straight through both parts.
6. Back up the book, save it to Files, delete the book, and restore it from the file.
