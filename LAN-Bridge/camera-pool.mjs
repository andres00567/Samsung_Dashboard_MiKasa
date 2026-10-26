import { spawn } from 'node:child_process';

// One FFmpeg process per RTSP camera, shared by every TV/browser viewer.
// The most recent complete JPEG is held in memory for immediate snapshots.
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const FRAME_BOUNDARY = 'mikasa-camera';

export function createCameraPool(cameras, { ffmpegPath = 'ffmpeg', resolveUrl, log = console, spawnProcess = spawn } = {}) {
  const entries = new Map(cameras.filter(c => ['rtsp', 'onvif', 'tapo', 'camhipro'].includes(c.type))
    .map(camera => [camera.id, { camera, clients: new Set(), jpeg: null, lastFrameAt: 0, process: null, starting: null,
      retry: null, retries: 0, sequence: 0, closed: false, lastError: '' }]));

  function broadcast(entry, frame) {
    entry.jpeg = frame;
    entry.lastFrameAt = Date.now();
    entry.sequence++;
    const header = Buffer.from(`--${FRAME_BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
    for (const res of entry.clients) {
      if (res.destroyed || res.writableEnded) { entry.clients.delete(res); continue; }
      // A slow TV cannot build an unbounded backlog of live frames.
      if (res.writableLength > MAX_FRAME_BYTES) continue;
      res.write(header); res.write(frame); res.write('\r\n');
    }
  }

  function decodeJpegs(entry, chunk, parser) {
    parser.buffer = Buffer.concat([parser.buffer, chunk]);
    while (parser.buffer.length) {
      const begin = parser.buffer.indexOf(Buffer.from([0xff, 0xd8]));
      if (begin < 0) { parser.buffer = Buffer.alloc(0); break; }
      if (begin) parser.buffer = parser.buffer.subarray(begin);
      const end = parser.buffer.indexOf(Buffer.from([0xff, 0xd9]), 2);
      if (end < 0) {
        if (parser.buffer.length > MAX_FRAME_BYTES) parser.buffer = Buffer.alloc(0);
        break;
      }
      const frame = parser.buffer.subarray(0, end + 2);
      parser.buffer = parser.buffer.subarray(end + 2);
      if (frame.length <= MAX_FRAME_BYTES) broadcast(entry, frame);
    }
  }

  function restart(entry) {
    if (entry.closed || entry.retry) return;
    const delay = Math.min(30_000, 2_000 * 2 ** Math.min(entry.retries++, 4));
    entry.retry = setTimeout(() => { entry.retry = null; void start(entry.camera.id); }, delay);
    entry.retry.unref?.();
  }

  async function start(id) {
    const entry = entries.get(id);
    if (!entry || entry.closed || entry.process || entry.starting) return entry?.starting;
    entry.starting = (async () => {
      try {
        const sourceUrl = new URL(await resolveUrl(entry.camera));
        if (entry.camera.username) sourceUrl.username = entry.camera.username;
        if (entry.camera.password) sourceUrl.password = entry.camera.password;
        const proc = spawnProcess(ffmpegPath, ['-nostdin', '-hide_banner', '-loglevel', 'error',
          '-rtsp_transport', 'tcp', '-i', sourceUrl.href, '-an', '-vf', 'fps=4,scale=960:-2',
          '-q:v', '5', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'],
          { stdio: ['ignore', 'pipe', 'pipe'] });
        entry.process = proc;
        const parser = { buffer: Buffer.alloc(0) };
        proc.stdout.on('data', chunk => {
          if (entry.process !== proc) return;
          decodeJpegs(entry, chunk, parser);
          entry.retries = 0;
        });
        let stderr = '';
        proc.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-800); });
        proc.on('error', error => { entry.lastError = error.code === 'ENOENT' ? 'FFmpeg is not installed' : error.message; });
        proc.on('close', code => {
          if (entry.process !== proc) return;
          entry.process = null;
          // Do not echo FFmpeg stderr to the TV; it can contain source URLs and passwords.
          entry.lastError ||= `Camera transcoder stopped (${code})`;
          log.warn(`Mi Kasa camera ${entry.camera.id} disconnected; reconnecting`);
          restart(entry);
        });
      } catch (error) {
        entry.lastError = 'Camera stream discovery failed';
        restart(entry);
      } finally { entry.starting = null; }
    })();
    return entry.starting;
  }

  function serve(req, res, id, mode = 'feed') {
    const entry = entries.get(id);
    if (!entry) return false;
    void start(id);
    if (mode === 'snapshot') {
      if (!entry.jpeg || Date.now() - entry.lastFrameAt > 10000) {
        res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: entry.lastError || 'Camera warming up' }));
      } else {
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': entry.jpeg.length,
          'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': 'null' });
        res.end(entry.jpeg);
      }
      return true;
    }
    res.writeHead(200, { 'Content-Type': `multipart/x-mixed-replace;boundary=${FRAME_BOUNDARY}`,
      'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': 'null', 'X-Content-Type-Options': 'nosniff' });
    entry.clients.add(res);
    res.on('close', () => entry.clients.delete(res));
    if (entry.jpeg && Date.now() - entry.lastFrameAt <= 10000) {
      const frame = entry.jpeg;
      res.write(`--${FRAME_BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
      res.write(frame); res.write('\r\n');
    }
    return true;
  }

  function prewarm() {
    let delay = 0;
    for (const id of entries.keys()) {
      const timer = setTimeout(() => void start(id), delay);
      timer.unref?.();
      delay += 300;
    }
  }

  function close() {
    for (const entry of entries.values()) {
      entry.closed = true;clearTimeout(entry.retry);
      entry.process?.kill();
      for (const client of entry.clients) client.end();
      entry.clients.clear();
    }
  }

  return { start, serve, prewarm, close, status: id => {
    const e = entries.get(id);
    return e && { ready: Boolean(e.jpeg && Date.now() - e.lastFrameAt <= 10000), connected: Boolean(e.process), subscribers: e.clients.size,
      frames: e.sequence, lastError: e.lastError };
  } };
}
