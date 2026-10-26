import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const port = 19562;
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['server.mjs'], {
  cwd: new URL('.', import.meta.url),
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) },
  stdio: 'ignore',
});

try {
  let ready = false;
  for (let attempt = 0; attempt < 45; attempt++) {
    try {
      const response = await fetch(`${base}/media/live-car.mp4`, { method: 'HEAD' });
      if (response.ok) { ready = true; break; }
    } catch {}
    await delay(100);
  }
  assert.ok(ready, 'LAN bridge did not start');
  for (const name of ['live-car.mp4', 'live-christmas.mp4', 'drivein-lobby-hd.mp4']) {
    const url = `${base}/media/${name}`;
    const head = await fetch(url, { method: 'HEAD' });
    assert.equal(head.status, 200, `${name}: HEAD should succeed`);
    assert.equal(head.headers.get('accept-ranges'), 'bytes');
    assert.equal(head.headers.get('content-type'), 'video/mp4');
    const range = await fetch(url, { headers: { Range: 'bytes=0-1023' } });
    assert.equal(range.status, 206, `${name}: range should succeed`);
    assert.match(range.headers.get('content-range'), /^bytes 0-1023\/\d+$/);
    assert.equal((await range.arrayBuffer()).byteLength, 1024);
  }
  console.log('PASS: packaged Live and Cinema videos support HTTP HEAD and byte-range playback');
} finally {
  child.kill('SIGTERM');
}
