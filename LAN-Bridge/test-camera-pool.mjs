import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createCameraPool } from './camera-pool.mjs';

const jpeg = Buffer.from([0xff,0xd8,0xff,0xe0,0,4,1,2,0xff,0xd9]);
const processes = [];
function spawnProcess() {
  const proc = new EventEmitter();
  proc.stdout = new PassThrough();proc.stderr = new PassThrough();
  proc.kill = () => { proc.emit('close', 0);return true };
  processes.push(proc);return proc;
}
function response() {
  const res = new EventEmitter();res.chunks=[];res.writableLength=0;res.destroyed=false;res.writableEnded=false;
  res.writeHead=(status,headers)=>{res.status=status;res.headers=headers};
  res.write=chunk=>{res.chunks.push(Buffer.from(chunk));return true};
  res.end=chunk=>{if(chunk)res.write(chunk);res.writableEnded=true;res.emit('close')};
  return res;
}
const pool=createCameraPool([{id:'camera-1',type:'rtsp',url:'rtsp://example.test/stream',username:'',password:''}],
  { resolveUrl: async camera=>camera.url,spawnProcess,log:{warn(){}} });
try {
  const first=response();pool.serve({},first,'camera-1');
  const second=response();pool.serve({},second,'camera-1');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(processes.length,1,'two consumers must share one FFmpeg process');
  const process=processes[0];
  process.stdout.write(jpeg.subarray(0,5));process.stdout.write(jpeg.subarray(5));
  assert.equal(pool.status('camera-1').frames,1,'split JPEG must be assembled into one frame');
  assert(first.chunks.some(chunk=>chunk.equals(jpeg)),'first viewer receives JPEG');
  assert(second.chunks.some(chunk=>chunk.equals(jpeg)),'second viewer receives the same JPEG');
  const snapshot=response();pool.serve({},snapshot,'camera-1','snapshot');
  assert.equal(snapshot.status,200,'warm snapshot should be instantly available');
  assert(snapshot.chunks[0].equals(jpeg),'snapshot must match latest frame');
  first.end();second.end();
  assert.equal(pool.status('camera-1').subscribers,0,'viewer cleanup must release clients');
  assert.equal(processes.length,1,'closing the viewer must not stop the shared feed');
  console.log('PASS: one transcoder, two viewers, split JPEG parsing, instant snapshot, viewer cleanup');
} finally {pool.close()}
