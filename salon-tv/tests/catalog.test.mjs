// Tests du catalogue, des capacités et de la déduction de type.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-cat-'));

const { CATALOG, getType, supports, defaultPortOf, probeMap, publicCatalog } = await import('../src/catalog.js');
const { guessType } = await import('../src/discovery.js');
const { supportedTypes, driverExists } = await import('../src/drivers.js');

test('catalogue : chaque type est complet et cohérent', () => {
  for (const t of CATALOG) {
    assert.ok(t.id && t.label, `${t.id} : id/label`);
    assert.ok(Array.isArray(t.capabilities) && t.capabilities.length, `${t.id} : capacités`);
    assert.ok(Array.isArray(t.probePorts) && t.probePorts.length, `${t.id} : ports de sonde`);
    assert.ok(Number.isInteger(t.defaultPort), `${t.id} : port par défaut`);
    // Un guide utilisable est indispensable : c'est ce que voit l'utilisateur.
    assert.ok(t.setup?.title && t.setup?.intro, `${t.id} : guide`);
    assert.ok(t.setup.sections.length > 0, `${t.id} : sections du guide`);
    for (const s of t.setup.sections) {
      assert.ok(s.heading && Array.isArray(s.steps) && s.steps.length, `${t.id} : étapes`);
    }
    // La capacité 'adb' implique de pouvoir afficher un état de connexion.
    if (t.capabilities.includes('volume')) {
      assert.ok(t.capabilities.includes('mute'), `${t.id} : volume sans mute`);
    }
  }
});

test('catalogue : chaque type déclaré a un pilote', () => {
  for (const t of CATALOG) assert.ok(driverExists(t.id), `${t.id} sans pilote`);
  assert.deepEqual(supportedTypes().sort(), CATALOG.map((t) => t.id).sort());
});

test('capacités et ports par défaut', () => {
  assert.ok(supports('androidtv', 'pairing'));
  assert.ok(supports('androidtv', 'volume'));
  assert.ok(supports('firetv', 'adb'));
  assert.ok(!supports('firetv', 'pairing'));     // Fire TV : pas de code PIN
  assert.equal(defaultPortOf('androidtv'), 5555);
  assert.equal(defaultPortOf('firetv'), 5555);
  assert.equal(getType('inconnu'), null);
});

test('probeMap : un port peut désigner plusieurs types', () => {
  const map = probeMap();
  assert.ok(map.get(5555).includes('firetv'));
  assert.ok(map.get(5555).includes('androidtv'));
  assert.deepEqual(map.get(6466), ['androidtv']);
});

test('guessType : déduction depuis les ports ouverts', () => {
  assert.deepEqual(guessType([6466]), { type: 'androidtv', port: 6466 });
  // Android TV avec débogage réseau : on préfère adb (vérité terrain audio)
  assert.deepEqual(guessType([6466, 5555]), { type: 'androidtv', port: 5555 });
  assert.deepEqual(guessType([5555]), { type: 'firetv', port: 5555 });
  assert.equal(guessType([80, 443]), null);
  assert.equal(guessType([8060]), null);   // hors périmètre Android
});

test('guessType : une référence AFT… force Fire TV', () => {
  // Une Fire TV qui exposerait aussi 6466 reste une Fire TV.
  assert.deepEqual(guessType([6466, 5555], 'AFTKA'), { type: 'firetv', port: 5555 });
  assert.deepEqual(guessType([5555], 'SHIELD Android TV'), { type: 'firetv', port: 5555 });
});

test('publicCatalog : expose les guides sans logique serveur', () => {
  const pub = publicCatalog();
  assert.equal(pub.length, CATALOG.length);
  for (const t of pub) {
    assert.ok(t.setup?.sections?.length);
    assert.ok(Array.isArray(t.capabilities));
    assert.equal(t.probePorts, undefined);   // détail d'implémentation non exposé
  }
});
