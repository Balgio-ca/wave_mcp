// Gestionnaire de contrôleurs : une instance vivante par appareil du registre.
//
// Garde le registre (données) et les contrôleurs (connexions) synchronisés :
// ajout -> démarrage d'un contrôleur, suppression -> arrêt propre,
// modification -> recréation si l'adressage/type change, simple mise à jour
// de l'étiquette sinon.

import { DeviceRegistry } from './devices.js';
import { AndroidTVController } from './androidtv.js';
import { FireTVController } from './firetv.js';

function makeController(device) {
  return device.type === 'androidtv'
    ? new AndroidTVController(device)
    : new FireTVController(device);
}

export class DeviceManager {
  constructor() {
    this.registry = new DeviceRegistry();
    this.controllers = new Map(); // id -> contrôleur
  }

  start() {
    for (const device of this.registry.all()) this._spawn(device);
    const n = this.controllers.size;
    console.log(n ? `[deck] ${n} appareil(s) démarré(s).` : '[deck] Aucun appareil configuré — utilise le scan réseau.');
  }

  _spawn(device) {
    const controller = makeController(device);
    this.controllers.set(device.id, controller);
    controller.start();
    return controller;
  }

  _kill(id) {
    const c = this.controllers.get(id);
    if (c) {
      try { c.stop(); } catch { /* ignore */ }
      this.controllers.delete(id);
    }
  }

  get(id) {
    return this.controllers.get(id) || null;
  }

  // Contrôleurs d'une pièce, dans l'ordre du registre.
  inRoom(room) {
    return this.registry.all()
      .filter((d) => d.room === room)
      .map((d) => this.controllers.get(d.id))
      .filter(Boolean);
  }

  all() {
    return this.registry.all().map((d) => this.controllers.get(d.id)).filter(Boolean);
  }

  // ---- Mutations du registre (avec cycle de vie des contrôleurs) --------

  addDevice(input) {
    const device = this.registry.add(input);
    this._spawn(device);
    return device;
  }

  updateDevice(id, patch) {
    const before = this.registry.get(id);
    if (!before) throw new Error(`Appareil inconnu: ${id}`);
    const after = this.registry.update(id, patch);
    const readdressed =
      before.host !== after.host || before.port !== after.port || before.type !== after.type;
    if (readdressed) {
      this._kill(id);
      this._spawn(after);
    } else {
      // Même connexion : on met juste à jour l'étiquette/pièce en place.
      const c = this.controllers.get(id);
      if (c) c.device = after;
    }
    return after;
  }

  removeDevice(id) {
    const gone = this.registry.remove(id);
    this._kill(id);
    return gone;
  }

  renameRoom(from, to) {
    const n = this.registry.renameRoom(from, to);
    for (const device of this.registry.all()) {
      const c = this.controllers.get(device.id);
      if (c) c.device = device;
    }
    return n;
  }

  // ---- État agrégé -----------------------------------------------------

  devicesState() {
    return this.all().map((c) => c.getState());
  }

  roomsState() {
    const rooms = new Map();
    for (const state of this.devicesState()) {
      if (!rooms.has(state.room)) rooms.set(state.room, []);
      rooms.get(state.room).push(state);
    }
    return [...rooms.entries()].map(([name, devices]) => ({ name, devices }));
  }
}
