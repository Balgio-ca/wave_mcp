// Contrôleur Android TV / Google TV (Nvidia Shield, Chromecast Google TV…).
//
// Deux canaux complémentaires :
//   1. Protocole Android TV Remote v2 (paquet androidtv-remote) : pairing PIN,
//      touches, power, app au premier plan, événements volume.
//      Événements : secret, ready, powered, volume, current_app, unpaired,
//      error — il n'y a PAS d'événement close.
//   2. Canal auxiliaire adb (« débogage réseau ») : VÉRITÉ TERRAIN pour
//      volume/mute/éveil et contrôle de volume ABSOLU.
//
// MUTE FIABLE — ordre de préférence (voir setMuted) :
//   'volume'  : niveau absolu écrit + vérifié par relecture via adb ;
//   'device'  : mute lu dans dumpsys audio ;
//   'events'  : boucle fermée sur les événements volume du protocole remote ;
//   'assumed' : bascule optimiste (dernier recours).
//
// Une instance par appareil du registre. Les générations (_gen) invalident
// toute continuation/sonde d'une connexion périmée ; l'instance AndroidRemote
// précédente est TOUJOURS stoppée avant d'en créer une nouvelle.

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { AndroidRemote, RemoteKeyCode, RemoteDirection } from 'androidtv-remote';
import { config } from './config.js';
import { KEYS } from './keys.js';
import {
  withLock,
  recoverTarget,
  readVolume,
  writeVolume,
  forgetVolumeCmd,
  readMuteUnlocked,
  isAwakeUnlocked,
} from './adb.js';

const RECONNECT_MIN = 2000;
const RECONNECT_MAX = 60000;
const PROBE_INTERVAL = 5000;
const PROBE_TIMEOUT = 1500;
const PAIRING_PORT = 6467;
const REMOTE_PORT = 6466;
const EVENT_WAIT = 1200;
const DEFAULT_UNMUTE_PCT = 0.4;

export class AndroidTVController {
  constructor(device) {
    this.device = device;
    this.certPath = path.join(config.dataDir, `cert-${device.id}.json`);
    this.levelPath = path.join(config.dataDir, `level-${device.id}.json`);

    this.remote = null;
    this.connecting = false;
    this.reconnectTimer = null;
    this.probeTimer = null;
    this.backoff = RECONNECT_MIN;
    this._gen = 0;
    this._volumeWaiters = [];
    this._savedLevel = this._loadLevel();
    this._stopped = false;

    this.status = {
      online: false,
      awake: false,
      paired: false,
      pairing: false,
      app: null,
      volume: null,
      muted: false,
      adb: 'inconnu',
      muteSource: 'assumed',
    };
  }

  get id() { return this.device.id; }
  get adbTarget() { return `${this.device.host}:${this.device.port}`; }

  start() {
    this._loadCert();
    this.connect();
    this.probeTimer = setInterval(() => this._probe(), PROBE_INTERVAL);
  }

  // Arrêt complet (appareil supprimé ou reconfiguré).
  stop() {
    this._stopped = true;
    this._gen++;
    this._clearReconnect();
    if (this.probeTimer) { clearInterval(this.probeTimer); this.probeTimer = null; }
    try { this.remote?.stop?.(); } catch { /* ignore */ }
    this.remote = null;
    forgetVolumeCmd(this.adbTarget);
  }

  // ---- Persistance -----------------------------------------------------

  _loadCert() {
    try {
      this.cert = JSON.parse(fs.readFileSync(this.certPath, 'utf8'));
      this.status.paired = Boolean(this.cert?.key && this.cert?.cert);
      if (this.status.paired) console.log(`[${this.device.name}] Certificat chargé.`);
    } catch {
      this.cert = undefined;
      this.status.paired = false;
    }
  }

  _saveCert(cert) {
    try {
      fs.mkdirSync(config.dataDir, { recursive: true });
      fs.writeFileSync(this.certPath, JSON.stringify(cert), { mode: 0o600 });
      this.cert = cert;
      this.status.paired = true;
      console.log(`[${this.device.name}] Certificat enregistré.`);
    } catch (err) {
      console.error(`[${this.device.name}] Échec écriture certificat :`, err.message);
    }
  }

  _deleteCert() {
    try { fs.unlinkSync(this.certPath); } catch { /* déjà absent */ }
    this.cert = undefined;
    this.status.paired = false;
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

  // ---- Connexion remote v2 --------------------------------------------

  async connect() {
    if (this.connecting || this._stopped) return;
    this.connecting = true;
    const gen = this._gen;
    this._clearReconnect();

    // Stoppe TOUJOURS l'instance précédente : ses sockets vivantes
    // continueraient d'émettre et de corrompre l'état.
    try { this.remote?.stop?.(); } catch { /* ignore */ }

    const remote = new AndroidRemote(this.device.host, {
      pairing_port: PAIRING_PORT,
      remote_port: REMOTE_PORT,
      service_name: config.brandName || 'deck',
      cert: this.cert,
    });
    this.remote = remote;
    this._wire(remote, gen);

    try {
      const started = await remote.start();
      if (gen !== this._gen) { try { remote.stop(); } catch { /* ignore */ } return; }
      this._guardInternal(remote);
      this.connecting = false;
      if (!started) this._scheduleReconnect();
    } catch (err) {
      if (gen !== this._gen) return;
      this.connecting = false;
      console.error(`[${this.device.name}] connect a échoué :`, err?.message || err);
      this._scheduleReconnect();
    }
  }

  _wire(remote, gen) {
    const fresh = () => gen === this._gen && this.remote === remote;

    remote.on('secret', () => {
      if (!fresh()) return;
      this.status.pairing = true;
      console.log(`[${this.device.name}] En attente du code PIN…`);
    });

    remote.on('ready', () => {
      if (!fresh()) return;
      this.status.pairing = false;
      this.status.online = true;
      this.backoff = RECONNECT_MIN;
      const cert = remote.getCertificate();
      if (cert?.key && cert?.cert) this._saveCert(cert);
      console.log(`[${this.device.name}] Prêt.`);
    });

    remote.on('powered', (powered) => {
      if (!fresh()) return;
      this.status.online = true;
      this.status.awake = Boolean(powered);
    });

    remote.on('volume', (v) => {
      if (!fresh()) return;
      this.status.online = true;
      if (v && typeof v.maximum === 'number' && v.maximum > 0) {
        this.status.volume = Math.round((v.level / v.maximum) * 100);
        if (v.level > 0) this._saveLevel(v.level);
      }
      this.status.muted = Boolean(v?.muted);
      if (this.status.muteSource !== 'volume' && this.status.muteSource !== 'device') {
        this.status.muteSource = 'events';
      }
      for (const resolve of this._volumeWaiters.splice(0)) resolve(v);
    });

    remote.on('current_app', (app) => {
      if (!fresh()) return;
      this.status.online = true;
      this.status.app = app || null;
    });

    remote.on('unpaired', () => {
      if (!fresh()) return;
      console.warn(`[${this.device.name}] Dé-pairé — re-pairing.`);
      this._deleteCert();
      this.status.pairing = false;
      this._recreate();
    });

    remote.on('error', (err) => {
      console.error(`[${this.device.name}] error :`, err?.message || err);
    });
  }

  _guardInternal(remote) {
    for (const mgr of [remote.remoteManager, remote.pairingManager]) {
      if (mgr && typeof mgr.on === 'function' && mgr.listenerCount('error') === 0) {
        mgr.on('error', (e) => console.error(`[${this.device.name}] (interne) :`, e?.error || e?.message || e));
      }
    }
  }

  _recreate() {
    try { this.remote?.stop?.(); } catch { /* ignore */ }
    this.remote = null;
    this.connecting = false;
    this._scheduleReconnect(0);
  }

  _scheduleReconnect(delay) {
    if (this.reconnectTimer || this.connecting || this._stopped) return;
    const wait = delay ?? this.backoff;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, wait);
    this.backoff = Math.min(this.backoff * 2, RECONNECT_MAX);
  }

  _clearReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ---- Sondes ----------------------------------------------------------

  _probe() {
    if (this._stopped) return;
    const gen = this._gen;
    const sock = net.connect({ host: this.device.host, port: REMOTE_PORT });
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      sock.destroy();
      if (gen !== this._gen) return;
      const was = this.status.online;
      this.status.online = ok;
      if (!ok) {
        this.status.awake = false;
        this.status.app = null;
        if (this.status.paired && !this.connecting) this._scheduleReconnect();
      }
      if (was !== ok) console.log(`[${this.device.name}] ${ok ? 'en ligne' : 'hors ligne'}`);
    };
    sock.setTimeout(PROBE_TIMEOUT);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));

    this._sidecarPoll(gen);
  }

  // Canal adb : vérité terrain volume/mute/éveil (best-effort).
  async _sidecarPoll(gen) {
    const target = this.adbTarget;
    await withLock(async () => {
      if (gen !== this._gen) return;
      const state = await recoverTarget(target);
      if (gen !== this._gen) return;
      this.status.adb = state;
      if (state !== 'device') return;
      const vol = await readVolume(target);
      if (gen !== this._gen) return;
      if (vol) {
        this.status.muteSource = 'volume';
        this.status.volume = Math.round((vol.level / vol.max) * 100);
        this.status.muted = vol.level === 0;
        if (vol.level > 0) this._saveLevel(vol.level);
      } else {
        const real = await readMuteUnlocked(target);
        if (gen !== this._gen) return;
        if (real !== null) {
          this.status.muteSource = 'device';
          this.status.muted = real;
        }
      }
      this.status.awake = await isAwakeUnlocked(target);
      this.status.online = true;
    }).catch(() => { /* best-effort */ });
  }

  // Reconnexion adb à la demande (bouton « Connecter »).
  async connectAdb() {
    const gen = this._gen;
    const target = this.adbTarget;
    return withLock(async () => {
      if (gen !== this._gen) return { adb: 'inconnu' };
      const state = await recoverTarget(target);
      if (gen !== this._gen) return { adb: 'inconnu' };
      this.status.adb = state;
      return { adb: state };
    });
  }

  // ---- Actions ---------------------------------------------------------

  _ready() {
    return Boolean(this.remote && this.remote.remoteManager);
  }

  _assertReady() {
    if (this.status.pairing) throw new Error(`${this.device.name} en attente de pairing`);
    if (!this._ready()) throw new Error(`${this.device.name} hors ligne`);
  }

  sendPin(code) {
    if (!this.status.pairing || !this.remote?.pairingManager) {
      throw new Error('Aucun pairing en cours');
    }
    this.remote.sendCode(String(code));
  }

  _awaitVolumeEvent(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), ms);
      this._volumeWaiters.push((v) => { clearTimeout(timer); resolve(v); });
    });
  }

  key(name) {
    if (name === 'mute') return this.setMuted(!this.status.muted);
    this._assertReady();
    if (name === 'power') {
      this.remote.sendPower();
      return;
    }
    const codeName = KEYS[name]?.shield;
    if (!codeName) throw new Error(`Touche inconnue: ${name}`);
    this.remote.sendKey(RemoteKeyCode[codeName], RemoteDirection.SHORT);
  }

  async setMuted(desired) {
    // 1) Volume absolu via adb (écrit + vérifié).
    if (this.status.adb === 'device') {
      const gen = this._gen;
      const handled = await withLock(async () => {
        if (gen !== this._gen) return true;
        const target = this.adbTarget;
        const vol = await readVolume(target);
        if (!vol) return false;
        if (vol.level > 0) this._saveLevel(vol.level);
        if ((vol.level === 0) === desired) {
          this.status.muteSource = 'volume';
          this.status.volume = Math.round((vol.level / vol.max) * 100);
          this.status.muted = vol.level === 0;
          return true;
        }
        const targetLevel = desired
          ? 0
          : (this._savedLevel && this._savedLevel <= vol.max
              ? this._savedLevel
              : Math.max(1, Math.round(vol.max * DEFAULT_UNMUTE_PCT)));
        const back = await writeVolume(target, targetLevel);
        if (!back) return false;
        this.status.muteSource = 'volume';
        this.status.volume = Math.round((back.level / back.max) * 100);
        this.status.muted = back.level === 0;
        return true;
      }).catch(() => false);
      if (handled) return;
    }

    // 2) Touche mute + boucle fermée sur l'événement volume.
    this._assertReady();
    if (this.status.muted === desired) return;
    this.remote.sendKey(RemoteKeyCode[KEYS.mute.shield], RemoteDirection.SHORT);
    const evt = await this._awaitVolumeEvent(EVENT_WAIT);
    if (evt) {
      if (this.status.muted !== desired) {
        this.remote.sendKey(RemoteKeyCode[KEYS.mute.shield], RemoteDirection.SHORT);
        await this._awaitVolumeEvent(EVENT_WAIT);
      }
    } else {
      this.status.muted = desired;
      if (this.status.muteSource === 'events') this.status.muteSource = 'assumed';
    }
  }

  standby() {
    this._assertReady();
    if (this.status.awake) this.remote.sendPower();
  }

  // Pas de suivi d'intention manuel pour ce type (mute déjà rapporté).
  setMuteIntent(muted) {
    this.status.muted = Boolean(muted);
  }

  getState() {
    return { ...this.device, ...this.status, kind: 'androidtv' };
  }
}
