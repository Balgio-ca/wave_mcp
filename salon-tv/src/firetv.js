// Contrôleur Fire TV (Amazon) via ADB sur TCP.
//
// Pas de services Google : le protocole Android TV Remote v2 ne marche pas.
// Tout passe par adb (couche partagée sérialisée, voir adb.js).
//
// MUTE FIABLE — plus de bascule aveugle. Ordre de préférence :
//   1. 'volume' : contrôle ABSOLU du volume. Mute = mémoriser le niveau puis
//      écrire 0 ; unmute = restaurer. Écriture VÉRIFIÉE par relecture.
//   2. 'device' : mute lu dans dumpsys audio -> touche MUTE + relecture.
//   3. 'intent' : rien n'est lisible -> touche MUTE + suivi d'intention
//      persisté (resync manuel possible dans l'UI).
//
// Une instance par appareil du registre.

import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { KEYS, FIRETV_KEYCODE } from './keys.js';
import {
  withLock,
  adbUnlocked,
  recoverTarget,
  readVolume,
  writeVolume,
  forgetVolumeCmd,
  keyeventUnlocked,
  isAwakeUnlocked,
  readMuteUnlocked,
} from './adb.js';

const POLL_INTERVAL = 5000;
const OFFLINE_GRACE = 2;
const DEFAULT_UNMUTE_PCT = 0.4;

export class FireTVController {
  constructor(device) {
    this.device = device;
    this.mutePath = path.join(config.dataDir, `mute-${device.id}.json`);
    this.levelPath = path.join(config.dataDir, `level-${device.id}.json`);

    this.status = {
      online: false,
      awake: false,
      adb: 'inconnu',
      muted: false,
      muteSource: 'intent',
      volume: null,
    };
    this._loadMute();
    this._savedLevel = this._loadLevel();

    this.pollTimer = null;
    this._refreshing = false;
    this._failstreak = 0;
    this._gen = 0;
    this._stopped = false;
  }

  get id() { return this.device.id; }
  get target() { return `${this.device.host}:${this.device.port}`; }

  start() {
    this._refresh();
    this.pollTimer = setInterval(() => this._refresh(), POLL_INTERVAL);
  }

  stop() {
    this._stopped = true;
    this._gen++;
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    forgetVolumeCmd(this.target);
  }

  // ---- Persistance -----------------------------------------------------

  _loadMute() {
    try {
      this.status.muted = Boolean(JSON.parse(fs.readFileSync(this.mutePath, 'utf8'))?.muted);
    } catch {
      this.status.muted = false;
    }
  }

  _saveMute() {
    try {
      fs.mkdirSync(config.dataDir, { recursive: true });
      fs.writeFileSync(this.mutePath, JSON.stringify({ muted: this.status.muted }));
    } catch { /* best-effort */ }
  }

  _loadLevel() {
    try {
      const n = JSON.parse(fs.readFileSync(this.levelPath, 'utf8'))?.level;
      return Number.isInteger(n) && n > 0 ? n : null;
    } catch {
      return null;
    }
  }

  _saveLevel(level) {
    this._savedLevel = level;
    try {
      fs.mkdirSync(config.dataDir, { recursive: true });
      fs.writeFileSync(this.levelPath, JSON.stringify({ level }));
    } catch { /* best-effort */ }
  }

  // ---- État ------------------------------------------------------------

  _markOnline() {
    this._failstreak = 0;
    if (!this.status.online) console.log(`[${this.device.name}] en ligne`);
    this.status.online = true;
  }

  _markProblem() {
    this._failstreak++;
    if (this._failstreak >= OFFLINE_GRACE && this.status.online) {
      console.log(`[${this.device.name}] hors ligne`);
      this.status.online = false;
      this.status.awake = false;
      this.status.volume = null;
    }
  }

  async _applyAudioReading(vol) {
    if (vol) {
      this.status.muteSource = 'volume';
      this.status.volume = Math.round((vol.level / vol.max) * 100);
      const muted = vol.level === 0;
      if (this.status.muted !== muted) {
        this.status.muted = muted;
        this._saveMute();
      }
      if (vol.level > 0) this._saveLevel(vol.level);
      return;
    }
    this.status.volume = null;
    const real = await readMuteUnlocked(this.target);
    if (real !== null) {
      this.status.muteSource = 'device';
      if (this.status.muted !== real) {
        this.status.muted = real;
        this._saveMute();
      }
    } else {
      this.status.muteSource = 'intent';
    }
  }

  async _refresh() {
    if (this._refreshing || this._stopped) return;
    this._refreshing = true;
    const gen = this._gen;
    const target = this.target;
    try {
      await withLock(async () => {
        if (gen !== this._gen) return;
        const state = await recoverTarget(target);
        if (gen !== this._gen) return;
        this.status.adb = state;
        if (state === 'device') {
          this._markOnline();
          this.status.awake = await isAwakeUnlocked(target);
          await this._applyAudioReading(await readVolume(target));
        } else {
          this._markProblem();
        }
      });
    } finally {
      this._refreshing = false;
    }
  }

  // Reconnexion à la demande (bouton « Connecter »).
  async connectAdb() {
    const gen = this._gen;
    const target = this.target;
    return withLock(async () => {
      if (gen !== this._gen) return { adb: 'inconnu', online: false };
      await adbUnlocked(['disconnect', target]).catch(() => {});
      const state = await recoverTarget(target);
      if (gen !== this._gen) return { adb: 'inconnu', online: false };
      this.status.adb = state;
      if (state === 'device') {
        this._markOnline();
        this.status.awake = await isAwakeUnlocked(target);
        await this._applyAudioReading(await readVolume(target));
      } else {
        this._markProblem();
      }
      return { adb: state, online: this.status.online };
    });
  }

  // ---- Actions ---------------------------------------------------------

  async _keyWithRetry(code) {
    try {
      await keyeventUnlocked(this.target, code);
    } catch {
      await recoverTarget(this.target);
      await keyeventUnlocked(this.target, code);
    }
    this._markOnline();
  }

  async key(name) {
    if (name === 'mute') return this.setMuted(!this.status.muted);
    const code = KEYS[name]?.firetv;
    if (code == null) throw new Error(`Touche inconnue: ${name}`);
    return withLock(async () => {
      await this._keyWithRetry(code);
      if (name === 'power') setTimeout(() => this._refresh(), 1500);
    });
  }

  // Toute la séquence est atomique dans le verrou adb — pas de double bascule.
  async setMuted(desired) {
    const gen = this._gen;
    return withLock(async () => {
      if (gen !== this._gen) return;
      const target = this.target;

      // 1) Volume absolu (vérifié).
      const vol = await readVolume(target);
      if (vol) {
        if (vol.level > 0) this._saveLevel(vol.level);
        if ((vol.level === 0) === desired) {
          await this._applyAudioReading(vol);
          return;
        }
        const targetLevel = desired
          ? 0
          : (this._savedLevel && this._savedLevel <= vol.max
              ? this._savedLevel
              : Math.max(1, Math.round(vol.max * DEFAULT_UNMUTE_PCT)));
        const back = await writeVolume(target, targetLevel);
        if (back) {
          this._markOnline();
          await this._applyAudioReading(back);
          return;
        }
      }

      // 2) Touche MUTE + relecture dumpsys.
      const before = await readMuteUnlocked(target);
      if (before !== null && before === desired) {
        this.status.muteSource = 'device';
        if (this.status.muted !== desired) { this.status.muted = desired; this._saveMute(); }
        return;
      }
      await this._keyWithRetry(KEYS.mute.firetv);
      const after = await readMuteUnlocked(target);
      if (after !== null) {
        this.status.muteSource = 'device';
        if (after !== desired) {
          await this._keyWithRetry(KEYS.mute.firetv);
          const again = await readMuteUnlocked(target);
          this.status.muted = again === null ? desired : again;
        } else {
          this.status.muted = after;
        }
        this._saveMute();
        return;
      }

      // 3) Dernier recours : suivi d'intention.
      this.status.muteSource = 'intent';
      this.status.muted = desired;
      this._saveMute();
    });
  }

  async standby() {
    return withLock(async () => {
      await this._keyWithRetry(FIRETV_KEYCODE.SLEEP);
      this.status.awake = false;
    });
  }

  // Corrige l'intention de mute SANS actionner la TV (mode 'intent').
  setMuteIntent(muted) {
    this.status.muted = Boolean(muted);
    this._saveMute();
  }

  // Le Fire TV n'a pas de pairing PIN.
  sendPin() {
    throw new Error('Cet appareil ne demande pas de code PIN');
  }

  getState() {
    return { ...this.device, ...this.status, kind: 'firetv', paired: true, pairing: false, app: null };
  }
}
