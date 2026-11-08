'use strict';

const $ = (id) => document.getElementById(id);
let tabId = null;

const DEFAULTS = { name: '', autoFollow: true, offsetMs: 0, overlay: true, server: '' };
const HOLD_LABEL = { ad: 'anúncio', buffering: 'carregando' };

function ask(cmd, extra) {
  return chrome.runtime.sendMessage(Object.assign({ cmd, tabId }, extra));
}

async function init() {
  // ?tab=ID permite abrir o popup como página apontando para uma aba (usado nos testes)
  const forced = Number(new URLSearchParams(location.search).get('tab'));
  const [tab] = forced
    ? [await chrome.tabs.get(forced)]
    : await chrome.tabs.query({ active: true, currentWindow: true });
  const isYouTube = tab && tab.url && /^https:\/\/www\.youtube\.com\//.test(tab.url);
  if (!isYouTube) {
    $('not-youtube').hidden = false;
    return;
  }
  tabId = tab.id;
  $('main').hidden = false;

  const s = Object.assign({}, DEFAULTS, await chrome.storage.local.get(Object.keys(DEFAULTS)));
  $('name').value = s.name;
  $('autoFollow').checked = s.autoFollow;
  $('overlay').checked = s.overlay;
  $('offsetMs').value = s.offsetMs;
  $('server').value = s.server;
  $('server').addEventListener('change', () => chrome.storage.local.set({ server: $('server').value.trim() }));
  showOffset(s.offsetMs);

  $('name').addEventListener('input', () => chrome.storage.local.set({ name: $('name').value.trim() }));
  $('autoFollow').addEventListener('change', () => chrome.storage.local.set({ autoFollow: $('autoFollow').checked }));
  $('overlay').addEventListener('change', () => chrome.storage.local.set({ overlay: $('overlay').checked }));
  $('offsetMs').addEventListener('input', () => {
    const v = Number($('offsetMs').value);
    showOffset(v);
    chrome.storage.local.set({ offsetMs: v });
  });

  $('create').addEventListener('click', async () => {
    if (!checkName()) return;
    await ask('create');
    refresh();
  });
  $('join').addEventListener('click', joinRoom);
  $('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });
  $('leave').addEventListener('click', async () => { await ask('leave'); refresh(); });
  $('countdown').addEventListener('click', () => ask('countdown'));
  $('copy').addEventListener('click', async () => {
    await navigator.clipboard.writeText($('room-code').textContent);
    $('copy').textContent = 'Copiado';
    setTimeout(() => { $('copy').textContent = 'Copiar'; }, 1200);
  });

  refresh();
  setInterval(refresh, 500);
}

function checkName() {
  if ($('name').value.trim()) return true;
  $('name').focus();
  $('name').placeholder = 'Coloque um nome antes';
  return false;
}

async function joinRoom() {
  const code = $('code').value.trim().toUpperCase();
  if (!checkName()) return;
  if (code.length < 4) { $('code').focus(); return; }
  await ask('join', { room: code });
  refresh();
}

function showOffset(v) {
  $('offset-label').textContent = (v > 0 ? '+' : '') + v + ' ms';
}

async function refresh() {
  const r = await ask('status');
  if (!r) return;
  const mode = r.member ? r.member.server : r.server;
  $('mode').textContent = mode === 'local' ? 'teste local' : 'online';
  if (!$('server').value && document.activeElement !== $('server')) $('server').placeholder = r.defaultServer || 'local';
  const inRoom = !!r.member;
  $('lobby').hidden = inRoom;
  $('room').hidden = !inRoom;
  if (!inRoom) return;
  $('room-code').textContent = r.member.room;
  const net = $('net');
  if (r.member.server === 'local') {
    net.textContent = 'Só abas deste navegador (teste local)';
    net.style.setProperty('--c', '#9aa0a6');
  } else if (r.net && r.net.status === 'open') {
    net.textContent = 'Conectado ao servidor' + (r.net.rtt != null ? ' · ping ' + r.net.rtt + ' ms' : '');
    net.style.setProperty('--c', '#34a853');
  } else {
    net.textContent = r.net && r.net.status === 'connecting' ? 'Conectando ao servidor…' : 'Sem conexão · tentando de novo';
    net.style.setProperty('--c', '#ea4335');
  }

  const st = r.status;
  const ul = $('peers');
  ul.replaceChildren();
  if (!st || !st.peers.length) {
    const li = document.createElement('li');
    li.innerHTML = '<span class="who">Ninguém mais na sala ainda</span>';
    ul.append(li);
    return;
  }
  for (const p of st.peers) {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'dot';
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = p.name || 'Sem nome';
    const info = document.createElement('span');
    info.className = 'info';
    let color = '#4285f4';
    if (p.hold) {
      info.textContent = HOLD_LABEL[p.hold] || p.hold;
      color = '#fbbc04';
    } else if (p.videoId && st.videoId && p.videoId !== st.videoId) {
      info.textContent = 'outro vídeo';
      color = '#fbbc04';
    } else if (p.diffMs != null) {
      info.textContent = (p.diffMs > 0 ? 'você +' : 'você ') + p.diffMs + ' ms';
      color = Math.abs(p.diffMs) <= 150 ? '#34a853' : '#fbbc04';
    } else {
      info.textContent = st.state && st.state.playing ? 'tocando' : 'pausado';
    }
    dot.style.background = color;
    li.append(dot, who, info);
    ul.append(li);
  }
}

init();
