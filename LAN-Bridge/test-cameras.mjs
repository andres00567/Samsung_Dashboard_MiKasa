import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const exampleJpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFwABAQEBAAAAAAAAAAAAAAAAAAUGB//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhADEAAAAc8A/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQL/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/Af/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQIBAT8B/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyH/2Q==', 'base64');
const soapActions = [];
const testCameraServer = http.createServer(async (req, res) => {
  if (req.url.startsWith('/onvif/')) {
    let body = '';for await (const chunk of req) body += chunk;
    assert(body.includes('<wsse:Username>viewer</wsse:Username>'));
    assert(body.includes('#PasswordDigest'));
    assert(!body.includes('>secret</wsse:Password>'));
    const action = ['GetCapabilities', 'GetProfiles', 'GetStreamUri'].find(item => body.includes(':' + item + '>'));
    soapActions.push(action);
    const payload = action === 'GetCapabilities'
      ? `<tds:GetCapabilitiesResponse><tds:Capabilities><tt:Media><tt:XAddr>http://127.0.0.1:${testCameraServer.address().port}/onvif/media_service</tt:XAddr></tt:Media></tds:Capabilities></tds:GetCapabilitiesResponse>`
      : action === 'GetProfiles' ? '<trt:GetProfilesResponse><trt:Profiles token="substream"/></trt:GetProfilesResponse>'
      : '<trt:GetStreamUriResponse><trt:MediaUri><tt:Uri>rtsp://127.0.0.1:9554/live</tt:Uri></trt:MediaUri></trt:GetStreamUriResponse>';
    res.writeHead(200, { 'Content-Type': 'application/soap+xml' });res.end(`<s:Envelope><s:Body>${payload}</s:Body></s:Envelope>`);return;
  }
  if (req.headers.authorization !== 'Basic ' + Buffer.from('viewer:secret').toString('base64')) {
    res.writeHead(401);res.end();return;
  }
  res.writeHead(200, { 'Content-Type': 'image/jpeg' });res.end(exampleJpeg);
});
testCameraServer.listen(0, '127.0.0.1');
await once(testCameraServer, 'listening');
const sourcePort = testCameraServer.address().port;
const reserve = http.createServer();reserve.listen(0, '127.0.0.1');await once(reserve, 'listening');
const bridgePort = reserve.address().port;reserve.close();
const bridge = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'server.mjs')], {
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(bridgePort),
    CAMERA_1_NAME: 'Front Door', CAMERA_1_TYPE: 'snapshot',
    CAMERA_1_URL: `http://127.0.0.1:${sourcePort}/snapshot.jpg`,
    CAMERA_1_USER: 'viewer', CAMERA_1_PASSWORD: 'secret',
    CAMERA_2_NAME: 'Garage ONVIF', CAMERA_2_TYPE: 'onvif',
    CAMERA_2_URL: `http://127.0.0.1:${sourcePort}/onvif/device_service`,
    CAMERA_2_USER: 'viewer', CAMERA_2_PASSWORD: 'secret',
    CAMERA_3_NAME: 'Tapo Preset', CAMERA_3_TYPE: 'tapo',
    CAMERA_3_URL: `http://127.0.0.1:${sourcePort}`,
    CAMERA_3_USER: 'viewer', CAMERA_3_PASSWORD: 'secret',
    CAMERA_4_NAME: 'CamHiPro Preset', CAMERA_4_TYPE: 'camhipro',
    CAMERA_4_URL: `http://127.0.0.1:${sourcePort}`,
    CAMERA_4_USER: 'viewer', CAMERA_4_PASSWORD: 'secret',
    FFMPEG_PATH: 'mikasa-intentionally-missing-ffmpeg', }, stdio: ['ignore', 'pipe', 'pipe'],
});
try {
  let ready = false;
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`http://127.0.0.1:${bridgePort}/api/cameras`);if (r.ok) {ready=true;break} }
    catch { await new Promise(resolve => setTimeout(resolve, 80)) }
  }
  assert(ready, 'Bridge did not start');
  const listing = await (await fetch(`http://127.0.0.1:${bridgePort}/api/cameras`)).json();
  assert.equal(listing.items.length, 4);
  assert.deepEqual(listing.items[0], { id: 'camera-1', name: 'Front Door', type: 'snapshot', feed: '/api/cameras/camera-1/feed' });
  assert(!JSON.stringify(listing).includes('secret'));
  const result = await fetch(`http://127.0.0.1:${bridgePort}${listing.items[0].feed}`);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await result.arrayBuffer()), exampleJpeg);
  for (const index of [2, 3, 4]) {
    const status = await (await fetch(`http://127.0.0.1:${bridgePort}/api/cameras/camera-${index}/status`)).json();
    assert.equal(status.ready, false, 'Missing FFmpeg cannot mark the stream ready');
    const snapshot = await fetch(`http://127.0.0.1:${bridgePort}/api/cameras/camera-${index}/snapshot`);
    assert.equal(snapshot.status, 503, 'Snapshot reports warming or transcoder failure');
  }
  for (let i = 0; i < 80 && soapActions.length < 9; i++) await new Promise(resolve => setTimeout(resolve, 80));
  assert(soapActions.includes('GetCapabilities') && soapActions.includes('GetStreamUri'), 'ONVIF was discovered');
  const absent = await fetch(`http://127.0.0.1:${bridgePort}/api/cameras/camera-5/feed`);
  assert.equal(absent.status, 404);
  console.log('PASS: camera discovery, WS-Security ONVIF discovery, RTSP URI negotiation, credential isolation, image proxy, and shared-stream status');
} finally {
  bridge.kill();testCameraServer.close();
}
