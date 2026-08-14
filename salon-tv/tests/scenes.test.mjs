// Tests du moteur de scènes avec des contrôleurs simulés.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-scenes-'));

const { listScenes, runScene } = await import('../src/scenes.js');

// Contrôleur simulé : enregistre les appels reçus.
function fake(id, name, room, { failing = false } = {}) {
  const c = {
    id,
    device: { id, name, room },
    status: { muted: false },
    calls: [],
    getState() { return { id, name, room, muted: this.status.muted }; },
    async setMuted(v) {
      if (failing) throw new Error('hors ligne');
      this.calls.push(`mute:${v}`);
      this.status.muted = v;
    },
    async key(k) {
      if (failing) throw new Error('hors ligne');
      this.calls.push(`key:${k}`);
    },
    async standby() {
      if (failing) throw new Error('hors ligne');
      this.calls.push('standby');
    },
  };
  return c;
}

function manager(controllers) {
  return {
    get: (id) => controllers.find((c) => c.id === id) || null,
    all: () => controllers,
    inRoom: (room) => controllers.filter((c) => c.device.room === room),
    roomsState() {
      const m = new Map();
      for (const c of controllers) {
        if (!m.has(c.device.room)) m.set(c.device.room, []);
        m.get(c.device.room).push(c.getState());
      }
      return [...m.entries()].map(([name, devices]) => ({ name, devices }));
    },
  };
}

test('catalogue : solo par appareil + scènes de pièce', () => {
  const m = manager([fake('d1', 'Shield', 'Cave'), fake('d2', 'Fire', 'Cave')]);
  const ids = listScenes(m).map((s) => s.id);
  assert.ok(ids.includes('solo:d1'));
  assert.ok(ids.includes('solo:d2'));
  assert.ok(ids.includes('switch:Cave'));
  assert.ok(ids.includes('silence:Cave'));
  assert.ok(ids.includes('off:Cave'));
  // Une seule pièce -> pas de scènes globales
  assert.ok(!ids.includes('silence:*'));
});

test('catalogue : scènes globales dès deux pièces', () => {
  const m = manager([fake('d1', 'A', 'Cave'), fake('d2', 'B', 'Salon')]);
  const ids = listScenes(m).map((s) => s.id);
  assert.ok(ids.includes('silence:*'));
  assert.ok(ids.includes('off:*'));
});

test('solo : cible au son, le reste de la pièce en muet', async () => {
  const a = fake('d1', 'Shield', 'Cave');
  const b = fake('d2', 'Fire', 'Cave');
  const c = fake('d3', 'Chambre', 'Chambre');
  const res = await runScene('solo:d1', manager([a, b, c]));
  assert.deepEqual(res.errors, []);
  assert.deepEqual(a.calls, ['mute:false']);
  assert.deepEqual(b.calls, ['mute:true']);
  assert.deepEqual(c.calls, []); // autre pièce : intacte
});

test('switch : fait tourner le solo', async () => {
  const a = fake('d1', 'A', 'Cave');
  const b = fake('d2', 'B', 'Cave');
  a.status.muted = false; b.status.muted = true;   // A au son
  const m = manager([a, b]);
  await runScene('switch:Cave', m);
  assert.equal(a.status.muted, true);
  assert.equal(b.status.muted, false);             // passé à B
  await runScene('switch:Cave', m);
  assert.equal(a.status.muted, false);             // et revient à A
});

test('silence / off / pause par pièce', async () => {
  const a = fake('d1', 'A', 'Cave');
  const b = fake('d2', 'B', 'Cave');
  const m = manager([a, b]);
  await runScene('silence:Cave', m);
  assert.deepEqual(a.calls, ['mute:true']);
  await runScene('pause:Cave', m);
  assert.ok(b.calls.includes('key:play_pause'));
  await runScene('off:Cave', m);
  assert.ok(a.calls.includes('standby'));
});

test('best-effort : un appareil en échec n’empêche pas les autres', async () => {
  const ok = fake('d1', 'OK', 'Cave');
  const ko = fake('d2', 'KO', 'Cave', { failing: true });
  const res = await runScene('silence:Cave', manager([ok, ko]));
  assert.deepEqual(ok.calls, ['mute:true']);        // l'autre a bien agi
  assert.equal(res.errors.length, 1);
  assert.equal(res.errors[0].device, 'KO');
  assert.match(res.errors[0].error, /hors ligne/);
});

test('scène inconnue -> null', async () => {
  assert.equal(await runScene('solo:inexistant', manager([])), null);
  assert.equal(await runScene('nawak:x', manager([])), null);
});
