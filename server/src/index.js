// SyncReact — servidor (Cloudflare Worker + Durable Object).
// Cada código de sala vira um Durable Object que só repassa mensagens entre quem está nela.
// Nenhum vídeo passa por aqui: só textos curtos como "play no 1:23".
//
//   GET /                → "SyncReact ok"
//   GET /room/<CÓDIGO>   → WebSocket da sala (?peer=<id> identifica quem conectou)
//
// Mensagens especiais:
//   {"type":"_ping","t0":...}  → responde {"type":"_pong","t0":...,"server":<hora do servidor>}
//   ao desconectar alguém, a sala recebe {"type":"bye","from":<peer>}

const MAX_PEERS = 8;
const MAX_MESSAGE = 8192;

export class Room {
  constructor(ctx) {
    this.ctx = ctx;
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('esperava WebSocket', { status: 426 });
    }
    if (this.ctx.getWebSockets().length >= MAX_PEERS) {
      // aceita e fecha com código próprio: o navegador não mostra o status HTTP de um WebSocket
      // recusado, então sem isso a extensão ficaria tentando reconectar para sempre
      const full = new WebSocketPair();
      full[1].accept();
      full[1].close(4001, 'sala cheia');
      return new Response(null, { status: 101, webSocket: full[0] });
    }
    const url = new URL(request.url);
    const peer = (url.searchParams.get('peer') || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 16);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    // API com hibernação: o objeto pode dormir entre mensagens sem derrubar as conexões
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ peer });
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, message) {
    if (typeof message !== 'string' || message.length > MAX_MESSAGE) return;
    if (message.includes('"_ping"')) {
      let m;
      try { m = JSON.parse(message); } catch (_) { return; }
      if (m.type === '_ping') {
        ws.send(JSON.stringify({ type: '_pong', t0: m.t0, server: Date.now() }));
        return;
      }
    }
    this.broadcast(ws, message);
  }

  webSocketClose(ws, code) {
    this.leave(ws);
    try { ws.close(code === 1005 ? 1000 : code, 'tchau'); } catch (_) {}
  }

  webSocketError(ws) {
    this.leave(ws);
  }

  leave(ws) {
    const { peer } = ws.deserializeAttachment() || {};
    if (peer) this.broadcast(ws, JSON.stringify({ type: 'bye', from: peer }));
  }

  broadcast(from, message) {
    for (const other of this.ctx.getWebSockets()) {
      if (other === from) continue;
      try { other.send(message); } catch (_) {}
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/') return new Response('SyncReact ok');
    const m = url.pathname.match(/^\/room\/([A-Z0-9]{4,12})$/);
    if (!m) return new Response('não encontrado', { status: 404 });
    const room = env.ROOMS.get(env.ROOMS.idFromName(m[1]));
    return room.fetch(request);
  },
};
