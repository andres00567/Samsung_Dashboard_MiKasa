# Mi Kasa — Samsung Tizen TV Dashboard

Mi Kasa is a Samsung Tizen launcher with an iPhone-inspired lock screen, interactive app dock, Plex Continue Watching/resume, security camera widget, movie calendar, and Live/Cinema video wallpaper.

**Version 0.1.17 — Plex foreground video and remote controls**

- [Download complete v0.1.17 source and media](https://chatgpt.com/library?file_id=libfile_a277e32aeeb4819195a5e14d36790be0&account_id=personal)
- [Download the smaller v0.1.17 source hotfix](https://chatgpt.com/library?file_id=libfile_976a22117db881919579c854148f11b1&account_id=personal)
- [Physical Samsung TV validation checklist](https://github.com/andres00567/Samsung_Dashboard_MiKasa/issues/1)

Fixed Plex video playing behind the Mi Kasa launcher. During Plex playback the dashboard and floating widgets now become invisible so Samsung's AVPlay video plane can display with only the Plex transport controls on top. The app also requests Samsung's `tv.inputdevice` privilege and registers playback/seek/stop media keys, while retaining D-pad/OK/Back behavior and HTML5 fallback. The previous Plex resume and embedded Windows features are preserved. **Physical TV validation is still needed.**

**Version 0.1.16 — Music and embedded Windows**

- [Download full v0.1.16 source with all MP4 videos](https://chatgpt.com/library?file_id=libfile_1ad81d6b3d0881918fe0c30d215caf1f&account_id=personal)
- [Download smaller v0.1.16 source hotfix](https://chatgpt.com/library?file_id=libfile_f95e5e8654cc8191b09348b2b698e58d&account_id=personal)
- [Physical TV video validation checklist](https://github.com/andres00567/Samsung_Dashboard_MiKasa/issues/1)

Version 0.1.16 adds a **Windows** workspace with up to four concurrently open panels: an HTML5 music/radio player for direct MP3/AAC streams, embedded webpages when the website permits framing, direct video playback, and a shortcut to the existing camera viewer. Panels support minimize/expand/close, up to 18 locally saved shortcuts, and a compact music transport that remains accessible across Mi Kasa tabs. Remote focus navigation and Back handling have been integrated with the existing dashboard. Native Tizen apps and sites that prohibit iframe embedding cannot be hosted as child windows; use their installed TV app tiles instead. Previous 0.1.15 Plex playback fixes are retained. The included software checks passed; the new workspace still requires validation on physical hardware.

**Version 0.1.15 — Plex Continue Watching fix**

- [Download full v0.1.15 source with all MP4 videos](https://chatgpt.com/library?file_id=libfile_028dafac21d48191ac0d0a41dc05f6dc&account_id=personal)
- [Download smaller v0.1.15 source hotfix](https://chatgpt.com/library?file_id=libfile_632a349406ec8191a4e1176bbd1ac112&account_id=personal)
- [Physical TV video validation checklist](https://github.com/andres00567/Samsung_Dashboard_MiKasa/issues/1)

Version 0.1.15 fixes a root cause of Continue Watching launch failures: Plex media Part keys normally end in `file.mkv`/`file.mp4`, but our bridge erroneously accepted only bare `/file`. The player now validates Plex's stream before opening fullscreen, supports Back to cancel requests, automatically exits on unrecoverable playback failure, and clears Samsung's opaque HTML plane for native Plex video. The release retains the v0.1.14 changes: Apps above Continue Watching/Calendar, moves the persistent camera preview to the far right to clear the clock, and makes root UI surfaces transparent while Samsung AVPlay renders behind the application. If video still fails, the app now displays a playback-error notice instead of leaving only a static poster. **Playback on physical hardware is not yet verified.**

## Repository

- `MiKasa/index.html` — dashboard UI and TV video player.
- `MiKasa/config.xml` — Tizen application manifest.
- `LAN-Bridge/server.mjs` — local Plex, camera, news and MP4 media server.
- `LAN-Bridge/test-*.mjs` — runtime/regression checks.

The original MP4/JPG bundles are **included in the full release ZIP**, but have not yet been uploaded into this GitHub repository because the repository's authenticated upload method is not configured for large binary assets. Extract the full ZIP before opening the application in Tizen Studio.

## Installation

Open `MiKasa/` in Tizen Studio; package with your existing signing profile and install to the connected TV. Run `node server.mjs` from `LAN-Bridge/` (Node 20+) and configure the app's LAN bridge address to the computer's LAN IP, not `localhost`.

Keep bridge credentials in an untracked `.env`; never port-forward the bridge to the public Internet.

## Tests

```bash
node LAN-Bridge/test-media.mjs
node --test LAN-Bridge/test-plex.mjs LAN-Bridge/test-cameras.mjs LAN-Bridge/test-camera-pool.mjs
```

The bridge's HTTP HEAD/range requests and existing Plex/camera tests have passed locally. **Physical Tizen video playback is not yet confirmed.**
