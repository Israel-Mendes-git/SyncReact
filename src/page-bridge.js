// SyncReact — roda no mundo da página (não no isolado) para usar a API do player do YouTube.
// Mexer no <video> por baixo do player confunde o YouTube: um pause direto faz o player
// achar que travou e recarregar o vídeo do zero; um currentTime direto pode deixá-lo sem carregar.
// Pela API, o próprio player faz play, pause e seek e continua no controle do carregamento.
(() => {
  'use strict';
  document.documentElement.dataset.syncreactBridge = '1';
  window.addEventListener('syncreact-cmd', (e) => {
    let cmd;
    try { cmd = JSON.parse(e.detail); } catch (_) { return; }
    const p = document.getElementById('movie_player');
    const v = document.querySelector('video.html5-main-video');
    const api = p && typeof p.seekTo === 'function';
    switch (cmd.op) {
      case 'seek':
        if (!isFinite(cmd.t)) return;
        if (api) p.seekTo(cmd.t, true);
        else if (v) v.currentTime = cmd.t;
        break;
      case 'play':
        if (api) p.playVideo();
        else if (v) v.play().catch(() => {});
        break;
      case 'pause':
        if (api) p.pauseVideo();
        else if (v) v.pause();
        break;
    }
  });
})();
