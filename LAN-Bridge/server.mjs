/**
 * Mi Kasa LAN server
 *
 * Pure Node.js (20+), no third-party dependencies. Serves the launcher and
 * read-only Plex, Sonarr, Radarr, cameras and RSS data from this same origin. No browser API
 * keys, open CORS policy, write endpoints, or arbitrary URL fetch parameters.
 */
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createHash, randomBytes } from 'node:crypto';
import { createCameraPool } from './camera-pool.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.join(root, '..', 'MiKasa');
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 8787);
const sonarrUrl = (process.env.SONARR_URL || 'http://192.168.1.48:8989').replace(/\/$/, '');
const radarrUrl = (process.env.RADARR_URL || 'http://192.168.1.48:7878').replace(/\/$/, '');
const sonarrKey = process.env.SONARR_API_KEY || '';
const radarrKey = process.env.RADARR_API_KEY || '';
const plexUrl = (process.env.PLEX_URL || 'http://192.168.1.48:32400').replace(/\/$/, '');
const plexToken = process.env.PLEX_TOKEN || '';
const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
const cameraSources = Array.from({ length: 8 }, (_, index) => {
  const prefix = `CAMERA_${index + 1}_`;
  const url = (process.env[prefix + 'URL'] || '').trim();
  if (!url) return null;
  const type = (process.env[prefix + 'TYPE'] || 'snapshot').toLowerCase();
  if (!['snapshot', 'mjpeg', 'rtsp', 'onvif', 'tapo', 'camhipro'].includes(type)) throw Error(`${prefix}TYPE must be snapshot, mjpeg, rtsp, onvif, tapo or camhipro`);
  const parsed = new URL(url);
  if (type === 'rtsp' ? parsed.protocol !== 'rtsp:' : !['http:', 'https:'].includes(parsed.protocol)) {
    throw Error(`${prefix}URL protocol does not match ${type}`);
  }
  return {
    id: `camera-${index + 1}`, name: (process.env[prefix + 'NAME'] || `Camera ${index + 1}`).slice(0, 64),
    url, type, username: process.env[prefix + 'USER'] || '', password: process.env[prefix + 'PASSWORD'] || '',
    profileToken: process.env[prefix + 'PROFILE_TOKEN'] || '', streamCache: null,
  };
}).filter(Boolean);
const rssUrl = process.env.NEWS_RSS_URL || 'https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en';
const localRssUrl = process.env.LOCAL_NEWS_RSS_URL || 'https://ozarkradionews.com/feed';
const timeoutMs = 6500;
const rssCache = { at: 0, items: null, sources: null, pending: null };
const plexCache = { at: 0, items: null, artwork: new Map(), playback: new Map(), pending: null };
const packagedMedia = new Map([
  ['drivein-lobby-hd.mp4', 'video/mp4'],
  ['drivein-lobby-hd.jpg', 'image/jpeg'],
  ['drivein-hotdog-1.mp4', 'video/mp4'],
  ['drivein-hotdog-2.mp4', 'video/mp4'],
  ['drivein-snackbar.mp4', 'video/mp4'],
  ['drivein-hotdog-1.jpg', 'image/jpeg'],
  ['drivein-hotdog-2.jpg', 'image/jpeg'],
  ['drivein-snackbar.jpg', 'image/jpeg'],
  ['wallpaper-alpine.jpg', 'image/jpeg'],
  ['wallpaper-midnight.jpg', 'image/jpeg'],
  ['wallpaper-forest.jpg', 'image/jpeg'],
  ['wallpaper-golden.jpg', 'image/jpeg'],
  ['wallpaper-wild.jpg', 'image/jpeg'],
  ['wallpaper-ridge.jpg', 'image/jpeg'],
  ['live-christmas.mp4', 'video/mp4'],
  ['live-christmas.jpg', 'image/jpeg'],
  ['live-snow.mp4', 'video/mp4'],
  ['live-snow.jpg', 'image/jpeg'],
  ['live-car.mp4', 'video/mp4'],
  ['live-car.jpg', 'image/jpeg'],
  ['drivein-beanys-arrival.mp4', 'video/mp4'],
  ['drivein-beanys-dining.mp4', 'video/mp4'],
  ['drivein-beanys-night.mp4', 'video/mp4'],
  ['drivein-beanys-arrival.jpg', 'image/jpeg'],
  ['drivein-beanys-dining.jpg', 'image/jpeg'],
  ['drivein-beanys-night.jpg', 'image/jpeg'],
]);

if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw Error('PORT must be an integer between 1024 and 65535');
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    // A bundled Tizen widget commonly has an opaque (null) web origin.
    // Other opaque-origin pages can also use this CORS policy, so it is NOT
    // authentication. Firewall this read-only endpoint to the trusted TV.
    ...(res.miKasaAPI ? { 'Access-Control-Allow-Origin': 'null' } : {}),
  });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

function cameraPublic(camera) {
  return { id: camera.id, name: camera.name, type: camera.type, feed: `/api/cameras/${camera.id}/feed` };
}

function cameraHeaders(res, type) {
  res.writeHead(200, {
    'Content-Type': type, 'Cache-Control': 'no-store, no-cache, must-revalidate',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Access-Control-Allow-Origin': 'null',
  });
}

function xmlEscape(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function xmlText(value) {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, entity => {
    const names = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
    if (names[entity]) return names[entity];
    if (entity[1] === '#') {
      const hex = entity[2]?.toLowerCase() === 'x', point = Number.parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
      return Number.isInteger(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : '';
    }
    return entity;
  });
}

function tagValue(xml, tag) {
  const match = new RegExp(`<(?:(?:[\\w-]+):)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:(?:[\\w-]+):)?${tag}\\s*>`, 'i').exec(xml);
  return match ? xmlText(match[1].trim()) : '';
}

function wsSecurityHeader(camera) {
  if (!camera.username) return '';
  const nonce = randomBytes(20), created = new Date().toISOString();
  const digest = createHash('sha1').update(Buffer.concat([nonce, Buffer.from(created + camera.password)])).digest('base64');
  return `<wsse:Security s:mustUnderstand="1" xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd"><wsse:UsernameToken><wsse:Username>${xmlEscape(camera.username)}</wsse:Username><wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</wsse:Password><wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonce.toString('base64')}</wsse:Nonce><wsu:Created>${created}</wsu:Created></wsse:UsernameToken></wsse:Security>`;
}

async function onvifCall(camera, serviceUrl, action, namespace, argumentsXml = '') {
  const xml = `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tds="http://www.onvif.org/ver10/device/wsdl" xmlns:trt="http://www.onvif.org/ver10/media/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema"><s:Header>${wsSecurityHeader(camera)}</s:Header><s:Body><${namespace}:${action}>${argumentsXml}</${namespace}:${action}></s:Body></s:Envelope>`;
  const response = await fetch(serviceUrl, { method: 'POST', headers: { 'Content-Type': `application/soap+xml; charset=utf-8; action="http://www.onvif.org/ver10/${namespace === 'tds' ? 'device' : 'media'}/wsdl/${action}"` }, body: xml, signal: AbortSignal.timeout(camera.type === 'camhipro' ? 3200 : 9000) });
  const output = await response.text();
  if (!response.ok || /<(?:\w+:)?Fault(?:\s|>)/.test(output)) throw Error(`ONVIF ${action} failed (HTTP ${response.status}); check camera credentials and ONVIF access`);
  return output;
}

async function onvifRtsp(camera) {
  if (camera.streamCache && camera.streamCache.expires > Date.now()) return camera.streamCache.url;
  const deviceUrl = new URL(camera.url);
  if (camera.type === 'tapo' && !deviceUrl.port) deviceUrl.port = '2020';
  if (deviceUrl.pathname === '/') deviceUrl.pathname = '/onvif/device_service';
  const capabilities = await onvifCall(camera, deviceUrl.href, 'GetCapabilities', 'tds', '<tds:Category>Media</tds:Category>');
  const mediaSection = /<(?:\w+:)?Media(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?Media>/i.exec(capabilities)?.[1];
  const mediaAddress = mediaSection ? tagValue(mediaSection, 'XAddr') : '';
  if (!mediaAddress) throw Error('ONVIF device did not provide a Media service');
  const mediaUrl = new URL(mediaAddress);
  // Some cameras advertise a non-routable/loopback address even when reached by IP.
  if (['0.0.0.0', '127.0.0.1', 'localhost'].includes(mediaUrl.hostname)) mediaUrl.hostname = deviceUrl.hostname;
  const profiles = await onvifCall(camera, mediaUrl.href, 'GetProfiles', 'trt');
  const firstProfile = /<(?:\w+:)?Profiles\b([^>]*)>/i.exec(profiles)?.[1] || '';
  const token = camera.profileToken || /\btoken\s*=\s*["']([^"']+)["']/i.exec(firstProfile)?.[1];
  if (!token) throw Error('ONVIF Media service did not provide a video profile');
  const reply = await onvifCall(camera, mediaUrl.href, 'GetStreamUri', 'trt', `<trt:StreamSetup><tt:Stream>RTP-Unicast</tt:Stream><tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport></trt:StreamSetup><trt:ProfileToken>${xmlEscape(token)}</trt:ProfileToken>`);
  const rtspUri = tagValue(reply, 'Uri');
  if (!rtspUri || new URL(rtspUri).protocol !== 'rtsp:') throw Error('ONVIF camera did not return an RTSP stream URI');
  const source = new URL(rtspUri);
  if (['0.0.0.0', '127.0.0.1', 'localhost'].includes(source.hostname)) source.hostname = deviceUrl.hostname;
  camera.streamCache = { url: source.href, expires: Date.now() + 10 * 60 * 1000 };
  return source.href;
}

async function camHiProRtsp(camera) {
  if (camera.streamCache && camera.streamCache.expires > Date.now()) return camera.streamCache.url;
  const base = new URL(camera.url);
  // CamHiPro is used by multiple manufacturers. Prefer ONVIF when possible;
  // typical HiChip firmwares use 8080, while some expose it on 8899.
  const ports = base.port ? [base.port] : ['8080', '8899'];
  for (const port of ports) {
    const endpoint = new URL(base.href);
    endpoint.port = port;
    if (endpoint.pathname === '/') endpoint.pathname = '/onvif/device_service';
    try {
      const url = await onvifRtsp({ ...camera, url: endpoint.href, streamCache: null });
      camera.streamCache = { url, expires: Date.now() + 10 * 60 * 1000 };
      return url;
    }
    catch { /* Try the next known ONVIF service port. */ }
  }
  // HiChip/CamHiPro cameras commonly expose the low-bandwidth RTSP substream
  // on /12. This is a documented fallback, not proof that a camera is online.
  const rtsp = new URL(`rtsp://${base.hostname}:554/12`);
  camera.streamCache = { url: rtsp.href, expires: Date.now() + 60 * 1000 };
  console.warn(`${camera.name}: ONVIF discovery unavailable; attempting CamHiPro RTSP substream /12`);
  return rtsp.href;
}

const cameraPool = createCameraPool(cameraSources, {
  ffmpegPath,
  resolveUrl: camera => camera.type === 'rtsp' ? camera.url :
    camera.type === 'camhipro' ? camHiProRtsp(camera) : onvifRtsp(camera),
});
process.once('SIGINT', () => { cameraPool.close();process.exit(0) });
process.once('SIGTERM', () => { cameraPool.close();process.exit(0) });

async function serveCamera(req, res, camera) {
  if (['rtsp', 'onvif', 'tapo', 'camhipro'].includes(camera.type)) {
    return cameraPool.serve(req, res, camera.id);
  }
  const controller = new AbortController();
  res.on('close', () => controller.abort());
  const headers = { Accept: camera.type === 'mjpeg' ? 'multipart/x-mixed-replace,image/jpeg' : 'image/jpeg,image/png' };
  if (camera.username) headers.Authorization = 'Basic ' + Buffer.from(camera.username + ':' + camera.password).toString('base64');
  const upstream = await fetch(camera.url, { headers, signal: controller.signal });
  if (!upstream.ok || !upstream.body) return send(res, 502, { error: `Camera returned HTTP ${upstream.status}` });
  const contentType = upstream.headers.get('content-type') || '';
  const acceptable = camera.type === 'mjpeg' ? /^(multipart\/x-mixed-replace|image\/jpeg)/i : /^image\/(jpeg|png)/i;
  if (!acceptable.test(contentType)) {
    await upstream.body.cancel();
    return send(res, 502, { error: 'Camera did not return the configured image or MJPEG format' });
  }
  cameraHeaders(res, contentType);
  const stream = Readable.fromWeb(upstream.body);
  stream.on('error', () => { if (!res.writableEnded) res.end(); });
  stream.pipe(res);
}

/** Only bundled, whitelisted media files are accessible from the LAN. */
async function servePackagedMedia(req, res, filename) {
  const type = packagedMedia.get(filename);
  if (!type) return send(res, 404, { error: 'Media not found' });
  const file = path.join(publicRoot, 'media', filename);
  const metadata = await stat(file);
  const size = metadata.size;
  let start = 0, end = size - 1, status = 200;
  if (req.headers.range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!match || (!match[1] && !match[2])) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    if (!match[1]) {
      const suffixLength = Number(match[2]);
      start = Math.max(0, size - suffixLength);
    } else {
      start = Number(match[1]);
      if (match[2]) end = Math.min(end, Number(match[2]));
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    status = 206;
  }
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': end - start + 1,
    'Accept-Ranges': 'bytes',
    ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
    'Cache-Control': type === 'video/mp4' ? 'no-store' : 'private, max-age=300',
    'Access-Control-Allow-Origin': 'null',
    'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file, { start, end }).pipe(res);
}

async function requestJSON(service, baseUrl, apiKey, resource) {
  if (!apiKey.trim()) throw Error(`${service} API key missing in server .env`);
  const url = new URL(resource, baseUrl + '/');
  const response = await fetch(url, {
    headers: { 'X-Api-Key': apiKey, Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw Error(`${service} HTTP ${response.status}`);
  const payload = await response.json();
  return payload;
}

function errorMessage(error) {
  const text = String(error?.message || 'Connection failed');
  if (/API key missing/.test(text)) return text;
  if (/Plex token missing/.test(text)) return text;
  if (/HTTP \d+/.test(text)) return text;
  if (/RSS|news feeds|readable stories/.test(text)) return text.slice(0, 200);
  return 'Unable to reach service on the configured network address';
}

async function serviceHealth(service, url, key) {
  try {
    const info = await requestJSON(service, url, key, 'api/v3/system/status');
    return { ok: true, version: String(info.version || 'connected') };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

async function requestPlex(resource, accept = 'application/json') {
  if (!plexToken.trim()) throw Error('Plex token missing in server .env');
  const base = new URL(plexUrl + '/');
  const url = new URL(resource, base);
  if (url.origin !== base.origin) throw Error('Invalid Plex resource path');
  const response = await fetch(url, {
    headers: {
      'X-Plex-Token': plexToken,
      'X-Plex-Product': 'Mi Kasa',
      'X-Plex-Client-Identifier': 'mi-kasa-lan-bridge',
      Accept: accept,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw Error(`Plex HTTP ${response.status}`);
  return response;
}

async function plexContinueWatching() {
  if (plexCache.items && Date.now() - plexCache.at < 60_000) return plexCache.items;
  if (plexCache.pending) return plexCache.pending;
  plexCache.pending = (async () => {
    const response = await requestPlex('hubs?count=15');
    const json = await response.json();
    const hubs = Array.isArray(json?.MediaContainer?.Hub) ? json.MediaContainer.Hub : [];
    const hub = hubs.find(entry => /continue/i.test(String(entry.hubIdentifier || entry.title || '')))
      || hubs.find(entry => /ondeck/i.test(String(entry.hubIdentifier || entry.title || '').replace(/\s+/g, '')));
    let metadata = Array.isArray(hub?.Metadata) ? hub.Metadata : [];
    if (hub && metadata.length === 0 && hub.hubIdentifier) {
      const itemsResponse = await requestPlex('hubs/items?identifier=' + encodeURIComponent(hub.hubIdentifier) + '&count=15');
      const itemsJSON = await itemsResponse.json();
      metadata = Array.isArray(itemsJSON?.MediaContainer?.Metadata) ? itemsJSON.MediaContainer.Metadata : [];
    }
    const artwork = new Map();
    const items = metadata.slice(0, 15).flatMap(item => {
      const ratingKey = String(item.ratingKey || '');
      if (!/^\d{1,16}$/.test(ratingKey)) return [];
      const type = item.type === 'episode' ? 'episode' : item.type === 'movie' ? 'movie' : null;
      if (!type) return [];
      const duration = Math.max(0, Number(item.duration) || 0);
      const offset = Math.max(0, Number(item.viewOffset) || 0);
      const percent = duration ? Math.max(0, Math.min(100, Math.round(offset / duration * 100))) : 0;
      // Movies generally provide landscape fan-art in `art`; portrait thumbs
      // are an awkward fit for the TV's wide Continue Watching cards. Episode
      // thumbs already contain the intended landscape frame.
      const rawArt = String(type === 'movie'
        ? (item.art || item.thumb || item.grandparentThumb || item.parentThumb || '')
        : (item.thumb || item.grandparentThumb || item.parentThumb || item.art || ''));
      if (/^\/library\/metadata\/\d{1,16}\/(?:thumb|art)(?:\/\d+)?$/.test(rawArt)) artwork.set(ratingKey, rawArt);
      const season = Number.isInteger(item.parentIndex) ? item.parentIndex : null;
      const episode = Number.isInteger(item.index) ? item.index : null;
      return [{
        ratingKey,
        type,
        title: String(item.title || 'Untitled').slice(0, 140),
        showTitle: type === 'episode' ? String(item.grandparentTitle || item.parentTitle || '').slice(0, 120) : '',
        season,
        episode,
        percent,
        hasProgress: offset > 0,
        viewOffsetMs: Math.floor(offset),
        durationMs: Math.floor(duration),
        poster: artwork.has(ratingKey) ? '/api/plex/art/' + ratingKey : null,
      }];
    });
    plexCache.items = items;
    plexCache.artwork = artwork;
    plexCache.at = Date.now();
    return items;
  })();
  try { return await plexCache.pending; }
  finally { plexCache.pending = null; }
}

async function servePlexArtwork(res, ratingKey) {
  if (!/^\d{1,16}$/.test(ratingKey)) return send(res, 400, { error: 'Invalid artwork identifier' });
  await plexContinueWatching();
  const artPath = plexCache.artwork.get(ratingKey);
  if (!artPath) return send(res, 404, { error: 'Artwork unavailable' });
  const response = await requestPlex(artPath.replace(/^\//, ''), 'image/*');
  const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(type)) return send(res, 415, { error: 'Unsupported artwork type' });
  const announcedLength = Number(response.headers.get('content-length') || 0);
  if (announcedLength > 5 * 1024 * 1024) return send(res, 413, { error: 'Artwork too large' });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 5 * 1024 * 1024) return send(res, 413, { error: 'Artwork too large' });
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': bytes.length,
    'Cache-Control': 'private, max-age=60',
    'X-Content-Type-Options': 'nosniff',
    'Access-Control-Allow-Origin': 'null',
  });
  res.end(bytes);
}

// The Plex Smart TV app has no documented, supported item-level Tizen launch
// control. Stream selected Continue Watching items through the LAN bridge so
// selecting a card can really resume, without exposing PLEX_TOKEN to the TV.
// Only metadata-approved Part URLs can be requested from the Plex server.
async function plexPlaybackDetails(ratingKey) {
  if (!/^\d{1,16}$/.test(ratingKey)) throw Error('Invalid Plex title');
  const items = await plexContinueWatching();
  if (!items.some(item => item.ratingKey === ratingKey)) throw Error('Title is no longer in Continue Watching');
  const cached = plexCache.playback.get(ratingKey);
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.details;
  const response = await requestPlex('library/metadata/' + ratingKey);
  const json = await response.json();
  const item = json?.MediaContainer?.Metadata?.[0];
  const media = item?.Media?.[0];
  const part = media?.Part?.[0];
  const partPath = String(part?.key || '');
  // Real Plex Part.key values end in file.mkv, file.mp4, etc. Some older
  // servers return bare /file. Accept only these concrete media endpoints;
  // never accept arbitrary Plex paths or caller-supplied URL parameters.
  if (!/^\/library\/parts\/\d{1,16}\/(?:\d{1,16}\/)?file(?:\.[a-z0-9]{1,8})?$/i.test(partPath))
    throw Error('Plex media has no directly playable file');
  const hub = items.find(entry => entry.ratingKey === ratingKey);
  const details = {
    ratingKey,
    title: hub?.type === 'episode' ? hub.showTitle + ' — ' + hub.title : hub?.title || 'Plex video',
    resumeMs: Math.max(0, Number(item.viewOffset) || hub?.viewOffsetMs || 0),
    durationMs: Math.max(0, Number(item.duration) || hub?.durationMs || 0),
    partPath,
    container: String(media?.container || part?.container || '').slice(0, 20),
    videoCodec: String(media?.videoCodec || '').slice(0, 20),
    streamUrl: '/api/plex/stream/' + ratingKey,
  };
  plexCache.playback.set(ratingKey, { at: Date.now(), details });
  return details;
}

async function servePlexVideo(req, res, ratingKey) {
  const details = await plexPlaybackDetails(ratingKey);
  const range = req.headers.range;
  if (range && !/^bytes=(?:\d+-\d*|-\d+)$/.test(range))
    return send(res, 416, { error: 'Unsupported byte range' });
  const upstreamUrl = new URL(details.partPath, plexUrl + '/');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  let upstream;
  try {
    upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers: {
        'X-Plex-Token': plexToken,
        'X-Plex-Product': 'Mi Kasa',
        'X-Plex-Client-Identifier': 'mi-kasa-lan-bridge',
        ...(range ? { Range: range } : {}),
      },
      signal: controller.signal,
    });
  } finally { clearTimeout(timer); }
  if (!upstream.ok) return send(res, upstream.status, { error: 'Plex file request failed' });
  const headers = {
    'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Access-Control-Allow-Origin': 'null',
  };
  for (const name of ['content-length', 'content-range']) {
    const value = upstream.headers.get(name);
    if (value) headers[name === 'content-length' ? 'Content-Length' : 'Content-Range'] = value;
  }
  res.writeHead(upstream.status, headers);
  if (req.method === 'HEAD' || !upstream.body) { upstream.body?.cancel().catch(() => {}); res.end(); return; }
  const body = Readable.fromWeb(upstream.body);
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });
  body.on('error', () => { if (!res.destroyed) res.destroy(); });
  body.pipe(res);
}

async function reportPlexProgress(req, res, ratingKey) {
  if (!/^\d{1,16}$/.test(ratingKey)) return send(res, 400, { error: 'Invalid Plex title' });
  if (!plexCache.items?.some(item => item.ratingKey === ratingKey))
    return send(res, 404, { error: 'Title not in Continue Watching' });
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || ''))
    return send(res, 415, { error: 'Expected JSON' });
  let raw = '';
  for await (const chunk of req) {
    raw += chunk.toString('utf8');
    if (raw.length > 512) return send(res, 413, { error: 'Progress update too large' });
  }
  let progress;
  try { progress = JSON.parse(raw); } catch { return send(res, 400, { error: 'Invalid progress JSON' }); }
  const { state, timeMs, durationMs } = progress || {};
  if (!['playing', 'paused', 'stopped'].includes(state) || !Number.isSafeInteger(timeMs) ||
    !Number.isSafeInteger(durationMs) || timeMs < 0 || durationMs <= 0 || timeMs > durationMs)
    return send(res, 400, { error: 'Invalid playback progress' });
  const query = new URLSearchParams({
    ratingKey, key: '/library/metadata/' + ratingKey, state,
    time: String(timeMs), duration: String(durationMs),
  });
  await requestPlex(':/timeline?' + query.toString());
  // The next Continue Watching fetch should show the newly stored Plex offset.
  plexCache.at = 0;
  plexCache.playback.delete(ratingKey);
  return send(res, 200, { ok: true });
}

function validDate(value) {
  if (typeof value !== 'string') return null;
  const date = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return Number.isFinite(Date.parse(date + 'T00:00:00Z')) ? date : null;
}

function sonarrEntries(episodes, start, end) {
  if (!Array.isArray(episodes)) return [];
  return episodes.flatMap(episode => {
    const date = validDate(episode.airDate || episode.airDateUtc);
    if (!date || date < start || date > end) return [];
    const show = String(episode.series?.title || 'TV episode');
    const season = Number.isInteger(episode.seasonNumber) ? String(episode.seasonNumber).padStart(2, '0') : '??';
    const number = Number.isInteger(episode.episodeNumber) ? String(episode.episodeNumber).padStart(2, '0') : '??';
    return [{ date, source: 'Sonarr', title: `${show} S${season}E${number}`.slice(0, 145) }];
  });
}

function radarrEntries(movies, start, end) {
  if (!Array.isArray(movies)) return [];
  return movies.flatMap(movie => {
    // A single chip per title in the requested period, favoring the earliest
    // known upcoming availability date.
    const choices = [
      ['digitalRelease', 'Digital'],
      ['inCinemas', 'Cinema'],
      ['physicalRelease', 'Physical'],
    ].map(([field, label]) => ({ date: validDate(movie[field]), label }))
      .filter(item => item.date && item.date >= start && item.date <= end)
      .sort((a, b) => a.date.localeCompare(b.date));
    if (!choices.length) return [];
    const first = choices[0];
    return [{ date: first.date, source: 'Radarr', title: `${String(movie.title || 'Movie')} · ${first.label}`.slice(0, 145) }];
  });
}

async function mediaCalendar(start, end) {
  const query = `?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;
  const [s, r] = await Promise.allSettled([
    requestJSON('Sonarr', sonarrUrl, sonarrKey, 'api/v3/calendar' + query + '&includeSeries=true'),
    requestJSON('Radarr', radarrUrl, radarrKey, 'api/v3/calendar' + query),
  ]);
  if (s.status === 'rejected' && r.status === 'rejected') {
    throw Error('No media source available. Configure API keys and check 192.168.1.48.');
  }
  const entries = [
    ...(s.status === 'fulfilled' ? sonarrEntries(s.value, start, end) : []),
    ...(r.status === 'fulfilled' ? radarrEntries(r.value, start, end) : []),
  ];
  entries.sort((a, b) => a.date.localeCompare(b.date) || a.source.localeCompare(b.source));
  return {
    items: entries,
    sources: {
      sonarr: s.status === 'fulfilled',
      radarr: r.status === 'fulfilled',
    },
  };
}

const decodeEntities = value => String(value)
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&#(x[\da-f]+|\d+);/gi, (full, code) => {
    const number = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code);
    return Number.isInteger(number) && number >= 0 && number <= 0x10ffff
      ? String.fromCodePoint(number) : full;
  })
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim();

function getTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? decodeEntities(match[1]) : '';
}

function parseRSS(xml, fallbackSource = 'NEWS') {
  return [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)]
    .slice(0, 15)
    .map(([, item]) => {
      const title = getTag(item, 'title');
      const link = getTag(item, 'link');
      const source = getTag(item, 'source') || fallbackSource;
      let safeUrl = '';
      try {
        const parsed = new URL(link);
        if (parsed.protocol === 'https:' || parsed.protocol === 'http:') safeUrl = parsed.href;
      } catch { /* Invalid article link: omit entry. */ }
      return { title, source, url: safeUrl };
    }).filter(item => item.title && item.url);
}

async function newsItems() {
  if (rssCache.items && Date.now() - rssCache.at < 5 * 60 * 1000) return rssCache.items;
  if (rssCache.pending) return rssCache.pending;
  rssCache.pending = (async () => {
    // Keep the Thayer/Ozarks feed independent of national news: one source
    // being unavailable must not blank the entire TV ticker.
    const sources = [
      { url: localRssUrl, label: 'OZARK RADIO NEWS' },
      { url: rssUrl, label: 'US HEADLINES' },
    ];
    const results = await Promise.allSettled(sources.map(async ({ url, label }) => {
      const feed = new URL(url);
      if (feed.protocol !== 'https:') throw Error('News RSS feed URLs must use HTTPS');
      const response = await fetch(feed, {
        headers: { Accept: 'application/rss+xml, application/xml, text/xml' },
        signal: AbortSignal.timeout(12000),
      });
      if (!response.ok) throw Error(`${label} RSS HTTP ${response.status}`);
      const stories = parseRSS(await response.text(), label);
      if (!stories.length) throw Error(`${label} has no readable stories`);
      return stories;
    }));
    const lists = results.map(result => result.status === 'fulfilled' ? result.value : []);
    rssCache.sources = { ozarks: results[0].status === 'fulfilled', national: results[1].status === 'fulfilled' };
    const items = [], seen = new Set();
    for (let i = 0; items.length < 16 && i < 15; i++) {
      for (const list of lists) {
        const story = list[i];
        if (!story || seen.has(story.url)) continue;
        seen.add(story.url);
        items.push(story);
      }
    }
    if (!items.length) {
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason?.message || 'Source offline');
      throw Error('Both news feeds unavailable: ' + errors.join('; '));
    }
    rssCache.items = items;
    rssCache.at = Date.now();
    return items;
  })();
  try { return await rssCache.pending; }
  finally { rssCache.pending = null; }
}

async function handle(req, res) {
  const requestUrl = new URL(req.url, 'http://localhost');
  res.miKasaAPI = requestUrl.pathname.startsWith('/api/');
  const progressMatch = /^\/api\/plex\/progress\/(\d{1,16})$/.exec(requestUrl.pathname);
  if (progressMatch && req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': 'null', 'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type', 'Cache-Control': 'no-store',
    });
    return res.end();
  }
  if (progressMatch && req.method === 'POST') {
    try { return await reportPlexProgress(req, res, progressMatch[1]); }
    catch (error) { return send(res, 503, { error: errorMessage(error) }); }
  }
  const streamMatch = /^\/api\/plex\/stream\/(\d{1,16})$/.exec(requestUrl.pathname);
  if (req.method !== 'GET' && !(req.method === 'HEAD' && (streamMatch || requestUrl.pathname.startsWith('/media/'))))
    return send(res, 405, { error: 'Unsupported method' });
  if (requestUrl.pathname === '/' || requestUrl.pathname === '/index.html') {
    const html = await readFile(path.join(publicRoot, 'index.html'), 'utf8');
    return send(res, 200, html, 'text/html; charset=utf-8');
  }
  if (requestUrl.pathname.startsWith('/media/')) {
    return servePackagedMedia(req, res, requestUrl.pathname.slice('/media/'.length));
  }
  if (requestUrl.pathname === '/api/health') {
    const [sonarr, radarr, news, plex] = await Promise.all([
      serviceHealth('Sonarr', sonarrUrl, sonarrKey),
      serviceHealth('Radarr', radarrUrl, radarrKey),
      newsItems().then(items => ({ ok: true, count: items.length }), error => ({ ok: false, error: errorMessage(error) })),
      plexContinueWatching().then(items => ({ ok: true, count: items.length }), error => ({ ok: false, error: errorMessage(error) })),
    ]);
    return send(res, 200, { sonarr, radarr, news, plex, cameras: { ok: cameraSources.length > 0, count: cameraSources.length, configured: cameraSources.length > 0 } });
  }
  if (requestUrl.pathname === '/api/cameras') {
    return send(res, 200, { items: cameraSources.map(cameraPublic), configured: cameraSources.length > 0 });
  }
  const cameraMatch = /^\/api\/cameras\/(camera-[1-8])\/(feed|snapshot|status)$/.exec(requestUrl.pathname);
  if (cameraMatch) {
    const camera = cameraSources.find(item => item.id === cameraMatch[1]);
    if (!camera) return send(res, 404, { error: 'Camera not configured on LAN bridge' });
    if (cameraMatch[2] === 'status') return send(res, 200, cameraPool.status(camera.id) || { ready: true });
    if (cameraMatch[2] === 'snapshot' && cameraPool.status(camera.id))
      return cameraPool.serve(req, res, camera.id, 'snapshot');
    if (cameraMatch[2] === 'snapshot') return send(res, 404, { error: 'Snapshot cache unavailable for this camera type' });
    try { return await serveCamera(req, res, camera); }
    catch (error) { if (!res.headersSent) return send(res, 503, { error: 'Camera feed unavailable from bridge host' }); else res.end(); }
    return;
  }
  if (requestUrl.pathname === '/api/plex/continue-watching') {
    try { return send(res, 200, { items: await plexContinueWatching() }); }
    catch (error) { return send(res, 503, { error: errorMessage(error) }); }
  }
  const playbackMatch = /^\/api\/plex\/playback\/(\d{1,16})$/.exec(requestUrl.pathname);
  if (playbackMatch) {
    try {
      const { partPath, ...details } = await plexPlaybackDetails(playbackMatch[1]);
      return send(res, 200, details);
    } catch (error) { return send(res, 503, { error: errorMessage(error) }); }
  }
  if (streamMatch) {
    try { return await servePlexVideo(req, res, streamMatch[1]); }
    catch (error) { if (!res.headersSent) return send(res, 503, { error: errorMessage(error) }); res.destroy(); }
    return;
  }
  if (requestUrl.pathname.startsWith('/api/plex/art/')) {
    try { return await servePlexArtwork(res, requestUrl.pathname.slice('/api/plex/art/'.length)); }
    catch (error) { return send(res, 503, { error: errorMessage(error) }); }
  }
  if (requestUrl.pathname === '/api/calendar') {
    const start = validDate(requestUrl.searchParams.get('start'));
    const end = validDate(requestUrl.searchParams.get('end'));
    if (!start || !end || start > end || Date.parse(end) - Date.parse(start) > 70 * 86400000) {
      return send(res, 400, { error: 'Provide start/end dates within 70 days' });
    }
    try { return send(res, 200, await mediaCalendar(start, end)); }
    catch (error) { return send(res, 503, { error: errorMessage(error) }); }
  }
  if (requestUrl.pathname === '/api/news') {
    try { return send(res, 200, { items: await newsItems(), sources: rssCache.sources }); }
    catch (error) { return send(res, 503, { error: errorMessage(error) }); }
  }
  return send(res, 404, { error: 'Not found' });
}

http.createServer((req, res) => {
  handle(req, res).catch(error => {
    console.error('Launcher request failed:', errorMessage(error));
    if (!res.headersSent) send(res, 500, { error: 'Launcher server error' });
    else res.end();
  });
}).listen(port, host, () => {
  console.log(`Mi Kasa available at http://${host}:${port}`);
  console.log('LAN only. Do not forward this port to the public internet.');
  if (!sonarrKey || !radarrKey) console.log('Add SONARR_API_KEY and RADARR_API_KEY to .env for live release data.');
  if (!plexToken) console.log('Add PLEX_URL and PLEX_TOKEN to .env for Plex Continue Watching.');
  console.log(`Cameras configured: ${cameraSources.length}. Set CAMERA_1_URL/TYPE/NAME in .env to add camera feeds.`);
  cameraPool.prewarm();
});
