// Contrôleur Nvidia Shield.
//
// Deux canaux complémentaires :
//   1. Protocole Android TV Remote v2 (paquet androidtv-remote) : pairing PIN,
//      touches, power, app au premier plan, événements volume.
//      Événements : secret, ready, powered, volume, current_app, unpaired,
//      error — il n'y a PAS d'événement close.
//   2. Canal auxiliaire adb (port 5555, si « débogage réseau » est activé sur
//      le Shield) : VÉRITÉ TERRAIN pour volume/mute/éveil, et contrôle de
//      volume ABSOLU — la base du mute fiable.
//
// MUTE FIABLE — ordre de préférence (voir setMuted) :
//   'volume'  : niveau absolu écrit + vérifié par relecture via adb ;
//   'device'  : mute lu dans dumpsys audio + touche vérifiée ;
//   'events'  : boucle fermée sur les événements volume du protocole remote ;
//   'assumed' : bascule optimiste (dernier recours).
//
// Fiabilité connexion : générations (_gen) pour invalider toute continuation
// ou sonde d'une ancienne connexion/hôte ; l'instance AndroidRemote précédente
// est TOUJOURS stoppée avant d'en créer une nouvelle (sinon les anciennes
// sockets continuent d'émettre et corrompent l'état) ; reconnexion en backoff
// exponentiel, gardée contre l'empilement.

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
const ADB_PORT = 5555;
const EVENT_WAIT = 1200;        // attente d'un événement volume après une touche
const DEFAULT_UNMUTE_PCT = 0.4;

export class ShieldController {
  constructor() {
    this.certPath = path.join(config.dataDir, 'shield-cert.json');
    this.levelPath = path.join(config.dataDir, 'shield-level.json');

    this.remote = null;
    this.connecting = false;
    this.reconnectTimer = null;
    this.backoff = RECONNECT_MIN;
    this._started = false;
    this._gen = 0;              // invalide continuations/sondes obsolètes
    this._volumeWaiters = [];   // resolvers en attente d'un événement volume
    this._savedLevel = this._loadLevel();

    this.status = {
      configured: Boolean(config.shield.host),
      online: false,
      awake: false,
      paired: false,
      pairing: false,
      app: null,
      volume: null,             // pourcentage 0..100
      muted: false,
      // Canal auxiliaire adb : 'device' | 'unauthorized' | 'offline' |
      // 'absent' | 'inconnu' | 'off' (jamais tenté)
      adb: 'off',
      // Source de l'état de mute affiché/utilisé.
      muteSource: 'assumed',
    };
  }

  get adbTarget() {
    return `${config.shield.host}:${ADB_PORT}`;
  }

  start() {
    if (!this.status.configured) {
      console.warn('[shield] SHIELD_HOST non défini — contrôleur inactif.');
      return;
    }
    this._begin();
  }

  _begin() {
    if (this._started) return;
    this._started = true;
    this._loadCert();
    this.connect();
    setInterval(() => this._probe(), PROBE_INTERVAL);
  }

  // Change l'hôte à chaud (réglages / découverte réseau).
  setHost(host) {
    if (host === config.shield.host) return;
    console.log(`[shield] Nouvel hôte : ${host}`);
    this._gen++;
    forgetVolumeCmd(this.adbTarget);
    config.shield.host = host;
    this.status.configured = Boolean(host);
    this._clearReconnect();
    try { this.remote?.stop?.(); } catch { /* ignore */ }
    this.remote = null;
    this.connecting = false;
    this.backoff = RECONNECT_MIN;
    Object.assign(this.status, {
      online: false, awake: false, pairing: false,
      app: null, volume: null, adb: 'inconnu', muteSource: 'assumed',
    });
    if (!this.status.configured) return;
    if (!this._started) this._begin();
    else this._scheduleReconnect(0);
  }

  // ---- Persistance -----------------------------------------------------

  _loadCert() {
    try {
      this.cert = JSON.parse(fs.readFileSync(this.certPath, 'utf8'));
      this.status.paired = Boolean(this.cert?.key && this.cert?.cert);
      if (this.status.paired) console.log('[shield] Certificat chargé depuis', this.certPath);
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
      console.log('[shield] Certificat enregistré.');
    } catch (err) {
      console.error('[shield] Échec écriture certificat :', err.message);
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
    } catch (err) {
      console.error('[shield] Échec écriture niveau :', err.message);
    }
  }

  // ---- Connexion remote v2 --------------------------------------------

  async connect() {
    if (this.connecting) return;
    this.connecting = true;
    const gen = this._gen;
    this._clearReconnect();

    // Stoppe TOUJOURS l'instance précédente : ses sockets vivantes
    // continueraient d'émettre des événements et de corrompre l'état.
    try { this.remote?.stop?.(); } catch { /* ignore */ }

    const remote = new AndroidRemote(config.shield.host, {
      pairing_port: config.shield.pairingPort,
      remote_port: config.shield.remotePort,
      service_name: config.shield.serviceName,
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
      console.error('[shield] connect a échoué :', err?.message || err);
      this._scheduleReconnect();
    }
  }

  _wire(remote, gen) {
    const fresh = () => gen === this._gen && this.remote === remote;

    remote.on('secret', () => {
      if (!fresh()) return;
      this.status.pairing = true;
      console.log('[shield] En attente du code PIN…');
    });

    remote.on('ready', () => {
      if (!fresh()) return;
      this.status.pairing = false;
      this.status.online = true;
      this.backoff = RECONNECT_MIN;
      const cert = remote.getCertificate();
      if (cert?.key && cert?.cert) this._saveCert(cert);
      console.log('[shield] Prêt.');
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
      this._volumeEventTime = Date.now();
      // Réveille les attentes de boucle fermée.
      for (const resolve of this._volumeWaiters.splice(0)) resolve(v);
    });

    remote.on('current_app', (app) => {
      if (!fresh()) return;
      this.status.online = true;
      this.status.app = app || null;
    });

    remote.on('unpaired', () => {
      if (!fresh()) return;
      console.warn('[shield] Dé-pairé — suppression du certificat et re-pairing.');
      this._deleteCert();
      this.status.pairing = false;
      this._recreate();
    });

    remote.on('error', (err) => {
      console.error('[shield] error :', err?.message || err);
    });
  }

  _guardInternal(remote) {
    for (const mgr of [remote.remoteManager, remote.pairingManager]) {
      if (mgr && typeof mgr.on === 'function' && mgr.listenerCount('error') === 0) {
        mgr.on('error', (e) => console.error('[shield] (interne) error :', e?.error || e?.message || e));
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
    if (this.reconnectTimer || this.connecting) return;
    const wait = delay ?? this.backoff;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, wait);
    this.backoff = Math.min(this.backoff * 2, RECONNECT_MAX);
    if (wait > 0) console.log(`[shield] Reconnexion dans ${Math.round(wait / 1000)} s`);
  }

  _clearReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ---- Sondes ----------------------------------------------------------

  // Sonde TCP du port remote (présence) + relevé adb (vérité terrain audio).
  _probe() {
    if (!this.status.configured) return;
    const gen = this._gen;
    const host = config.shield.host;

    const sock = net.connect({ host, port: config.shield.remotePort });
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      sock.destroy();
      if (gen !== this._gen || host !== config.shield.host) return; // obsolète
      const was = this.status.online;
      this.status.online = ok;
      if (!ok) {
        this.status.awake = false;
        this.status.app = null;
        if (this.status.paired && !this.connecting) this._scheduleReconnect();
      }
      if (was !== ok) console.log(`[shield] ${ok ? 'en ligne' : 'hors ligne'}`);
    };
    sock.setTimeout(PROBE_TIMEOUT);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));

    this._sidecarPoll(gen);
  }

  // Relevé du canal adb : état + volume/mute/éveil réels.
  async _sidecarPoll(gen) {
    const target = this.adbTarget;
    await withLock(async () => {
      if (gen !== this._gen) return;
      const state = await recoverTarget(target);
      if (gen !== this._gen || target !== this.adbTarget) return;
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
    }).catch(() => { /* sonde best-effort */ });
  }

  // Reconnexion adb à la demande (bouton « Connecter » de l'UI).
  async connectSidecar() {
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
    if (this.status.pairing) throw new Error('Shield en attente de pairing');
    if (!this._ready()) throw new Error('Shield hors ligne');
  }

  sendPin(code) {
    if (!this.status.pairing || !this.remote?.pairingManager) {
      throw new Error('Aucun pairing en cours');
    }
    this.remote.sendCode(String(code));
  }

  // Attend un événement volume du protocole remote (boucle fermée).
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

  // Amène le mute à l'état voulu, par le canal le plus fiable disponible.
  async setMuted(desired) {
    // 1) Volume absolu via adb (écrit + vérifié) — la voie royale.
    if (this.status.adb === 'device') {
      const gen = this._gen;
      const handled = await withLock(async () => {
        if (gen !== this._gen) return true; // config changée : abandonne proprement
        const target = this.adbTarget;
        const vol = await readVolume(target);
        if (!vol) return false;
        if (vol.level > 0) this._saveLevel(vol.level);
        const isMuted = vol.level === 0;
        if (isMuted === desired) {
          this.status.muteSource = 'volume';
          this.status.volume = Math.round((vol.level / vol.max) * 100);
          this.status.muted = isMuted;
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

    // 2) Touche mute via le protocole remote, boucle fermée sur l'événement
    //    volume ; à défaut, bascule optimiste.
    this._assertReady();
    if (this.status.muted === desired) return;
    this.remote.sendKey(RemoteKeyCode[KEYS.mute.shield], RemoteDirection.SHORT);
    const evt = await this._awaitVolumeEvent(EVENT_WAIT);
    if (evt) {
      // L'événement a mis l'état à jour ; s'il n'a pas produit l'état voulu,
      // une seconde tentative unique.
      if (this.status.muted !== desired) {
        this.remote.sendKey(RemoteKeyCode[KEYS.mute.shield], RemoteDirection.SHORT);
        await this._awaitVolumeEvent(EVENT_WAIT);
      }
    } else {
      // Aucun retour : optimiste, corrigé par le prochain événement/sonde.
      this.status.muted = desired;
      if (this.status.muteSource === 'events') this.status.muteSource = 'assumed';
    }
  }

  // Éteint de façon idempotente : ne bascule l'alimentation que si allumé.
  standby() {
    this._assertReady();
    if (this.status.awake) this.remote.sendPower();
  }

  getState() {
    return { ...this.status };
  }
}
