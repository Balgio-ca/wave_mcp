// Contrôleur TCL Fire TV via ADB sur TCP (port 5555).
//
// La Fire TV n'a pas les services Google : le protocole Shield ne marche pas.
// Tout passe par adb (couche partagée sérialisée, voir adb.js).
//
// MUTE FIABLE — plus de bascule aveugle. Ordre de préférence :
//   1. 'volume' : contrôle ABSOLU du volume (`media volume --set`). Mute =
//      mémoriser le niveau puis écrire 0 ; unmute = restaurer. Écriture
//      VÉRIFIÉE par relecture. L'état affiché est l'état réel, relu à chaque
//      sonde — la télécommande physique ne peut plus désynchroniser l'app.
//   2. 'device' : la TV n'accepte pas les commandes volume mais expose son
//      mute dans dumpsys audio -> touche MUTE + relecture.
//   3. 'intent' : rien n'est lisible -> touche MUTE + suivi d'intention
//      persisté (dernier recours, resync manuel possible dans l'UI).

import fs from 'node:fs';
import path from 'node:path';
import { config, firetvTarget } from './config.js';
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
const OFFLINE_GRACE = 2;      // sondes ratées consécutives avant « hors ligne »
const DEFAULT_UNMUTE_PCT = 0.4; // niveau restauré si aucun niveau mémorisé

export class FireTVController {
  constructor() {
    this.target = firetvTarget();
    this.mutePath = path.join(config.dataDir, 'firetv-mute.json');
    this.levelPath = path.join(config.dataDir, 'firetv-level.json');

    this.status = {
      configured: Boolean(config.firetv.host),
      online: false,
      awake: false,
      // 'device' | 'offline' | 'unauthorized' | 'absent' | 'inconnu'
      adb: 'inconnu',
      muted: false,
      // 'volume' (absolu, vérifié) | 'device' (dumpsys) | 'intent' (suivi)
      muteSource: 'intent',
      volume: null,   // pourcentage 0..100, si lisible
    };
    this._loadMute();
    this._savedLevel = this._loadLevel();

    this._started = false;
    this._refreshing = false;
    this._failstreak = 0;
    this._gen = 0; // générations : invalide les résultats d'une ancienne cible
  }

  start() {
    if (!this.status.configured) {
      console.warn('[firetv] FIRETV_HOST non défini — contrôleur inactif.');
      return;
    }
    this._begin();
  }

  _begin() {
    if (this._started) return;
    this._started = true;
    this._refresh();
    setInterval(() => this._refresh(), POLL_INTERVAL);
  }

  // Change la cible à chaud (réglages / découverte réseau).
  setTarget(host, port) {
    const target = `${host}:${port}`;
    if (target === this.target) return;
    console.log(`[firetv] Nouvelle cible : ${target}`);
    this._gen++;
    forgetVolumeCmd(this.target);
    config.firetv.host = host;
    config.firetv.port = port;
    this.target = target;
    this.status.configured = Boolean(host);
    this.status.online = false;
    this.status.awake = false;
    this.status.adb = 'inconnu';
    this.status.volume = null;
    this._failstreak = 0;
    if (!this.status.configured) return;
    if (!this._started) this._begin();
    else this._refresh();
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
    } catch (err) {
      console.error('[firetv] Échec écriture intent mute :', err.message);
    }
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
    } catch (err) {
      console.error('[firetv] Échec écriture niveau :', err.message);
    }
  }

  // ---- État ------------------------------------------------------------

  _markOnline() {
    this._failstreak = 0;
    if (!this.status.online) console.log('[firetv] en ligne');
    this.status.online = true;
  }

  _markProblem() {
    this._failstreak++;
    if (this._failstreak >= OFFLINE_GRACE && this.status.online) {
      console.log('[firetv] hors ligne');
      this.status.online = false;
      this.status.awake = false;
      this.status.volume = null;
    }
  }

  // Applique volume/mute depuis une lecture réelle { level, max } (ou null).
  async _applyAudioReading(vol) {
    if (vol) {
      this.status.muteSource = 'volume';
      this.status.volume = Math.round((vol.level / vol.max) * 100);
      const muted = vol.level === 0;
      if (this.status.muted !== muted) {
        this.status.muted = muted;
        this._saveMute();
      }
      // Mémorise le dernier niveau audible pour la restauration.
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

  // Sonde périodique : présence, éveil, audio réel. Atomique et anti-pileup.
  async _refresh() {
    if (this._refreshing) return;
    this._refreshing = true;
    const gen = this._gen;
    const target = this.target;
    try {
      await withLock(async () => {
        if (gen !== this._gen) return; // cible changée entre-temps
        const state = await recoverTarget(target);
        if (gen !== this._gen) return; // résultat d'une ancienne cible : ignorer
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

  // Reconnexion à la demande (bouton « Connecter » de l'UI).
  async connect() {
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

  // Touche avec récupération : reconnexion + un réessai si échec.
  async _keyWithRetry(code) {
    try {
      await keyeventUnlocked(this.target, code);
    } catch {
      await recoverTarget(this.target);
      await keyeventUnlocked(this.target, code);
    }
    this._markOnline(); // touche acceptée -> présence prouvée
  }

  async key(name) {
    if (name === 'mute') {
      // Toute bascule de mute passe par le chemin fiable unique.
      return this.setMuted(!this.status.muted);
    }
    const code = KEYS[name]?.firetv;
    if (code == null) throw new Error(`Touche inconnue: ${name}`);
    return withLock(async () => {
      await this._keyWithRetry(code);
      if (name === 'power') {
        // L'état d'éveil vient de basculer : ne pas le deviner, re-sonder vite.
        setTimeout(() => this._refresh(), 1500);
      }
    });
  }

  async toggleMute() {
    return this.setMuted(!this.status.muted);
  }

  // Amène le mute à l'état voulu. TOUTE la séquence (lecture de l'état réel,
  // décision, écriture, vérification) est atomique dans le verrou adb —
  // pas de fenêtre pour une double bascule.
  async setMuted(desired) {
    const gen = this._gen;
    return withLock(async () => {
      if (gen !== this._gen) return;
      const target = this.target;

      // 1) Chemin volume absolu (vérifié par relecture).
      const vol = await readVolume(target);
      if (vol) {
        const isMuted = vol.level === 0;
        if (vol.level > 0) this._saveLevel(vol.level);
        if (isMuted === desired) {
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
        // Écriture non prise : on retombe sur la touche.
      }

      // 2) Chemin touche MUTE + relecture dumpsys si possible.
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
          // La bascule n'a pas produit l'état voulu : une seconde tentative.
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

  // Endormissement idempotent (KEYCODE_SLEEP ne rallume jamais).
  async standby() {
    return withLock(async () => {
      await this._keyWithRetry(FIRETV_KEYCODE.SLEEP);
      this.status.awake = false;
    });
  }

  // Corrige l'intention de mute SANS actionner la TV (mode 'intent' seulement).
  setMuteIntent(muted) {
    this.status.muted = Boolean(muted);
    this._saveMute();
  }

  getState() {
    return { ...this.status };
  }
}
