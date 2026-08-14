// Tests unitaires des parsers purs (node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVolumeGet, parseMuteFromDumpsys } from '../src/adb.js';

test('parseVolumeGet : formats media/cmd media_session', () => {
  assert.deepEqual(parseVolumeGet('volume is 5 in range [0..15]'), { level: 5, min: 0, max: 15 });
  assert.deepEqual(parseVolumeGet('[stream 3] volume is 12 in range [0..25]'), { level: 12, min: 0, max: 25 });
  assert.deepEqual(parseVolumeGet('Volume is 0 in range [0..100]'), { level: 0, min: 0, max: 100 });
  assert.equal(parseVolumeGet('error: no audio service'), null);
  assert.equal(parseVolumeGet(''), null);
  assert.equal(parseVolumeGet('volume is 5 in range [5..5]'), null); // plage vide
});

test('parseMuteFromDumpsys : masque de bits Muted streams', () => {
  assert.equal(parseMuteFromDumpsys('Muted streams: 0x8'), true);  // bit 3 = MUSIC
  assert.equal(parseMuteFromDumpsys('Muted streams: 0x0'), false);
  assert.equal(parseMuteFromDumpsys('Muted streams: 8'), true);
  assert.equal(parseMuteFromDumpsys('Muted streams: 0'), false);
  assert.equal(parseMuteFromDumpsys('Muted streams: 0x4'), false); // autre flux
});

test('parseMuteFromDumpsys : bloc STREAM_MUSIC', () => {
  assert.equal(parseMuteFromDumpsys('- STREAM_MUSIC:\n   Muted: true\n   Max: 25'), true);
  assert.equal(parseMuteFromDumpsys('- STREAM_MUSIC:\n   Muted: false\n   Max: 25'), false);
  assert.equal(parseMuteFromDumpsys('- STREAM_MUSIC:\n   Mute count: 1'), true);
  assert.equal(parseMuteFromDumpsys('- STREAM_MUSIC:\n   Mute count: 0'), false);
});

test('parseMuteFromDumpsys : ne déborde pas sur le bloc suivant', () => {
  // RING muet avant MUSIC : la valeur de MUSIC doit gagner.
  assert.equal(
    parseMuteFromDumpsys('- STREAM_RING:\n   Muted: true\n- STREAM_MUSIC:\n   Muted: false\n'),
    false,
  );
  // MUSIC sans info, bloc suivant muet : indéterminé, PAS true.
  assert.equal(
    parseMuteFromDumpsys('- STREAM_MUSIC:\n   Max: 15\n- STREAM_ALARM:\n   Muted: true\n'),
    null,
  );
});

test('parseMuteFromDumpsys : rien d’exploitable -> null', () => {
  assert.equal(parseMuteFromDumpsys('no audio info'), null);
  assert.equal(parseMuteFromDumpsys(''), null);
});
