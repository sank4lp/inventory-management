import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {displayEntry, displayFrame} from '../src/services/hardware-adapters/display-frame.js';

test('two actual firmware instances share the bus without replying to each other', t => {
  const compiler = process.env.CXX || 'c++';
  try { execFileSync(compiler, ['--version'], {stdio: 'ignore'}); }
  catch { t.skip('C++ compiler unavailable'); return; }
  const root = fileURLToPath(new URL('../', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'rs485-multidrop-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const peers = [4, 15].map((count, i) => {
    const address = `CTRL${i + 1}`, binary = join(dir, address), history = [];
    execFileSync(compiler, ['-std=c++17', '-I', join(root, 'test/fixtures/esp32'),
      `-DCONTROLLER_ADDRESS="${address}"`, `-DCONTROLLER_NAME="${address}"`, `-DLED_MODULE_COUNT=${count}`,
      join(root, 'test/fixtures/esp32/multidrop.cpp'), '-o', binary]);
    function run() {
      return execFileSync(binary, [], {input: history.length ? history.join('\n') + '\n' : '', encoding: 'utf8'})
        .trim().split('\n').map(line => {
          const row = JSON.parse(line);
          row.bus = Buffer.from(row.bus, 'hex').toString(); row.usb = Buffer.from(row.usb, 'hex').toString();
          assert.equal(row.replyAllowed, false, 'transmit permission must end with each command');
          return row;
        });
    }
    const startup = run()[0];
    assert.equal(startup.bus, '', 'boot announcements must not collide on RS485');
    assert.equal(JSON.parse(startup.usb).address, address);
    return {address, count, receive(line) { history.push(line); return run().at(-1); }};
  });

  // A real shared bus delivers a controller's replies to every OTHER receiver,
  // as well as the Pi. Single-controller transport mocks miss this feedback loop.
  function exchange(command) {
    const pending = [{sender: null, text: command}], replies = [];
    let deliveries = 0;
    while (pending.length) {
      assert.ok(++deliveries < 12, 'controller responses must not create an endless reply loop');
      const {sender, text} = pending.shift();
      for (const peer of peers) {
        if (peer === sender) continue;
        const result = peer.receive(text);
        for (const line of result.bus.trim().split('\n').filter(Boolean)) {
          replies.push({sender: peer.address, ...JSON.parse(line)});
          pending.push({sender: peer, text: line});
        }
      }
    }
    return replies;
  }

  for (let round = 0; round < 10; round++) {
    for (const peer of (round % 2 ? [...peers].reverse() : peers)) {
      const replies = exchange(`to ${peer.address} ping`);
      assert.equal(replies.length, 1);
      assert.equal(replies[0].type, 'pong'); assert.equal(replies[0].address, peer.address);
      assert.equal(replies[0].modules, peer.count);
    }
  }
  for (const peer of peers) {
    const replies = exchange(`to ${peer.address} unsupported-command`);
    assert.equal(replies.length, 1); assert.equal(replies[0].sender, peer.address);
    assert.equal(replies[0].message, 'unknown-command');
    const status = exchange(`to ${peer.address} config-status 0123456789abcdef`);
    assert.equal(status.length, 1); assert.equal(status[0].physicalModules, peer.count);
    const frame = displayFrame(peer.address, '0123456789abcdef', [displayEntry(`to ${peer.address} digit 1 "7" green 120 100`)]);
    const ack = exchange(frame.command);
    assert.equal(ack.length, 1); assert.equal(ack[0].address, peer.address);
    assert.equal(ack[0].command, 'display-frame'); assert.equal(ack[0].checksum, frame.checksum);
  }
  for (const command of ['ping', 'to all ping', 'to * status', 'to broadcast version',
    'sync-heartbeat 3', 'to all sync-heartbeat 4', 'to', 'to CTRL1', 'to OTHER ping',
    'random noise', '{"type":"error","message":"unknown-command"}',
    '  {"type":"ack","command":"idle"}', '\t{"type":"boot"}', '{bad JSON']) {
    assert.deepEqual(exchange(command), [], command);
  }
  // Legacy broadcast display commands still apply, without simultaneous ACKs.
  assert.deepEqual(exchange('to all off'), []);
  for (const peer of peers) {
    assert.equal(peer.receive('sync-heartbeat 2').mode, 0);
    const usb = peer.receive(`USB:to ${peer.address} config-status 0123456789abcdef`);
    assert.equal(usb.bus, ''); assert.equal(JSON.parse(usb.usb).address, peer.address);
    const rejected = peer.receive('USB:ping');
    assert.equal(rejected.bus, ''); assert.equal(JSON.parse(rejected.usb).message, 'usb-maintenance-only');
  }
});
