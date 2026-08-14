// Couche adb partagée et SÉRIALISÉE.
//
// Tout accès adb de l'application passe par ce module : la Fire TV, le canal
// auxiliaire du Shield et la découverte réseau. Une seule commande adb à la
// fois (la connexion TCP adb des TV décroche quand on la frappe en parallèle),
// et des opérations composées atomiques via withLock().
//
// Fournit aussi le contrôle de volume ABSOLU (`cmd media_session volume` ou
// `media volume` selon le build Android/Fire OS) : c'est la base du mute
// fiable — plus aucune bascule aveugle, on lit et on écrit des niveaux.

import { execFile } from 'node:child_process';

const ADB_TIMEOUT = 6000;

// ---- File d'attente globale -------------------------------------------

let chain = Promise.resolve();

// Sérialise une opération (simple ou composée). Renvoie le résultat réel.
export function withLock(fn) {
  const result = chain.then(fn, fn);
  chain = result.then(() => {}, () => {});
  return result;
}

// execFile brut, sans passer par la file (réservé à l'intérieur de withLock).
function execAdb(args, { timeout = ADB_TIMEOUT } = {}) {
  return new Promise((resolve, reject) => {
    execFile('adb', args, { timeout }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || err.message || '').trim();
        const e = new Error(
          err.code === 'ENOENT' ? "adb non installé sur l'hôte" : msg || 'échec adb',
        );
        e.code = err.code;
        return reject(e);
      }
      resolve(String(stdout).trim());
    });
  });
}

// Commande adb sérialisée (usage simple hors withLock).
export function adb(args, opts) {
  return withLock(() => execAdb(args, opts));
}

// Variante interne : à utiliser UNIQUEMENT depuis une fonction déjà dans
// withLock, pour composer plusieurs commandes atomiquement.
export const adbUnlocked = execAdb;

// ---- Connexion / état --------------------------------------------------

// Lit l'état d'une cible dans `adb devices` : device/offline/unauthorized.
export async function deviceState(target) {
  try {
    const out = await execAdb(['devices']);
    for (const line of out.split('\n')) {
      const [addr, st] = line.trim().split(/\s+/);
      if (addr === target) return st || 'offline';
    }
    return 'offline'; // pas listé
  } catch (e) {
    if (e.code === 'ENOENT') return 'absent';
    return 'inconnu';
  }
}

// connect, puis si l'état n'est pas 'device', reset (disconnect+connect) —
// un simple `adb connect` ne récupère PAS une connexion « offline ».
// À appeler DANS withLock. Renvoie l'état final.
export async function recoverTarget(target) {
  let connectErr = null;
  await execAdb(['connect', target]).catch((e) => { connectErr = e; });
  if (connectErr && connectErr.code === 'ENOENT') return 'absent';

  let state = await deviceState(target);
  if (state !== 'device' && state !== 'absent') {
    await execAdb(['disconnect', target]).catch(() => {});
    await execAdb(['connect', target]).catch(() => {});
    state = await deviceState(target);
  }
  return state;
}

// ---- Parsers purs (exportés pour les tests) ----------------------------

// Parse la sortie de `media volume --get` / `cmd media_session volume --get` :
//   "volume is 5 in range [0..15]"
export function parseVolumeGet(out) {
  const m = String(out).match(/volume\s+is\s+(\d+)\s+in\s+range\s+\[(\d+)\.\.(\d+)\]/i);
  if (!m) return null;
  const level = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const max = parseInt(m[3], 10);
  if (Number.isNaN(level) || Number.isNaN(max) || max <= min) return null;
  return { level, min, max };
}

// Parse le mute réel du flux musique dans `dumpsys audio`.
// true/false si signal net, sinon null (indéterminé — jamais de faux positif).
export function parseMuteFromDumpsys(dump) {
  let m = String(dump).match(/Muted\s+streams:\s*(0x[0-9a-fA-F]+|\d+)/i);
  if (m) {
    const mask = m[1].toLowerCase().startsWith('0x') ? parseInt(m[1], 16) : parseInt(m[1], 10);
    if (!Number.isNaN(mask)) return Boolean(mask & (1 << 3)); // bit 3 = STREAM_MUSIC
  }
  // Le (?!STREAM_) empêche la fenêtre de déborder sur le bloc du flux suivant.
  m = String(dump).match(/STREAM_MUSIC(?:(?!STREAM_)[\s\S]){0,400}?Muted:\s*(true|false)/i);
  if (m) return m[1].toLowerCase() === 'true';
  m = String(dump).match(/STREAM_MUSIC(?:(?!STREAM_)[\s\S]){0,400}?Mute\s*count:\s*(\d+)/i);
  if (m) return parseInt(m[1], 10) > 0;
  return null;
}

// ---- Volume absolu ------------------------------------------------------

// Mémorise, par cible, quelle commande volume fonctionne ('cmd' | 'media' |
// 'none') pour ne pas re-sonder à chaque appel.
const volCmdCache = new Map();

const VOL_CMDS = {
  cmd: {
    get: ['shell', 'cmd', 'media_session', 'volume', '--stream', '3', '--get'],
    set: (n) => ['shell', 'cmd', 'media_session', 'volume', '--stream', '3', '--set', String(n)],
  },
  media: {
    get: ['shell', 'media', 'volume', '--stream', '3', '--get'],
    set: (n) => ['shell', 'media', 'volume', '--stream', '3', '--set', String(n)],
  },
};

// Lit le volume absolu du flux musique. À appeler DANS withLock.
// Renvoie { level, min, max } ou null si aucune commande ne marche.
export async function readVolume(target) {
  const cached = volCmdCache.get(target);
  const order = cached && cached !== 'none' ? [cached] : ['cmd', 'media'];
  if (cached === 'none') return null;
  for (const kind of order) {
    try {
      const out = await adbUnlocked(['-s', target, ...VOL_CMDS[kind].get], { timeout: 4000 });
      const vol = parseVolumeGet(out);
      if (vol) {
        volCmdCache.set(target, kind);
        return vol;
      }
    } catch { /* essaie la suivante */ }
  }
  if (!cached) volCmdCache.set(target, 'none');
  return null;
}

// Écrit le volume absolu puis VÉRIFIE par relecture. À appeler DANS withLock.
// Renvoie le volume relu ({level,...}) si la commande a pris, sinon null.
export async function writeVolume(target, level) {
  const kind = volCmdCache.get(target);
  const kinds = kind && kind !== 'none' ? [kind] : ['cmd', 'media'];
  if (kind === 'none') return null;
  for (const k of kinds) {
    try {
      await adbUnlocked(['-s', target, ...VOL_CMDS[k].set(level)], { timeout: 4000 });
      const back = await adbUnlocked(['-s', target, ...VOL_CMDS[k].get], { timeout: 4000 });
      const vol = parseVolumeGet(back);
      if (vol && vol.level === level) {
        volCmdCache.set(target, k);
        return vol;
      }
    } catch { /* essaie la suivante */ }
  }
  return null;
}

// Oublie la capacité mémorisée (changement de cible / reconnexion).
export function forgetVolumeCmd(target) {
  volCmdCache.delete(target);
}

// ---- Divers -------------------------------------------------------------

// Touche par keyevent. À appeler DANS withLock.
export async function keyeventUnlocked(target, code) {
  await adbUnlocked(['-s', target, 'shell', 'input', 'keyevent', String(code)]);
}

// Éveillé ? via dumpsys power. À appeler DANS withLock.
export async function isAwakeUnlocked(target) {
  try {
    const out = await adbUnlocked(['-s', target, 'shell', 'dumpsys', 'power'], { timeout: 4000 });
    if (/mWakefulness=Awake/i.test(out)) return true;
    if (/Display Power:\s*state=ON/i.test(out)) return true;
    return false;
  } catch {
    return false;
  }
}

// Mute réel via dumpsys audio. À appeler DANS withLock.
export async function readMuteUnlocked(target) {
  try {
    const dump = await adbUnlocked(['-s', target, 'shell', 'dumpsys', 'audio'], { timeout: 4000 });
    return parseMuteFromDumpsys(dump);
  } catch {
    return null;
  }
}
