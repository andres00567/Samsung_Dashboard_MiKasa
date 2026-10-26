# Mi Kasa: local-network setup

This folder contains the local **LAN bridge** in `server.mjs`.
The actual TV app files are in the adjacent `../MiKasa/` folder. Keep these
folders together; the bridge can also serve that UI in a normal browser.
It connects to Sonarr/Radarr and a default Google News RSS feed.

## 1. Install / launch

1. Install Node.js 20.6+ on the PC or homelab VM that will host the launcher.
2. Copy `.env.example` to `.env` in the project directory.
3. Open `.env` and fill in `SONARR_API_KEY` and `RADARR_API_KEY`.
   - Sonarr: `http://192.168.1.48:8989` → **Settings → General → Security → API Key**.
   - Radarr: `http://192.168.1.48:7878` → **Settings → General → Security → API Key**.
4. From this folder run:

   ```powershell
   node --env-file=.env server.mjs
   ```

5. On the hosting PC open **http://127.0.0.1:8787**.

No npm dependencies and no build step are required. The server never writes to
Sonarr/Radarr. Plex playback-position updates use a dedicated local endpoint.

## 2. Open the launcher on your Samsung TV

To allow the TV to connect from `192.168.1.47`, change `.env` to:

```dotenv
HOST=192.168.1.42
PORT=8787
```

Replace `192.168.1.42` with your bridge PC's actual IP if different. Restart
Node and permit inbound TCP `8787` **only from the TV IP 192.168.1.47** using
your PC/VM firewall.

In the installed Tizen app, go to **Settings → Media & news feeds → LAN feed
bridge address** and enter the bridge URL. Select **Check local connections**.
Alternatively, use the same URL in the TV's ordinary browser:

```
http://<IP-OF-PC-OR-VM-RUNNING-SERVER>:8787
```

For example, **if you run the launcher server on 192.168.1.48 itself**, use
`http://192.168.1.48:8787`. Otherwise replace that IP with the host running
`server.mjs`.

The device running `server.mjs` must be able to reach `192.168.1.48:8989`
(Sonarr) and `192.168.1.48:7878` (Radarr) on your LAN.

**Do not forward 8787 on your router, put this server on the public Internet,
or expose it through an unrestricted tunnel.** It is designed for a trusted
home network, not public multi-user hosting.

## 3. Check connections

From the launcher, go to **Settings → Media & news feeds → Check local connections**.
The health check reports Sonarr, Radarr, and RSS separately.

You can also inspect diagnostic responses from the host computer:

```
http://127.0.0.1:8787/api/health
http://127.0.0.1:8787/api/news
http://127.0.0.1:8787/api/calendar?start=2026-10-23&end=2026-11-20
```

If an API key is missing, the relevant service appears **not connected** and
the release calendar remains in sample mode. The default news feed requires
the hosting VM/PC to have access to Google News.

## 4. Settings, customization, and security

- **Wallpapers** are inside Settings. Choose **Live**, **Cinema**, **Photos**,
  **Colors**, or **Custom** image/video URLs. **Cinema** offers a restored 1080p
  movie-theater intermission film and three original archival SD commercials,
  all bundled locally and muted by default. The server supports range requests
  for browser playback; keep `MiKasa/media/` beside `MiKasa/index.html`.
  Motion toggle and dimming controls persist in the browser for that TV.
- **Apps and shortcuts** are customizable in Settings. Web shortcuts do
  **not** yet open arbitrary installed Samsung native apps.
- **RSS**: Change `NEWS_RSS_URL` in `.env` and restart Node to use another feed.
- **Calendar**: Sonarr and Radarr feed the small release calendar and chips on Home.
- **Plex Continue Watching**: Selecting a title now starts playback inside Mi Kasa
  at the Plex `viewOffset` and reports watch progress back to Plex. Samsung
  AVPlay is preferred on TV, with HTML5 video as fallback. This direct-play path
  cannot handle every possible codec/container; for unsupported media, use the
  player's **Plex app** button. Tizen has no documented, reliable native Plex
  title-level deep link from a third-party launcher.
- **Camera PiP/notifications**: Configure cameras with `CAMERA_n_*` variables in
  `.env`; the compact overlay keeps controls on top of the feed. SmartThings
  actions remain demo-only.
- **Secrets**: Keep `.env` private. No Sonarr/Radarr API key goes in HTML, URL,
  localStorage, or browser requests. The Plex token stays on the bridge. The
  only media write is `POST /api/plex/progress/:ratingKey`, restricted to current
  Continue Watching titles. Firewall bridge access to your trusted TV only.

## Why double-clicking index.html isn't enough

A page opened as `file://` cannot reliably read local services from a TV
browser because of CORS restrictions, and Sonarr/Radarr require API keys. The
`file://` HTML is still viewable as a sample. The packaged Tizen application
can reach the bridge URL configured in its Settings; browser users can open the
LAN URL. The bridge serves the same HTML through `http://` and keeps Plex,
Sonarr, and Radarr credentials on the bridge host.

The remotely hosted preview version cannot reach private `192.168.x.x` services
on your home network and remains a visual demo; use the LAN installation for
live feeds.
