import test from 'node:test';
import assert from 'node:assert/strict';
import { isNewer, parseTag, installKind, pickAsset } from '../update.mjs';

test('parseTag', () => {
  assert.deepEqual(parseTag('rapidraw-v1.6.9-web-v1.15.6'), { up: '1.6.9', web: '1.15.6' });
  assert.equal(parseTag('v1.6.9'), null);
  assert.equal(parseTag(undefined), null);
});

test('isNewer compares the web layer first, then RapidRAW', () => {
  const cur = 'rapidraw-v1.6.9-web-v1.15.6';
  assert.ok(isNewer('rapidraw-v1.6.9-web-v1.16.0', cur));
  assert.ok(isNewer('rapidraw-v1.6.10-web-v1.15.6', cur));
  assert.ok(isNewer('rapidraw-v1.6.9-web-v1.15.10', cur), 'numeric, not lexical');
  assert.ok(!isNewer(cur, cur));
  assert.ok(!isNewer('rapidraw-v1.7.0-web-v1.15.5', cur), 'an older web layer is never an update');
  assert.ok(!isNewer('garbage', cur));
});

test('installKind', () => {
  assert.equal(installKind({ platform: 'win32', execPath: 'C:\\Program Files\\RapidRAW Web Bridge\\rrweb-node.exe' }).kind, 'nsis');
  assert.deepEqual(installKind({ platform: 'darwin', execPath: '/Applications/RapidRAW Web Bridge.app/Contents/MacOS/rrweb-node' }),
    { kind: 'dmg', app: '/Applications/RapidRAW Web Bridge.app' });
  assert.equal(installKind({ platform: 'darwin', execPath: '/usr/local/bin/node' }), null);
  assert.deepEqual(installKind({ platform: 'linux', env: { APPIMAGE: '/home/u/RR.AppImage' }, execPath: '/tmp/.mount_x/usr/bin/rrweb-node' }),
    { kind: 'appimage', file: '/home/u/RR.AppImage' });
  assert.equal(installKind({ platform: 'linux', env: {}, execPath: '/usr/bin/rrweb-node', exists: () => true }).kind, 'deb');
  assert.equal(installKind({ platform: 'linux', env: {}, execPath: '/usr/bin/rrweb-node', exists: () => false }).kind, 'rpm');
  assert.equal(installKind({ platform: 'linux', env: {}, execPath: '/home/u/node/bin/node' }), null);
});

test('pickAsset', () => {
  const t = 'rapidraw-v1.6.9-web-v1.16.0';
  const assets = ['_linux_arm64.AppImage', '_linux_x64.AppImage', '_linux_x64.deb', '_linux_arm64.rpm', '_linux_server.tar.gz',
    '_macos_arm64.dmg', '_macos_x64.dmg', '_windows_x64-setup.exe'].map((s) => ({ name: t + s }));
  assert.equal(pickAsset(assets, { kind: 'nsis' }, 'x64').name, `${t}_windows_x64-setup.exe`);
  assert.equal(pickAsset(assets, { kind: 'dmg' }, 'arm64').name, `${t}_macos_arm64.dmg`);
  assert.equal(pickAsset(assets, { kind: 'appimage' }, 'x64').name, `${t}_linux_x64.AppImage`);
  assert.equal(pickAsset(assets, { kind: 'rpm' }, 'arm64').name, `${t}_linux_arm64.rpm`);
  assert.equal(pickAsset(assets, { kind: 'deb' }, 'arm64'), null);
});
