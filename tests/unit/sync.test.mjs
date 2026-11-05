// Sync tests against a mocked Google Drive. Invented data and accounts only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Repo } from '../../docs/js/repo.js';
import { MemoryStore } from '../../docs/js/store.js';
import { DriveClient } from '../../docs/js/drive.js';
import { SyncEngine } from '../../docs/js/sync.js';
import { DRIVE_FILE_NAME } from '../../docs/js/constants.js';
import { val, buildModel, mergeRegs } from '../../docs/js/doc.js';
import { createMockDrive, fakeAuth } from '../mock-drive.mjs';

// Deterministic, always-advancing clock.
let fakeNow = Date.UTC(2026, 10, 1);
Date.now = () => (fakeNow += 7);

const ALICE = { id: 'perm-alice', email: 'alice.test@example.com', name: 'Alice Test' };
const BOB = { id: 'perm-bob', email: 'bob.test@example.com', name: 'Bob Test' };

async function device(drive, token = 'tok-alice') {
  const repo = await new Repo(new MemoryStore()).load();
  const tokenRef = { value: token };
  const online = { value: true };
  const engine = new SyncEngine({
    repo, configured: true, auth: fakeAuth(tokenRef),
    drive: new DriveClient(async () => tokenRef.value, drive.fetch),
    isOnline: () => online.value,
  });
  return { repo, engine, tokenRef, online, sync: (o) => engine.sync(o) };
}

function setup() {
  const drive = createMockDrive();
  drive.addUser('tok-alice', ALICE);
  drive.addUser('tok-bob', BOB);
  return drive;
}
const v = (dev, k) => val(dev.repo.regs, k, null);

test('first sync creates the clearly named Drive file; second device receives the data', async () => {
  const drive = setup();
  const A = await device(drive);
  await A.repo.set('v:l-salary:0', 1234500);
  await A.sync();
  assert.equal(A.engine.state.status, 'ok');
  const files = drive.filesOf(ALICE.id);
  assert.equal(files.length, 1);
  assert.equal(files[0].name, DRIVE_FILE_NAME);
  assert.equal(A.repo.pendingCount, 0);
  assert.ok(A.repo.meta.lastSync);
  assert.equal(A.repo.meta.linked.email, ALICE.email);

  const B = await device(drive);
  await B.sync();
  assert.equal(B.engine.state.status, 'ok');
  assert.equal(v(B, 'v:l-salary:0'), 1234500);
  assert.equal(drive.filesOf(ALICE.id).length, 1, 'no duplicate file');
});

test('two fresh devices never duplicate the default groups', async () => {
  const drive = setup();
  const A = await device(drive);
  const B = await device(drive);
  await A.sync();
  await B.sync();
  await A.sync();
  const m = buildModel(A.repo.regs);
  assert.equal(m.groups.filter((g) => g.name === 'Housing').length, 1);
  assert.equal(m.accounts.length, 5);
});

test('offline edits are queued and merged value by value with another device', async () => {
  const drive = setup();
  const A = await device(drive);
  const B = await device(drive);
  await A.sync();
  await B.sync();

  // A goes offline and edits salary + a shared value
  A.online.value = false;
  await A.repo.set('v:l-salary:0', 2000000);
  await A.repo.set('v:l-groceries:0', 150000);
  await A.sync();
  assert.equal(A.engine.state.status, 'offline');
  assert.equal(A.repo.pendingCount, 2);

  // Meanwhile B edits rent and (later) the same groceries value
  await B.repo.set('v:l-rent:0', 700000);
  await B.repo.set('v:l-groceries:0', 180000);
  await B.sync();

  // A back online
  A.online.value = true;
  await A.sync();
  assert.equal(A.engine.state.status, 'ok');
  assert.equal(A.repo.pendingCount, 0);
  await B.sync();

  for (const d of [A, B]) {
    assert.equal(v(d, 'v:l-salary:0'), 2000000, 'A’s salary survives');
    assert.equal(v(d, 'v:l-rent:0'), 700000, 'B’s rent survives');
    assert.equal(v(d, 'v:l-groceries:0'), 180000, 'newest edit of the same value wins');
  }
});

test('network failure mid-sync is treated as offline and retried later', async () => {
  const drive = setup();
  const A = await device(drive);
  await A.repo.set('v:l-salary:0', 100);
  drive.setOffline(true);
  await A.sync();
  assert.equal(A.engine.state.status, 'offline');
  assert.equal(A.repo.pendingCount, 1);
  drive.setOffline(false);
  await A.sync();
  assert.equal(A.engine.state.status, 'ok');
  assert.equal(A.repo.pendingCount, 0);
});

test('deletions propagate and beat older edits; renames and reorders merge', async () => {
  const drive = setup();
  const A = await device(drive);
  const B = await device(drive);
  await A.sync(); await B.sync();

  await B.repo.set('v:l-fuel:0', 30000);      // B edits a line (earlier)
  A.online.value = false;
  await A.repo.set('l:l-fuel:del', true);      // A deletes it while offline (later)
  await A.repo.set('g:g-lifestyle:name', 'Fun money');
  await B.repo.set('g:g-debt:order', 5);       // B reorders a different group
  await B.sync();
  A.online.value = true;
  await A.sync();
  await B.sync();

  for (const d of [A, B]) {
    const m = buildModel(d.repo.regs);
    assert.ok(!m.groups.flatMap((g) => g.lines).some((l) => l.id === 'l-fuel'), 'deleted line gone');
    assert.ok(m.groups.some((g) => g.name === 'Fun money'));
    assert.equal(m.groups[0].id, 'g-debt');
  }
});

test('wrong Google account: sync is blocked and nothing is merged or uploaded', async () => {
  const drive = setup();
  const A = await device(drive);
  await A.repo.set('v:l-salary:0', 999900);
  await A.sync();
  const aliceFileBefore = drive.filesOf(ALICE.id)[0].content;

  // Bob has his own budget file
  const Bdev = await device(drive, 'tok-bob');
  await Bdev.repo.set('v:l-rent:0', 111100);
  await Bdev.sync();

  // Now Bob signs in on Alice's device
  A.tokenRef.value = 'tok-bob';
  await A.repo.set('v:l-salary:1', 5000);
  await A.sync();
  assert.equal(A.engine.state.status, 'wrong-account');
  assert.equal(A.engine.state.linked.email, ALICE.email);
  assert.equal(A.engine.state.current.email, BOB.email);
  assert.equal(v(A, 'v:l-rent:0'), null, 'Bob’s data did not enter Alice’s device');
  assert.equal(drive.filesOf(BOB.id).length, 1);
  assert.ok(!drive.filesOf(BOB.id)[0].content.includes('999900'), 'Alice’s data did not reach Bob’s Drive');
  assert.equal(drive.filesOf(ALICE.id)[0].content, aliceFileBefore);
  assert.equal(A.repo.meta.linked.id, ALICE.id, 'link unchanged');

  // Repeated syncs stay blocked
  await A.sync();
  assert.equal(A.engine.state.status, 'wrong-account');

  // "Move this device's data" is refused because Bob already has data
  await A.engine.linkLocalToNewAccount();
  assert.equal(A.repo.meta.linked.id, ALICE.id);
  assert.match(A.engine.state.message, /already has budget data/);

  // Explicit choice: use Bob's data on this device
  await A.engine.useNewAccount();
  assert.equal(A.engine.state.status, 'ok');
  assert.equal(A.repo.meta.linked.id, BOB.id);
  assert.equal(v(A, 'v:l-rent:0'), 111100);
  assert.equal(v(A, 'v:l-salary:0'), null, 'Alice’s figures were not merged into Bob’s');
  assert.ok(!drive.filesOf(BOB.id)[0].content.includes('999900'));
});

test('wrong account with an empty Drive: user may move this device’s data across', async () => {
  const drive = setup();
  const A = await device(drive);
  await A.repo.set('v:l-salary:0', 4200);
  await A.sync();
  A.tokenRef.value = 'tok-bob';
  await A.sync();
  assert.equal(A.engine.state.status, 'wrong-account');
  await A.engine.linkLocalToNewAccount();
  assert.equal(A.engine.state.status, 'ok');
  assert.equal(A.repo.meta.linked.id, BOB.id);
  assert.ok(drive.filesOf(BOB.id)[0].content.includes('4200'));
});

test('first link with data on both sides asks before combining', async () => {
  const drive = setup();
  const A = await device(drive);
  await A.repo.set('v:l-salary:0', 100);
  await A.sync();
  const C = await device(drive);
  await C.repo.set('v:l-rent:0', 200);
  await C.sync();
  assert.equal(C.engine.state.status, 'first-link');
  assert.equal(C.repo.meta.linked, null);
  await C.sync({ firstLink: 'merge' });
  assert.equal(C.engine.state.status, 'ok');
  assert.equal(v(C, 'v:l-salary:0'), 100);
  assert.equal(v(C, 'v:l-rent:0'), 200);

  const D = await device(drive);
  await D.repo.set('v:l-fuel:0', 300);
  await D.sync();
  await D.sync({ firstLink: 'use-drive' });
  assert.equal(v(D, 'v:l-fuel:0'), null);
  assert.equal(v(D, 'v:l-rent:0'), 200);
});

test('expired token asks to sign in again instead of failing', async () => {
  const drive = setup();
  const A = await device(drive);
  await A.sync();
  A.tokenRef.value = 'tok-expired';
  await A.sync();
  assert.equal(A.engine.state.status, 'signin');
});

test('passphrase encryption: file is unreadable without it; wrong passphrase rejected; turning off propagates', async () => {
  const drive = setup();
  const A = await device(drive);
  const B = await device(drive);
  await A.sync(); await B.sync();
  await A.repo.set('l:l-salary:name', 'Secret salary line');
  await A.engine.enableEncryption('correct horse battery');
  assert.equal(A.engine.state.status, 'ok');
  const content = drive.filesOf(ALICE.id)[0].content;
  assert.ok(!content.includes('Secret salary'));
  assert.ok(!content.includes('Housing'));
  assert.equal(JSON.parse(content).encrypted, true);

  await B.sync();
  assert.equal(B.engine.state.status, 'passphrase');
  await B.engine.unlock('wrong passphrase');
  assert.equal(B.engine.state.status, 'passphrase');
  assert.equal(B.engine.state.wrong, true);
  await B.engine.unlock('correct horse battery');
  assert.equal(B.engine.state.status, 'ok');
  assert.equal(v(B, 'l:l-salary:name'), 'Secret salary line');

  // B edits, still encrypted
  await B.repo.set('v:l-salary:0', 777);
  await B.sync();
  assert.equal(JSON.parse(drive.filesOf(ALICE.id)[0].content).encrypted, true);
  await A.sync();
  assert.equal(v(A, 'v:l-salary:0'), 777);

  // A turns encryption off -> plaintext, and B follows
  await A.engine.disableEncryption();
  assert.equal(JSON.parse(drive.filesOf(ALICE.id)[0].content).encrypted, false);
  await B.sync();
  assert.equal(B.engine.state.status, 'ok');
  assert.equal(B.repo.keyInfo, null);
});

test('restoring a backup wins over newer Drive data and propagates', async () => {
  const drive = setup();
  const A = await device(drive);
  const B = await device(drive);
  await A.repo.set('v:l-salary:0', 100);
  await A.sync(); await B.sync();
  const backup = structuredClone(A.repo.regs);
  await B.repo.set('v:l-salary:0', 500);
  await B.repo.set('v:l-rent:0', 50);
  await B.repo.set('g:g-new1:name', 'Added later');
  await B.repo.set('g:g-new1:kind', 'out');
  await B.sync();
  await A.sync();
  await A.repo.restore(backup);
  await A.sync();
  await B.sync();
  for (const d of [A, B]) {
    assert.equal(v(d, 'v:l-salary:0'), 100);
    assert.equal(v(d, 'v:l-rent:0'), null);
    assert.ok(!buildModel(d.repo.regs).groups.some((g) => g.name === 'Added later'));
  }
});

test('merge is commutative and idempotent', () => {
  const a = { x: { v: 1, t: 5, d: 'a' }, y: { v: 2, t: 9, d: 'a' } };
  const b = { x: { v: 3, t: 6, d: 'b' }, y: { v: 4, t: 9, d: 'b' }, z: { v: 5, t: 1, d: 'b' } };
  const ab = mergeRegs(a, b).merged;
  const ba = mergeRegs(b, a).merged;
  assert.deepEqual(ab, ba);
  assert.deepEqual(mergeRegs(ab, ab).merged, ab);
  assert.equal(mergeRegs(ab, ab).localChanged, false);
  assert.equal(ab.y.v, 4); // tie on time -> higher device id
});
