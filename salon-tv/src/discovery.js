// Découverte réseau des TV, sans dépendance externe.
//
// Principe : on balaye les /24 locaux en TCP.
//   - port 6466 ouvert  -> service Android TV Remote v2 (Shield / Android TV)
//   - port 5555 ouvert  -> adb TCP (Fire TV, ou Android TV avec adb activé)
//
// Le scan est borné (concurrence limitée, timeout court par hôte) : un /24
// complet prend quelques secondes. En mode network_mode: host sur le NAS, les
// interfaces locales donnent le bon sous-réseau ; on ajoute aussi les /24 des
// hôtes déjà configurés au cas où le serveur serait multi-réseaux.

import net from 'node:net';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { probeMap } from './catalog.js';

const PROBE_TIMEOUT = 450;   // ms par hôte/port
const CONCURRENCY = 64;      // sondes simultanées

export const SHIELD_PORT = 6466; // Android TV Remote v2
export const ADB_PORT = 5555;    // adb TCP

// /24 candidats : interfaces IPv4 locales + sous-réseaux des IP déjà connues
// (appareils enregistrés), au cas où l'hôte serait multi-réseaux.
export function candidateSubnets(knownHosts = []) {
  const bases = new Set();
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) {
        bases.add(i.address.split('.').slice(0, 3).join('.'));
      }
    }
  }
  for (const host of knownHosts) {
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(String(host))) {
      bases.add(String(host).split('.').slice(0, 3).join('.'));
    }
  }
  return [...bases];
}

// Sonde TCP : résout true si le port accepte la connexion.
function probe(host, port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(PROBE_TIMEOUT);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
  });
}

// Exécute des tâches avec une concurrence bornée.
async function pool(tasks, limit) {
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

// Essaie de nommer un appareil adb (best-effort, jamais bloquant).
function adbModel(target) {
  return new Promise((resolve) => {
    execFile('adb', ['connect', target], { timeout: 2500 }, () => {
      execFile(
        'adb',
        ['-s', target, 'shell', 'getprop', 'ro.product.model'],
        { timeout: 2500 },
        (err, stdout) => resolve(err ? null : String(stdout).trim() || null),
      );
    });
  });
}

// Déduit le type d'appareil à partir des ports ouverts (fonction pure, testée).
//   6466            -> Android TV (service Remote v2)
//   6466 + 5555     -> Android TV avec débogage réseau déjà actif
//   5555 seul       -> Fire TV (adb sans service Remote v2)
// `model` (via adb) affine : une référence « AFT… » est une signature Amazon.
export function guessType(openPorts, model = null) {
  const has = (p) => openPorts.includes(p);
  if (model && /^AFT/i.test(model)) return { type: 'firetv', port: ADB_PORT };
  if (has(SHIELD_PORT)) return { type: 'androidtv', port: has(ADB_PORT) ? ADB_PORT : SHIELD_PORT };
  if (has(ADB_PORT)) return { type: 'firetv', port: ADB_PORT };
  return null;
}

// Balaye les sous-réseaux sur TOUS les ports déclarés par le catalogue et
// devine le type de chaque appareil trouvé.
// Renvoie { subnets, candidates: [{ host, port, type, model, ports[] }] }.
export async function discover(knownHosts = []) {
  const subnets = candidateSubnets(knownHosts);
  const hosts = subnets.flatMap((base) =>
    Array.from({ length: 254 }, (_, i) => `${base}.${i + 1}`),
  );

  const ports = [...probeMap().keys()];
  const tasks = hosts.flatMap((host) =>
    ports.map((port) => async () => ((await probe(host, port)) ? { host, port } : null)),
  );
  const hits = (await pool(tasks, CONCURRENCY)).filter(Boolean);

  // Regroupe les ports ouverts par hôte.
  const byHost = new Map();
  for (const { host, port } of hits) {
    if (!byHost.has(host)) byHost.set(host, []);
    byHost.get(host).push(port);
  }

  // Étiquette avec le modèle quand adb est joignable (séquentiel : adb n'aime
  // pas le parallélisme, et il y a rarement plus de quelques candidats).
  const candidates = [];
  for (const [host, open] of byHost) {
    const model = open.includes(ADB_PORT)
      ? await adbModel(`${host}:${ADB_PORT}`).catch(() => null)
      : null;
    const guess = guessType(open, model);
    if (!guess) continue;
    candidates.push({ host, port: guess.port, type: guess.type, model, ports: open });
  }

  return { subnets, candidates };
}
