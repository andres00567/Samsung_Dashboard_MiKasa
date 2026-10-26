/** Offline integration check: real bridge API against a local fake Plex server. */
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'server.mjs');
let observedToken = '';
let timelineRecorded = '';
const artBytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const movieBytes = Buffer.from('abcdefghijklmnopqrstuvwxyz0123456789');
const mockPlex = http.createServer((req, res) => {
  observedToken = req.headers['x-plex-token'] || '';
  if (req.url === '/hubs?count=15') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ MediaContainer: { Hub: [
      { hubIdentifier: 'home.continue', title: 'Continue Watching', totalSize: 2, Metadata: [] },
    ] } }));
  }
  if (req.url === '/hubs/items?identifier=home.continue&count=15') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ MediaContainer: { Metadata: [
        { ratingKey: '100', type: 'movie', title: 'Actual Movie', duration: 100000, viewOffset: 64000, thumb: '/library/metadata/100/thumb/123' },
        { ratingKey: '101', type: 'episode', title: 'Season Start', grandparentTitle: 'Actual Show', parentIndex: 2, index: 3, duration: 200000, viewOffset: 50000 },
      ] } }));
  }
  if (req.url === '/library/metadata/100/thumb/123') {
    res.writeHead(200, { 'Content-Type': 'image/jpeg' });
    return res.end(artBytes);
  }
  if (req.url === '/library/metadata/100') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ MediaContainer: { Metadata: [
      { ratingKey: '100', title: 'Actual Movie', duration: 100000, viewOffset: 64000,
        Media: [{ container: 'mkv', videoCodec: 'h264', Part: [{ key: '/library/parts/501/123/file.mkv' }] }] },
    ] } }));
  }
  if (req.url === '/library/parts/501/123/file.mkv') {
    const range = req.headers.range;
    const match = range && /^bytes=(\d+)-(\d*)$/.exec(range);
    if (match) {
      const start = Number(match[1]), end = match[2] ? Number(match[2]) : movieBytes.length - 1;
      const bytes = movieBytes.subarray(start, end + 1);
      res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': `bytes ${start}-${end}/${movieBytes.length}`, 'Content-Length': bytes.length });
      return res.end(req.method === 'HEAD' ? undefined : bytes);
    }
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': movieBytes.length });
    return res.end(req.method === 'HEAD' ? undefined : movieBytes);
  }
  if (req.url?.startsWith('/:/timeline?')) {
    timelineRecorded = req.url;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{}');
  }
  res.writeHead(404);res.end();
});
mockPlex.listen(0, '127.0.0.1');
await once(mockPlex, 'listening');
const mockPort = mockPlex.address().port;
const probe = http.createServer((_req, res) => res.end('occupied'));
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const bridgePort = probe.address().port;
await new Promise(resolve => probe.close(resolve));

const bridge = spawn(process.execPath, [script], {
  env: {
    ...process.env,
    HOST: '127.0.0.1', PORT: String(bridgePort),
    PLEX_URL: 'http://127.0.0.1:' + mockPort, PLEX_TOKEN: 'mock-secret-token',
    SONARR_API_KEY: '', RADARR_API_KEY: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const bridgeURL = 'http://127.0.0.1:' + bridgePort;
async function waitForBridge() {
  for (let attempt = 0; attempt < 40; attempt++) {
    try { const response = await fetch(bridgeURL + '/api/no-such-route'); if (response.status === 404) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw Error('Bridge did not start');
}
try {
  await waitForBridge();
  const response = await fetch(bridgeURL + '/api/plex/continue-watching', { headers: { Origin: 'null' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), 'null');
  const content = await response.text();
  assert.ok(!content.includes('mock-secret-token'), 'Token must never reach the client');
  const json = JSON.parse(content);
  assert.equal(json.items.length, 2);
  assert.equal(json.items[0].title, 'Actual Movie');
  assert.equal(json.items[0].percent, 64);
  assert.equal(json.items[0].viewOffsetMs, 64000);
  assert.equal(json.items[0].durationMs, 100000);
  assert.equal(json.items[0].poster, '/api/plex/art/100');
  assert.equal(json.items[1].showTitle, 'Actual Show');
  assert.equal(json.items[1].season, 2);
  assert.equal(json.items[1].episode, 3);
  assert.equal(observedToken, 'mock-secret-token');
  const art = await fetch(bridgeURL + json.items[0].poster);
  assert.equal(art.status, 200);
  assert.equal(art.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await art.arrayBuffer()), artBytes);
  const forbiddenArt = await fetch(bridgeURL + '/api/plex/art/999');
  assert.equal(forbiddenArt.status, 404);
  const malformedArt = await fetch(bridgeURL + '/api/plex/art/abc');
  assert.equal(malformedArt.status, 400);
  const playback = await fetch(bridgeURL + '/api/plex/playback/100');
  assert.equal(playback.status, 200);
  const details = await playback.json();
  assert.equal(details.resumeMs, 64000);
  assert.equal(details.streamUrl, '/api/plex/stream/100');
  assert.equal(details.partPath, undefined, 'Internal Plex file path must not be returned to TV');
  assert.ok(!JSON.stringify(details).includes('mock-secret-token'));
  const range = await fetch(bridgeURL + details.streamUrl, { headers: { Range: 'bytes=5-13', Origin: 'null' } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), 'bytes 5-13/36');
  assert.equal(range.headers.get('access-control-allow-origin'), 'null');
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), movieBytes.subarray(5, 14));
  const head = await fetch(bridgeURL + details.streamUrl, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(movieBytes.length));
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  const forbiddenStream = await fetch(bridgeURL + '/api/plex/stream/999');
  assert.equal(forbiddenStream.status, 503);
  const progress = await fetch(bridgeURL + '/api/plex/progress/100', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'null' },
    body: JSON.stringify({ state: 'paused', timeMs: 70000, durationMs: 100000 }),
  });
  assert.equal(progress.status, 200);
  assert.match(timelineRecorded, /time=70000/);
  assert.match(timelineRecorded, /ratingKey=100/);
  const rejectedProgress = await fetch(bridgeURL + '/api/plex/progress/100', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: 'playing', timeMs: -999, durationMs: 100000 }),
  });
  assert.equal(rejectedProgress.status, 400);
  console.log('PASS: Plex resume metadata, real byte-range streaming, timeline progress, token isolation, and artwork');
} finally {
  bridge.kill();
  await Promise.race([once(bridge, 'exit'), new Promise(resolve => setTimeout(resolve, 500))]);
  await new Promise(resolve => mockPlex.close(resolve));
}
