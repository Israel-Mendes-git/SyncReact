// SyncReact — service worker.
// Guarda em qual sala cada aba está e repassa as mensagens da sala pelo transporte.
// O transporte é trocável: hoje só existe o "local" (abas do mesmo navegador),
// usado para testar a sincronia antes de escolher o servidor.

'use strict';

const ports = new Map();      // tabId -> Port do content script
const lastStatus = new Map(); // tabId -> último status enviado pela aba
let members = {};             // tabId -> { room, peerId }   (persistido em storage.session)

const ready = chrome.storage.session.get('members').then((d) => {
  members = d.members || {};
});

function saveMembers() {
  return chrome.storage.session.set({ members });
}

// ---------------------------------------------------------------------------
// Transporte local: entrega a mensagem para as outras abas da mesma sala.
// Um transporte de rede precisa expor a mesma interface:
//   send(tabId, msg), join(tabId, room, peerId), leave(tabId), clockOffset()
// e chamar deliver(tabId, msg) quando chegar mensagem para a aba.
// ---------------------------------------------------------------------------
function createLocalTransport(deliver) {
  return {
    name: 'local',
    clockOffset: () => 0, // mesmo PC, mesmo relógio
    join() {},
    leave() {},
    send(tabId, msg) {
      const me = members[tabId];
      if (!me) return;
      for (const [tid, m] of Object.entries(members)) {
        const other = Number(tid);
        if (other !== tabId && m.room === me.room) deliver(other, msg);
      }
    },
  };
}

const transport = createLocalTransport((tabId, msg) => {
  const port = ports.get(tabId);
  if (port) port.postMessage({ type: 'room', msg });
});

function sendMembership(tabId, justJoined = false) {
  const port = ports.get(tabId);
  if (!port) return;
  const m = members[tabId] || null;
  port.postMessage({
    type: 'membership',
    member: m && { room: m.room, peerId: m.peerId },
    followingTo: m ? m.followingTo || null : null,
    justJoined,
    transport: transport.name,
  });
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
  members[tabId] = { room, peerId: randomId(8) };
  await saveMembers();
  transport.join(tabId, room, members[tabId].peerId);
  sendMembership(tabId, true);
}

async function leave(tabId) {
  await ready;
  const m = members[tabId];
  if (!m) return;
  transport.send(tabId, { type: 'bye', from: m.peerId });
  transport.leave(tabId);
  delete members[tabId];
  lastStatus.delete(tabId);
  await saveMembers();
  sendMembership(tabId);
}

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
      if (members[tabId]) transport.send(tabId, msg.msg);
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
  port.postMessage({ type: 'clock', offset: transport.clockOffset() });
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
      case 'status':
        return {
          member: members[tabId] || null,
          status: lastStatus.get(tabId) || null,
          connected: ports.has(tabId),
          transport: transport.name,
        };
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
      case 'countdown': {
        const port = ports.get(tabId);
        if (port) port.postMessage({ type: 'command', cmd: 'countdown' });
        return { ok: !!port };
      }
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
  countdown: (tabId) => {
    const port = ports.get(tabId);
    if (port) port.postMessage({ type: 'command', cmd: 'countdown' });
  },
};
