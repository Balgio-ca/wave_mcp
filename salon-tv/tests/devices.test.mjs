// Tests du registre d'appareils (validation pure, sans I/O réseau).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isole DATA_DIR avant d'importer les modules qui le lisent.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-test-'));

const { normalizeDevice, DeviceRegistry } = await import('../src/devices.js');

test('normalizeDevice : valide et complète', () => {
  const d = normalizeDevice({ name: 'Bar TV', type: 'firetv', host: '192.168.0.13' });
  assert.equal(d.name, 'Bar TV');
  assert.equal(d.type, 'firetv');
  assert.equal(d.port, 5555);       // défaut
  assert.equal(d.room, 'Salon');    // défaut
  assert.match(d.id, /^dev_/);
});

test('normalizeDevice : rejette les entrées invalides', () => {
  assert.throws(() => normalizeDevice({ name: '', type: 'firetv', host: '192.168.0.1' }), /Nom requis/);
  assert.throws(() => normalizeDevice({ name: 'X', type: 'webos', host: '192.168.0.1' }), /Type invalide/);
  assert.throws(() => normalizeDevice({ name: 'X', type: 'firetv', host: '999.1.1.1' }), /IP invalide/);
  assert.throws(() => normalizeDevice({ name: 'X', type: 'firetv', host: 'abc' }), /IP invalide/);
  assert.throws(() => normalizeDevice({ name: 'X', type: 'firetv', host: '192.168.0.1', port: 70000 }), /Port invalide/);
});

test('normalizeDevice : type du catalogue + port par défaut associé', () => {
  const r = normalizeDevice({ name: 'Bar', type: 'roku', host: '192.168.0.40' });
  assert.equal(r.type, 'roku');
  assert.equal(r.port, 8060);   // port ECP, pas 5555
});

test('registre : ajout, pièces, doublon, suppression', () => {
  const reg = new DeviceRegistry();
  reg.devices = [];                                  // repart d'un registre vide
  const a = reg.add({ name: 'Shield', type: 'androidtv', host: '192.168.0.70', room: 'Man Cave' });
  const b = reg.add({ name: 'Fire TV', type: 'firetv', host: '192.168.0.13', room: 'Man Cave' });
  reg.add({ name: 'Chambre', type: 'firetv', host: '192.168.0.20', room: 'Chambre' });

  assert.equal(reg.all().length, 3);
  const rooms = reg.rooms();
  assert.equal(rooms.length, 2);
  assert.equal(rooms.find((r) => r.name === 'Man Cave').devices.length, 2);

  // Doublon d'adresse refusé
  assert.throws(() => reg.add({ name: 'Autre', type: 'firetv', host: '192.168.0.13' }), /utilise déjà/);

  // Mise à jour
  const renamed = reg.update(a.id, { name: 'Shield Pro' });
  assert.equal(renamed.name, 'Shield Pro');
  assert.equal(renamed.host, '192.168.0.70'); // inchangé

  // Renommage de pièce
  assert.equal(reg.renameRoom('Man Cave', 'La Cave'), 2);
  assert.equal(reg.get(b.id).room, 'La Cave');

  // Suppression
  reg.remove(b.id);
  assert.equal(reg.all().length, 2);
  assert.throws(() => reg.remove('dev_inconnu'), /Appareil inconnu/);
});
