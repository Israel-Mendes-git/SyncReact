// SyncReact — service worker.
// Guarda em qual sala cada aba está e repassa as mensagens da sala por um transporte:
//   - "servidor": um WebSocket por aba até o Worker da Cloudflare (server/), que também dá a hora
//     de referência para os relógios dos PCs baterem;
//   - "local": entre abas do mesmo navegador, sem rede (testes; servidor = "local").

'use strict';

// Endereço do Worker publicado: vem de src/config.js (fora do git; modelo em src/config.example.js).
// Sem ele, a extensão começa no modo local. Também dá para trocar no popup (Ajustes → Servidor).
try {
  importScripts('config.js');
} catch (_) {}
const DEFAULT_SERVER = self.SYNCREACT_SERVER || '';

const ports = new Map();      // tabId -> Port do content script
const lastStatus = new Map(); // tabId -> último status enviado pela aba
let members = {};             // tabId -> { room, peerId, server, followingTo }  (storage.session)

const ready = chrome.storage.session.get('members').then((d) => {
  members = d.members || {};
});

function saveMembers() {
  return chrome.storage.session.set({ members });
}

async function serverSetting() {
  const { server } = await chrome.storage.local.get('server');
  const s = (server || DEFAULT_SERVER || '').trim();
  return s || 'local';
}

function toPort(tabId, msg) {
  const port = ports.get(tabId);
  if (port) {
    try { port.postMessage(msg); } catch (_) {}
  }
}

function deliver(tabId, msg) {
  toPort(tabId, { type: 'room', msg });
}

// ---------------------------------------------------------------------------
// Transporte local: entrega para as outras abas da mesma sala neste navegador.
// ---------------------------------------------------------------------------
function localSend(tabId, msg) {
  const me = members[tabId];
  for (const [tid, m] of Object.entries(members)) {
    const other = Number(tid);
    if (other !== tabId && m.server === 'local' && m.room === me.room) deliver(other, msg);
  }
}

// ---------------------------------------------------------------------------
// Transporte de rede: um WebSocket por aba, com reconexão e acerto de relógio.
// ---------------------------------------------------------------------------
const sockets = new Map(); // tabId -> conexão

function socketUrl(m) {
  let base = m.server.replace(/\/+$/, '');
  if (!/^wss?:\/\//.test(base)) base = base.replace(/^http/, 'ws');
  if (!/^wss?:\/\//.test(base)) base = 'wss://' + base;
  return `${base}/room/${encodeURIComponent(m.room)}?peer=${encodeURIComponent(m.peerId)}`;
}

function netJoin(tabId, m) {
  netLeave(tabId);
  const conn = { m, ws: null, status: 'connecting', retry: 0, closed: false, samples: [], offset: 0, rtt: null, timers: [] };
  sockets.set(tabId, conn);
  netOpen(tabId, conn);
}

function netOpen(tabId, conn) {
  if (conn.closed) return;
  conn.status = 'connecting';
  netNotify(tabId, conn);
  let ws;
  try {
    ws = new WebSocket(socketUrl(conn.m));
  } catch (_) {
    conn.status = 'error';
    netNotify(tabId, conn);
    return;
  }
  conn.ws = ws;
  ws.onopen = () => {
    conn.retry = 0;
    // só avisa a aba que conectou depois do primeiro pong: antes disso o relógio ainda não está
    // acertado, e um comando dado nesse instante sairia com a hora errada
    burst(conn);
    conn.timers.push(setTimeout(() => markOpen(tabId, conn), 2000));
  };
  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch (_) { return; }
    if (msg.type === '_pong') onPong(tabId, conn, msg);
    else deliver(tabId, msg);
  };
  ws.onclose = (e) => {
    if (conn.ws !== ws) return;
    if (e.code === 4001) {
      // sala cheia: tentar de novo não adianta
      conn.status = 'full';
      netNotify(tabId, conn);
      return;
    }
    conn.status = 'closed';
    netNotify(tabId, conn);
    if (conn.closed) return;
    const delay = Math.min(10000, 500 * 2 ** conn.retry++);
    conn.timers.push(setTimeout(() => netOpen(tabId, conn), delay));
  };
  ws.onerror = () => {};
}

function markOpen(tabId, conn) {
  if (conn.status === 'open' || !conn.ws || conn.ws.readyState !== 1) return;
  conn.status = 'open';
  toPort(tabId, { type: 'clock', offset: conn.offset });
  netNotify(tabId, conn);
}

// rajada de pings para acertar o relógio logo; depois um a cada 10 s
function burst(conn) {
  for (let i = 0; i < 6; i++) conn.timers.push(setTimeout(() => ping(conn), i * 150));
}

function ping(conn) {
  if (conn.ws && conn.ws.readyState === 1) conn.ws.send(JSON.stringify({ type: '_ping', t0: Date.now() }));
}

function onPong(tabId, conn, msg) {
  const t1 = Date.now();
  const rtt = t1 - msg.t0;
  if (rtt < 0 || rtt > 10000) return;
  // hora do servidor no meio da ida e volta; fica a amostra de menor atraso (a mais confiável)
  conn.samples.push({ rtt, offset: msg.server - (msg.t0 + t1) / 2 });
  if (conn.samples.length > 12) conn.samples.shift();
  const best = conn.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
  conn.rtt = rtt;
  if (Math.abs(best.offset - conn.offset) >= 2 || conn.samples.length === 1) {
    conn.offset = Math.round(best.offset);
    toPort(tabId, { type: 'clock', offset: conn.offset });
  }
  markOpen(tabId, conn);
}

// O Windows acerta o relógio de vez em quando, e a hora do PC dá um salto. As medições antigas
// passam a estar erradas: descarta e mede de novo (a hora monotônica não salta).
let wallMinusMono = Date.now() - performance.now();
setInterval(() => {
  const d = Date.now() - performance.now();
  if (Math.abs(d - wallMinusMono) > 150) {
    for (const conn of sockets.values()) {
      conn.samples = [];
      burst(conn);
    }
  }
  wallMinusMono = d;
}, 1000);

function netNotify(tabId, conn) {
  toPort(tabId, { type: 'net', status: conn.status });
}

function netSend(tabId, msg) {
  const conn = sockets.get(tabId);
  if (conn && conn.ws && conn.ws.readyState === 1) conn.ws.send(JSON.stringify(msg));
}

function netLeave(tabId) {
  const conn = sockets.get(tabId);
  if (!conn) return;
  conn.closed = true;
  for (const t of conn.timers) clearTimeout(t);
  try { conn.ws && conn.ws.close(1000, 'saiu'); } catch (_) {}
  sockets.delete(tabId);
}

// pings periódicos (também mantêm o service worker acordado enquanto houver sala)
setInterval(() => {
  for (const conn of sockets.values()) ping(conn);
}, 10000);

// ---------------------------------------------------------------------------
// Sala
// ---------------------------------------------------------------------------
function send(tabId, msg) {
  const m = members[tabId];
  if (!m) return;
  if (m.server === 'local') localSend(tabId, msg);
  else netSend(tabId, msg);
}

function ensureTransport(tabId) {
  const m = members[tabId];
  if (!m || m.server === 'local') return;
  if (!sockets.has(tabId)) netJoin(tabId, m);
}

function sendMembership(tabId, justJoined = false) {
  const m = members[tabId] || null;
  toPort(tabId, {
    type: 'membership',
    member: m && { room: m.room, peerId: m.peerId },
    followingTo: m ? m.followingTo || null : null,
    justJoined,
    transport: m ? (m.server === 'local' ? 'local' : 'servidor') : null,
  });
  const conn = sockets.get(tabId);
  toPort(tabId, { type: 'clock', offset: conn ? conn.offset : 0 });
  if (conn) netNotify(tabId, conn);
}

function randomId(len) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  for (const b of bytes) out += chars[b % chars.length];
  return out;
}

async function join(tabId, room) {
  await ready;
  if (members[tabId]) await leave(tabId);
  members[tabId] = { room, peerId: randomId(8), server: await serverSetting() };
  await saveMembers();
  ensureTransport(tabId);
  sendMembership(tabId, true);
}

async function leave(tabId) {
  await ready;
  const m = members[tabId];
  if (!m) return;
  send(tabId, { type: 'bye', from: m.peerId });
  netLeave(tabId);
  delete members[tabId];
  lastStatus.delete(tabId);
  await saveMembers();
  sendMembership(tabId);
}

// O service worker pode ter sido reiniciado pelo navegador: reabre as conexões das salas.
ready.then(async () => {
  for (const tid of Object.keys(members)) {
    const tabId = Number(tid);
    try {
      await chrome.tabs.get(tabId);
      ensureTransport(tabId);
    } catch (_) {
      delete members[tid];
    }
  }
  saveMembers();
});

// ---------------------------------------------------------------------------
// Content scripts
// ---------------------------------------------------------------------------
chrome.runtime.onConnect.addListener(async (port) => {
  if (port.name !== 'syncreact') return;
  await ready;
  const tabId = port.sender && port.sender.tab && port.sender.tab.id;
  if (tabId == null || port.sender.frameId !== 0) {
    port.disconnect();
    return;
  }
  ports.set(tabId, port);
  port.onMessage.addListener((msg) => {
    if (msg.type === 'room') {
      send(tabId, msg.msg);
    } else if (msg.type === 'status') {
      lastStatus.set(tabId, msg.status);
    } else if (msg.type === 'following' && members[tabId]) {
      members[tabId].followingTo = msg.videoId;
      saveMembers();
    }
  });
  port.onDisconnect.addListener(() => {
    if (ports.get(tabId) === port) ports.delete(tabId);
  });
  ensureTransport(tabId);
  sendMembership(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  leave(tabId);
});

// ---------------------------------------------------------------------------
// Popup
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((req, _sender, reply) => {
  (async () => {
    await ready;
    const tabId = req.tabId;
    switch (req.cmd) {
      case 'status': {
        const m = members[tabId] || null;
        const conn = sockets.get(tabId);
        return {
          member: m,
          status: lastStatus.get(tabId) || null,
          connected: ports.has(tabId),
          server: await serverSetting(),
          defaultServer: DEFAULT_SERVER,
          net: conn ? { status: conn.status, rtt: conn.rtt, offset: conn.offset } : null,
        };
      }
      case 'create': {
        const room = randomId(6);
        await join(tabId, room);
        return { ok: true, room };
      }
      case 'join':
        await join(tabId, String(req.room || '').trim().toUpperCase());
        return { ok: true };
      case 'leave':
        await leave(tabId);
        return { ok: true };
      case 'countdown':
        toPort(tabId, { type: 'command', cmd: 'countdown' });
        return { ok: ports.has(tabId) };
      default:
        return { ok: false };
    }
  })().then(reply);
  return true;
});

// Expostos para os testes automatizados (tools/test-sync.mjs).
self.syncreact = {
  join,
  leave,
  members: () => members,
  status: () => Object.fromEntries(lastStatus),
  net: () => Object.fromEntries([...sockets].map(([k, c]) => [k, { status: c.status, rtt: c.rtt, offset: c.offset }])),
  countdown: (tabId) => toPort(tabId, { type: 'command', cmd: 'countdown' }),
  dropSocket: (tabId) => {
    const c = sockets.get(tabId);
    if (c && c.ws) c.ws.close(4000, 'teste');
  },
};
