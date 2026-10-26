# Mi Kasa — Samsung Tizen TV Dashboard

Mi Kasa is a Samsung Tizen launcher with an iPhone-inspired lock screen, interactive app dock, Plex Continue Watching/resume, security camera widget, movie calendar, and Live/Cinema video wallpaper.

**Version 0.1.14 — TV video-plane visibility and layout update**

- [Download full v0.1.14 source with all MP4 videos](https://chatgpt.com/library?file_id=libfile_50292a6229288191ab82042019d97e57&account_id=personal)
- [Download smaller v0.1.14 source hotfix](https://chatgpt.com/library?file_id=libfile_4d2d02fed2e88191bffa539ab935efd0&account_id=personal)
- [Physical TV video validation checklist](https://github.com/andres00567/Samsung_Dashboard_MiKasa/issues/1)

This release moves Apps above Continue Watching/Calendar, moves the persistent camera preview to the far right to clear the clock, and makes root UI surfaces transparent while Samsung AVPlay renders behind the application. If video still fails, the app now displays a playback-error notice instead of leaving only a static poster. **Playback on physical hardware is not yet verified.**

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
