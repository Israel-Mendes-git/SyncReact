// SyncReact — content script do YouTube.
// Controla o <video> da página e mantém ele alinhado com a "linha do tempo" da sala.
//
// Modelo:
//   state  = linha do tempo compartilhada { videoId, playing, position, at, rate, frozen, ts, by }
//            posição esperada no instante t = position + (t - at) * rate   (se tocando)
//            o último a agir vence (ts, depois by).
//   holds  = quem está segurando a sala (anúncio, carregando). Enquanto houver hold,
//            todo mundo espera; quando o último solta, o "líder" agenda a retomada.
//   report = cada aba manda a cada 1 s onde está, para presença, holds e o painel.

(() => {
  'use strict';
  if (window.__syncreact) return;
  window.__syncreact = true;

  // ------------------------------------------------------------------ ajustes
  const TICK_MS = 250;
  const REPORT_MS = 1000;
  const PEER_TIMEOUT_MS = 4500;
  const SEEK_THRESHOLD = 0.8;   // s: diferença acima disso → pula direto
  const DRIFT_START = 0.05;     // s: começa a corrigir pela velocidade
  const DRIFT_STOP = 0.02;      // s: para de corrigir
  const DRIFT_GAIN = 0.8;       // ajuste de velocidade por segundo de diferença
  const MAX_RATE_ADJ = 0.08;    // no máximo ±8% de velocidade
  const RESUME_LEAD_MS = 700;   // retomada depois de espera é agendada com essa folga
  const COUNTDOWN_MS = 3000;
  const BUFFER_HOLD_AFTER_MS = 800;   // tentando tocar sem dados por mais que isso → segura a sala
  const BUFFER_RELEASE_MS = 4000;     // segurando por carregamento: tenta de novo depois disso
  const BUFFER_BUDGET_MS = 12000;     // mais que isso segurando em 30 s → para de segurar a sala
  const BUFFER_WINDOW_MS = 30000;
  const QUIET_AFTER_NAV_MS = 1500;

  // ------------------------------------------------------------------ estado
  let port = null;
  let member = null;           // { room, peerId }
  let transportName = 'local';
  let netStatus = null;
  let netOpenAt = 0;        // 'connecting' | 'open' | 'closed' | 'error' (só no modo servidor)
  let clockOffset = 0;
  let settings = { name: '', autoFollow: true, offsetMs: 0, overlay: true };

  let state = null;
  const holds = {};            // peerId -> { reason, name }
  const peers = {};            // peerId -> { name, seen, report }
  let myHold = null;

  let player = null;
  let video = null;
  let appliedRate = null;
  let ourSeekTarget = null;    // seek feito pela extensão, reconhecido pelo destino
  let seekingSince = 0;
  let lastSeekAt = 0;
  let playRequestedAt = 0;    // para perceber quando o navegador bloqueou o play automático
  let claimOnMismatch = false; // página recarregada já na sala: vídeo diferente = escolha da pessoa
  let pendingFollow = null;    // vídeo para onde o background diz que esta aba estava indo
  let correcting = false;
  const ignoreUntil = { play: 0, pause: 0, seek: 0, rate: 0 };
  let quietUntil = Date.now() + QUIET_AFTER_NAV_MS;
  let lastNavAt = Date.now();
  let lastVideoId = undefined;
  let wasAd = false;
  let bufferingSince = 0;
  let holdSince = 0;
  const bufferHolds = [];     // [início, fim] das esperas por carregamento recentes
  let catchUpUntil = 0;       // conexão ruim: não segura a sala, só alcança quando der
  let startTimer = null;
  let startTimerTs = null;
  let joinedAt = 0;
  let followingTo = null;
  let autoplayBlocked = false;
  let lastPeerDiffMs = null;

  const now = () => Date.now() + clockOffset;
  const debugLog = [];
  function D(...a) {
    debugLog.push([Date.now() % 1000000, video ? +video.currentTime.toFixed(3) : null, ...a]);
    if (debugLog.length > 300) debugLog.shift();
  }
  const myId = () => (member ? member.peerId : null);
  const myName = () => settings.name || 'Sem nome';
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

  // ------------------------------------------------------------------ util YouTube
  function currentVideoId() {
    if (location.pathname !== '/watch') return null;
    return new URLSearchParams(location.search).get('v');
  }

  function videoTitle() {
    const h = document.querySelector('ytd-watch-metadata h1, h1.ytd-watch-metadata');
    const t = (h && h.textContent.trim()) || document.title.replace(/ - YouTube$/, '');
    return t.replace(/^\(\d+\)\s*/, '');
  }

  function isAd() {
    return !!(player && (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting')));
  }

  function refreshVideo() {
    player = document.querySelector('#movie_player');
    const v = (player && player.querySelector('video.html5-main-video')) || document.querySelector('video.html5-main-video');
    if (v === video) return;
    if (video) for (const ev of LOCAL_EVENTS) video.removeEventListener(ev, onLocalEvent);
    video = v || null;
    appliedRate = null;
    if (video) for (const ev of LOCAL_EVENTS) video.addEventListener(ev, onLocalEvent);
  }

  // ------------------------------------------------------------------ comandos no vídeo (marcados para não ecoar)
  // play/pause/seek vão pela API do player (src/page-bridge.js); sem ela, direto no <video>
  function playerCmd(op, t) {
    if (document.documentElement.dataset.syncreactBridge) {
      window.dispatchEvent(new CustomEvent('syncreact-cmd', { detail: JSON.stringify({ op, t }) }));
      return true;
    }
    return false;
  }

  function progPlay() {
    if (!video || !video.paused) return;
    ignoreUntil.play = Date.now() + 1500;
    if (!playRequestedAt) playRequestedAt = Date.now();
    D('play');
    if (playerCmd('play')) return;
    const p = video.play();
    if (p && p.catch) {
      p.catch((err) => { if (err && err.name === 'NotAllowedError') autoplayBlocked = true; });
    }
  }

  function progPause() {
    if (!video || video.paused) return;
    ignoreUntil.pause = Date.now() + 1500;
    D('pause');
    if (!playerCmd('pause')) video.pause();
  }

  function progSeek(t) {
    if (!video) return;
    const d = video.duration;
    let target = Math.max(0, t);
    if (isFinite(d) && d > 0) target = Math.min(target, d - 0.25);
    ourSeekTarget = target;
    lastSeekAt = Date.now();
    bufferingSince = 0; // depois de um seek, a espera por carregamento recomeça a contar
    D('seek', +target.toFixed(3));
    if (!playerCmd('seek', target)) video.currentTime = target;
  }

  function setRate(r) {
    if (!video) return;
    r = clamp(r, 0.0625, 16);
    appliedRate = r;
    if (Math.abs(video.playbackRate - r) > 0.0005) {
      ignoreUntil.rate = Date.now() + 600;
      video.playbackRate = r;
    }
  }

  // ------------------------------------------------------------------ linha do tempo
  function expectedPos(s, t) {
    if (!s) return null;
    if (!s.playing || s.frozen || t < s.at) return s.position;
    return s.position + ((t - s.at) / 1000) * s.rate;
  }

  function anyHold() {
    return Object.keys(holds).length > 0;
  }

  function issueState(patch) {
    if (!member) return;
    const vid = currentVideoId();
    const base = state && state.videoId === (patch.videoId || vid)
      ? state
      : { videoId: vid, playing: false, position: 0, rate: 1, frozen: false, countdown: false };
    state = Object.assign({}, base, { at: now(), countdown: false }, patch, { ts: now(), by: myId() });
    D('issue', JSON.stringify(patch));
    sendRoom({ type: 'state', state });
    onStateChanged();
  }

  function acceptState(s) {
    if (state && (s.ts < state.ts || (s.ts === state.ts && s.by <= state.by))) return;
    D('accept', JSON.stringify({ p: s.playing, f: s.frozen, pos: +s.position.toFixed(3), in: s.at - now(), v: s.videoId }));
    state = s;
    onStateChanged();
  }

  function onStateChanged() {
    if (startTimer && (!state || state.ts !== startTimerTs)) {
      clearTimeout(startTimer);
      startTimer = null;
    }
    setTimeout(tick, 0); // fora da pilha atual: issueState pode ser chamado de dentro do tick
  }

  function scheduleStart(s) {
    if (startTimer && startTimerTs === s.ts) return;
    if (startTimer) clearTimeout(startTimer);
    startTimerTs = s.ts;
    startTimer = setTimeout(() => {
      startTimer = null;
      if (state && state.ts === s.ts && !anyHold() && video) {
        const target = s.position + settings.offsetMs / 1000;
        if (Math.abs(video.currentTime - target) > 0.04) progSeek(target);
        D('start-timer', s.at - now());
        progPlay();
      }
    }, Math.max(0, s.at - now()));
  }

  function amLeader() {
    if (!state) return false;
    let lowest = myId();
    for (const [id, p] of Object.entries(peers)) {
      if (p.report && p.report.videoId === state.videoId && id < lowest) lowest = id;
    }
    return lowest === myId();
  }

  // ------------------------------------------------------------------ holds
  function computeHold(ad) {
    if (ad) return 'ad';
    const v = video;
    if (myHold === 'buffering') {
      // pausado esperando: solta quando já tem dados ou depois de um tempo (se travar de novo, segura de novo)
      if (v.readyState >= 3 || Date.now() - holdSince > BUFFER_RELEASE_MS) {
        bufferingSince = 0;
        bufferHolds.push([holdSince, Date.now()]);
        const since = Date.now() - BUFFER_WINDOW_MS;
        while (bufferHolds.length && bufferHolds[0][1] < since) bufferHolds.shift();
        const total = bufferHolds.reduce((acc, [a, b]) => acc + (b - Math.max(a, since)), 0);
        if (total > BUFFER_BUDGET_MS) {
          catchUpUntil = Date.now() + BUFFER_WINDOW_MS;
          bufferHolds.length = 0;
          D('catch-up');
        }
        return null;
      }
      return 'buffering';
    }
    if (Date.now() < catchUpUntil) return null;
    // só conta como travado se o vídeo está tentando tocar e não tem dados
    const stalled = state && state.playing && !v.paused && v.readyState < 3;
    if (!stalled) {
      bufferingSince = 0;
      return null;
    }
    if (!bufferingSince) bufferingSince = Date.now();
    return Date.now() - bufferingSince > BUFFER_HOLD_AFTER_MS ? 'buffering' : null;
  }

  function setMyHold(reason) {
    if (reason === myHold) return;
    if (reason && !myHold && state && state.playing && !state.frozen && state.videoId === currentVideoId()) {
      // congela a sala. Se o motivo é carregamento, congela onde ESTA aba está: os outros
      // voltam um pouco para um trecho que já têm, e esta não precisa pular para um trecho sem dados.
      let pos = expectedPos(state, now());
      if (reason === 'buffering' && video) pos = Math.min(pos, video.currentTime);
      issueState({ frozen: true, position: pos, at: now() });
    }
    D('hold', reason);
    myHold = reason;
    holdSince = Date.now();
    if (reason) holds[myId()] = { reason, name: myName() };
    else delete holds[myId()];
    sendReport();
  }

  // ------------------------------------------------------------------ laço principal
  function tick() {
    refreshVideo();
    const vid = currentVideoId();
    if (vid !== lastVideoId) onVideoChanged(vid);
    if (!member) {
      renderOverlay();
      return;
    }
    prunePeers();

    const ad = isAd();
    if (wasAd && !ad) quietUntil = Date.now() + 1200; // o YouTube mexe no vídeo quando o anúncio acaba
    wasAd = ad;

    // ninguém respondeu ao hello em 1,5 s (contando da conexão aberta, no modo servidor)
    const listeningSince = transportName === 'servidor' ? (netStatus === 'open' ? Math.max(joinedAt, netOpenAt) : 0) : joinedAt;
    if (!state && vid && video && listeningSince && Date.now() - listeningSince > 1500) {
      // ninguém respondeu: esta aba inaugura a sala com o que está tocando
      issueState({ videoId: vid, playing: !video.paused, position: video.currentTime, rate: video.playbackRate, at: now() });
    }

    if (!vid || !video || !state) {
      setMyHold(null);
      renderOverlay();
      return;
    }

    if (state.videoId !== vid && claimOnMismatch && pendingFollow !== vid) {
      // a pessoa abriu outro vídeo direto pela URL (página recarregada já na sala)
      claimOnMismatch = false;
      issueState({ videoId: vid, playing: false, frozen: false, position: 0, rate: 1, at: now() });
      renderOverlay();
      return;
    }
    claimOnMismatch = false;

    if (state.videoId !== vid) {
      setMyHold(null);
      if (settings.autoFollow && state.videoId && followingTo !== state.videoId) followVideo(state.videoId);
      renderOverlay();
      return;
    }

    setMyHold(computeHold(ad));
    if (!ad) enforce(now());
    maybeLeaderResume();
    renderOverlay();
  }

  function enforce(t) {
    const s = state;
    const v = video;
    // espera o seek terminar (nosso ou da pessoa), mas não para sempre. Pela API do player,
    // o currentTime só muda quando o YouTube tem dados; repetir o seek antes disso reinicia o carregamento.
    if (v.seeking && Date.now() - seekingSince < 3000) return;
    if (ourSeekTarget !== null && Date.now() - lastSeekAt < 3000) return;
    if (v.readyState === 0) return; // player recarregando
    const holding = anyHold();
    const shouldPlay = s.playing && !s.frozen && !holding && t >= s.at;

    if (!v.paused) {
      playRequestedAt = 0;
      autoplayBlocked = false;
    }

    if (!shouldPlay) {
      playRequestedAt = 0;
      if (!v.paused) progPause();
      // com hold recém-chegado e sala ainda não congelada, só pausa onde está
      if (!(holding && !s.frozen) && Math.abs(v.currentTime - s.position) > 0.04) progSeek(s.position);
      setRate(s.rate);
      correcting = false;
      if (s.playing && !s.frozen && !holding && t < s.at) scheduleStart(s);
      return;
    }

    const target = expectedPos(s, t) + settings.offsetMs / 1000;
    if (v.ended || (isFinite(v.duration) && target >= v.duration - 0.3)) return;

    if (v.paused) {
      // pediu play, tem dados e continua parado: o navegador bloqueou o play sem clique
      if (playRequestedAt && Date.now() - playRequestedAt > 2500 && v.readyState >= 3) autoplayBlocked = true;
      if (Math.abs(v.currentTime - target) > 0.15) progSeek(target);
      progPlay();
      return;
    }

    // tocando mas sem dados: pular de novo só reiniciaria o carregamento; a espera da sala cuida disso
    if (v.readyState < 3) return;

    const diff = v.currentTime - target; // positivo = adiantado
    if (Math.abs(diff) > SEEK_THRESHOLD) {
      progSeek(target + 0.05); // pequena folga pelo tempo que o seek leva
      setRate(s.rate);
      correcting = false;
      return;
    }
    if (Math.abs(diff) > DRIFT_START || (correcting && Math.abs(diff) > DRIFT_STOP)) {
      correcting = true;
      setRate(s.rate * (1 + clamp(-diff * DRIFT_GAIN, -MAX_RATE_ADJ, MAX_RATE_ADJ)));
    } else {
      correcting = false;
      setRate(s.rate);
    }
  }

  function maybeLeaderResume() {
    if (!state || !state.frozen || anyHold() || !amLeader()) return;
    // se havia contagem agendada, respeita o horário dela
    const at = Math.max(state.at, now() + RESUME_LEAD_MS);
    issueState({ frozen: false, position: state.position, at, countdown: !!state.countdown && state.at > now() });
  }

  function followVideo(id) {
    followingTo = id;
    post({ type: 'following', videoId: id });
    D('follow', id);
    setTimeout(() => location.assign('https://www.youtube.com/watch?v=' + encodeURIComponent(id)), 50);
  }

  function onVideoChanged(vid) {
    const first = lastVideoId === undefined;
    lastVideoId = vid;
    lastNavAt = Date.now();
    quietUntil = Date.now() + QUIET_AFTER_NAV_MS;
    bufferingSince = 0;
    autoplayBlocked = false;
    if (first || !member || !vid) return;
    if (state && state.videoId !== vid && followingTo !== vid) {
      // a pessoa escolheu outro vídeo: a sala vai junto, pausada no começo
      issueState({ videoId: vid, playing: false, frozen: false, position: 0, rate: 1, at: now() });
    }
  }

  // ------------------------------------------------------------------ ações da pessoa
  const LOCAL_EVENTS = ['play', 'pause', 'seeking', 'seeked', 'ratechange'];

  function onLocalEvent(e) {
    if (e.type === 'seeked') return;
    if (e.type === 'seeking' && e.target === video) {
      seekingSince = Date.now();
      const ours = ourSeekTarget !== null && Math.abs(video.currentTime - ourSeekTarget) < 0.3;
      ourSeekTarget = null;
      if (ours) return;
    }
    if (!member || !state || e.target !== video) return;
    if (isAd() || Date.now() < quietUntil) return;
    const vid = currentVideoId();
    if (!vid || vid !== state.videoId) return;
    const v = video;
    const t = Date.now();
    // gesto real recente (clique/tecla); sem a API, assume que sim
    const gesture = navigator.userActivation ? navigator.userActivation.isActive : true;
    if (e.type !== 'ratechange') D('local', e.type, gesture, t < (ignoreUntil[e.type] || 0) ? 'ign' : '', t - lastNavAt);

    switch (e.type) {
      case 'play': {
        if (t < ignoreUntil.play) { ignoreUntil.play = 0; return; }
        // play sem gesto logo depois de abrir o vídeo é autoplay do YouTube, não da pessoa
        if (!gesture && t - lastNavAt < 6000) return;
        if (state.playing && !state.frozen) return;
        autoplayBlocked = false;
        issueState({ playing: true, frozen: anyHold(), position: v.currentTime, at: now() });
        break;
      }
      case 'pause': {
        if (t < ignoreUntil.pause) { ignoreUntil.pause = 0; return; }
        if (!state.playing) return;
        issueState({ playing: false, frozen: false, position: v.currentTime, at: now() });
        break;
      }
      case 'seeking': {
        // no início do seek o currentTime já é o destino; o fim (seeked) pode demorar ou nem vir
        // sem gesto é o próprio YouTube (recarregando o player, voltando ao 0): não é da pessoa
        if (!gesture) return;
        const exp = expectedPos(state, now()) + (state.playing ? settings.offsetMs / 1000 : 0);
        if (Math.abs(v.currentTime - exp) < 0.5) return;
        issueState({ position: v.currentTime, at: now(), frozen: state.frozen });
        break;
      }
      case 'ratechange': {
        if (t < ignoreUntil.rate) { ignoreUntil.rate = 0; return; }
        if (appliedRate !== null && Math.abs(v.playbackRate - appliedRate) < 0.001) return;
        if (Math.abs(v.playbackRate - state.rate) < 0.001) return; // o YouTube só desfez nossa correção
        if (!gesture) return;
        issueState({ rate: v.playbackRate, position: expectedPos(state, now()), at: now(), frozen: state.frozen });
        break;
      }
    }
  }

  function startCountdown() {
    if (!member || !video || !state || state.videoId !== currentVideoId()) return;
    const pos = state.playing && !state.frozen ? expectedPos(state, now()) : video.currentTime;
    issueState({ playing: true, frozen: anyHold(), position: pos, at: now() + COUNTDOWN_MS, countdown: true });
  }

  // ------------------------------------------------------------------ sala
  function sendRoom(msg) {
    if (!member) return;
    post({ type: 'room', msg: Object.assign({}, msg, { from: myId(), name: myName() }) });
  }

  function touchPeer(id, name) {
    const p = peers[id] || (peers[id] = { name, seen: 0, report: null });
    p.name = name || p.name;
    p.seen = Date.now();
    return p;
  }

  function prunePeers() {
    for (const [id, p] of Object.entries(peers)) {
      if (Date.now() - p.seen > PEER_TIMEOUT_MS) {
        delete peers[id];
        delete holds[id];
      }
    }
  }

  function onRoomMessage(m) {
    if (!member || m.from === myId()) return;
    if (m.type === 'bye') {
      delete peers[m.from];
      delete holds[m.from];
      tick();
      return;
    }
    const p = touchPeer(m.from, m.name);
    switch (m.type) {
      case 'hello':
        if (state) sendRoom({ type: 'state', state });
        sendReport();
        break;
      case 'state':
        acceptState(m.state);
        break;
      case 'report': {
        p.report = m;
        const had = holds[m.from] ? holds[m.from].reason : null;
        if (m.hold) holds[m.from] = { reason: m.hold, name: m.name };
        else delete holds[m.from];
        if (had !== (m.hold || null)) tick();
        break;
      }
    }
  }

  function peerDiffMs(r) {
    if (!video || !r || r.pos == null || r.ad || isAd() || !state) return null;
    if (r.videoId !== currentVideoId() || !r.playing || video.paused) return null;
    const exp = r.pos + ((now() - r.at) / 1000) * r.rate;
    return Math.round((video.currentTime - exp) * 1000);
  }

  function sendReport() {
    if (!member) return;
    const v = video;
    sendRoom({
      type: 'report',
      videoId: currentVideoId(),
      title: currentVideoId() ? videoTitle() : null,
      pos: v ? v.currentTime : null,
      playing: v ? !v.paused : false,
      rate: v ? v.playbackRate : 1,
      at: now(),
      hold: myHold,
      ad: isAd(),
    });
    post({ type: 'status', status: buildStatus() });
  }

  function buildStatus() {
    const list = Object.entries(peers).map(([id, p]) => ({
      id,
      name: p.name,
      videoId: p.report ? p.report.videoId : null,
      title: p.report ? p.report.title : null,
      hold: holds[id] ? holds[id].reason : null,
      diffMs: peerDiffMs(p.report),
    }));
    const diffs = list.map((p) => p.diffMs).filter((d) => d != null);
    lastPeerDiffMs = diffs.length ? diffs.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a)) : null;
    return {
      videoId: currentVideoId(),
      title: currentVideoId() ? videoTitle() : null,
      state: state ? { videoId: state.videoId, playing: state.playing, frozen: state.frozen } : null,
      myHold,
      peers: list,
      autoplayBlocked,
      t: Date.now(),
    };
  }

  // ------------------------------------------------------------------ canal com o service worker
  function post(msg) {
    if (!port) return;
    try { port.postMessage(msg); } catch (_) { port = null; }
  }

  function connect() {
    if (!chrome.runtime || !chrome.runtime.id) return; // extensão recarregada: este script morreu
    try {
      port = chrome.runtime.connect({ name: 'syncreact' });
    } catch (_) {
      port = null;
      return;
    }
    port.onMessage.addListener(onBgMessage);
    port.onDisconnect.addListener(() => {
      port = null;
      setTimeout(connect, 1000);
    });
  }

  function resetRoom() {
    state = null;
    myHold = null;
    for (const k of Object.keys(holds)) delete holds[k];
    for (const k of Object.keys(peers)) delete peers[k];
    if (startTimer) clearTimeout(startTimer);
    startTimer = null;
  }

  function onBgMessage(msg) {
    switch (msg.type) {
      case 'membership': {
        transportName = msg.transport || transportName;
        const next = msg.member;
        const same = member && next && member.room === next.room && member.peerId === next.peerId;
        if (same) return;
        resetRoom();
        member = next;
        if (!member) {
          if (video && appliedRate !== null) video.playbackRate = 1;
          appliedRate = null;
          renderOverlay();
          return;
        }
        joinedAt = Date.now();
        pendingFollow = msg.followingTo || null;
        claimOnMismatch = !msg.justJoined;
        sendRoom({ type: 'hello' });
        sendReport();
        break;
      }
      case 'clock':
        clockOffset = msg.offset || 0;
        break;
      case 'net': {
        const was = netStatus;
        netStatus = msg.status;
        if (netStatus === 'open' && was !== 'open') netOpenAt = Date.now();
        // conectou ou reconectou: pede o estado da sala de novo
        if (member && netStatus === 'open' && was !== 'open') {
          sendRoom({ type: 'hello' });
          sendReport();
        }
        renderOverlay();
        break;
      }
      case 'room':
        onRoomMessage(msg.msg);
        break;
      case 'command':
        if (msg.cmd === 'countdown') startCountdown();
        break;
    }
  }

  // ------------------------------------------------------------------ overlay no player
  let overlay = null;

  function ensureOverlay() {
    if (!player) return null;
    if (overlay && overlay.root.parentNode === player) return overlay;
    if (overlay) overlay.root.remove();
    const root = document.createElement('div');
    root.className = 'syncreact-overlay';
    root.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:59;font-family:Roboto,Arial,sans-serif;';
    const pill = document.createElement('div');
    pill.style.cssText = 'position:absolute;top:12px;left:12px;display:flex;align-items:center;gap:8px;padding:5px 12px;border-radius:14px;background:rgba(0,0,0,.65);color:#fff;font-size:13px;line-height:18px;max-width:70%;';
    const dot = document.createElement('span');
    dot.style.cssText = 'width:9px;height:9px;border-radius:50%;flex:none;';
    const text = document.createElement('span');
    const btn = document.createElement('button');
    btn.textContent = 'Ir para o vídeo';
    btn.style.cssText = 'pointer-events:auto;display:none;border:0;border-radius:10px;padding:2px 10px;background:#fff;color:#000;font-size:12px;cursor:pointer;';
    btn.addEventListener('click', () => {
      if (state && state.videoId) followVideo(state.videoId);
    });
    pill.append(dot, text, btn);
    const big = document.createElement('div');
    big.style.cssText = 'position:absolute;inset:0;display:none;align-items:center;justify-content:center;color:#fff;font-size:120px;font-weight:700;text-shadow:0 4px 24px rgba(0,0,0,.8);';
    root.append(pill, big);
    player.appendChild(root);
    overlay = { root, pill, dot, text, btn, big };
    return overlay;
  }

  const HOLD_LABEL = { ad: 'anúncio', buffering: 'carregando' };

  function renderOverlay() {
    const vid = currentVideoId();
    if (!member || !vid || !settings.overlay) {
      if (overlay) overlay.root.style.display = 'none';
      return;
    }
    const o = ensureOverlay();
    if (!o) return;
    o.root.style.display = '';

    let color = '#9aa0a6';
    let msg = 'Sala ' + member.room + ' · conectando…';
    let showBtn = false;
    let bigText = '';
    const others = Object.values(peers).filter((p) => p.report);
    const otherHolds = Object.entries(holds).filter(([id]) => id !== myId());

    if (transportName === 'servidor' && netStatus !== 'open') {
      color = '#ea4335';
      msg = netStatus === 'connecting' || !netStatus ? 'Conectando ao servidor…' : 'Sem conexão com o servidor · tentando de novo';
    } else if (autoplayBlocked) {
      color = '#ea4335';
      msg = 'Clique no vídeo uma vez para liberar o play automático';
    } else if (state && state.videoId !== vid) {
      color = '#fbbc04';
      const who = peers[state.by] ? peers[state.by].name : 'Seu amigo';
      msg = settings.autoFollow ? 'Indo para o vídeo da sala…' : who + ' está em outro vídeo';
      showBtn = !settings.autoFollow;
    } else if (myHold === 'ad') {
      color = '#fbbc04';
      msg = others.length ? 'Anúncio aqui · a sala espera você' : 'Anúncio';
    } else if (otherHolds.length) {
      color = '#fbbc04';
      msg = 'Esperando ' + otherHolds.map(([, h]) => h.name + ' (' + (HOLD_LABEL[h.reason] || h.reason) + ')').join(', ');
    } else if (Date.now() < catchUpUntil && video && video.readyState < 3) {
      color = '#ea4335';
      msg = 'Sua conexão está lenta · a sala segue e você alcança quando carregar';
    } else if (myHold === 'buffering') {
      color = '#fbbc04';
      msg = 'Carregando · a sala espera você';
    } else if (state && state.playing && !state.frozen && now() < state.at) {
      color = '#34a853';
      msg = 'Começando…';
      if (state.countdown) bigText = String(Math.ceil((state.at - now()) / 1000));
    } else if (!others.length) {
      msg = 'Sala ' + member.room + ' · só você aqui';
    } else if (state && state.playing) {
      const d = lastPeerDiffMs;
      const names = others.map((p) => p.name).join(', ');
      if (d == null) {
        msg = 'Tocando com ' + names;
        color = '#34a853';
      } else if (Math.abs(d) <= 150) {
        msg = 'Sincronizado com ' + names + ' · ' + (d > 0 ? '+' : '') + d + ' ms';
        color = '#34a853';
      } else {
        msg = 'Ajustando com ' + names + ' · ' + (d > 0 ? '+' : '') + d + ' ms';
        color = '#fbbc04';
      }
    } else {
      msg = 'Pausado · ' + (others.length + 1) + ' na sala';
      color = '#4285f4';
    }

    o.dot.style.background = color;
    if (o.text.textContent !== msg) o.text.textContent = msg;
    o.btn.style.display = showBtn ? '' : 'none';
    o.big.style.display = bigText ? 'flex' : 'none';
    if (bigText && o.big.textContent !== bigText) o.big.textContent = bigText;
  }

  // ------------------------------------------------------------------ início
  chrome.storage.local.get(['name', 'autoFollow', 'offsetMs', 'overlay']).then((d) => {
    settings = Object.assign(settings, Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined)));
    renderOverlay();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const [k, c] of Object.entries(changes)) if (k in settings) settings[k] = c.newValue;
    tick();
  });

  window.addEventListener('pagehide', () => sendRoom({ type: 'bye' }));

  connect();
  setInterval(tick, TICK_MS);
  setInterval(sendReport, REPORT_MS);
  tick();

  // usado pelos testes automatizados
  window.addEventListener('syncreact-debug', () => {
    document.documentElement.dataset.syncreact = JSON.stringify({ member, state, holds, myHold, peers: Object.keys(peers), diff: lastPeerDiffMs, log: debugLog });
  });
})();
