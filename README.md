# SyncReact

Extensão para Opera/Chrome que mantém um vídeo do YouTube tocando no mesmo ponto para duas (ou mais) pessoas. Feita para react junto em call: ninguém precisa contar "3, 2, 1" nem voltar no mesmo minuto.

## Instalar (Opera)

1. Abra `opera://extensions` e ligue o **Modo de desenvolvedor** (canto superior direito).
2. Clique em **Carregar sem compactação** e escolha esta pasta (`SyncReact`).
3. Fixe o ícone na barra (ícone de cubo → alfinete).

No Chrome, Edge e Brave é igual, por `chrome://extensions`.

Depois de mudar o código, clique em **recarregar** no card da extensão e recarregue as abas do YouTube.

## Usar

1. Abra um vídeo do YouTube, clique no ícone e coloque seu nome.
2. **Criar sala** gera um código de 6 letras. Quem for entrar abre o YouTube, digita o código e clica em **Entrar**.
3. A partir daí, play, pause, pular para outro minuto e trocar de vídeo valem para todo mundo.
4. **Play com contagem** dá 3 segundos com contagem na tela de todos antes de começar.

O status aparece no canto do player: verde quando está sincronizado, amarelo quando está ajustando ou esperando alguém.

### Ajustes

- **Seguir quando o outro trocar de vídeo**: ligado, sua aba vai sozinha para o vídeo que o outro abriu.
- **Compensar atraso da call**: adianta ou atrasa o seu vídeo em até 400 ms, para a reação de um bater com o que o outro vê.

## Como funciona

- A sala tem uma linha do tempo comum: "tocando a partir de 1:23 desde tal instante". Quem agir por último (play, pause, seek, troca de vídeo) define a linha nova.
- Cada aba compara o próprio vídeo com essa linha a cada 250 ms. Diferença pequena é corrigida acelerando ou freando até 8%; acima de 0,8 s, pula direto.
- Anúncio ou carregamento em uma aba seguram a sala: todo mundo pausa e espera. Quando libera, a retomada é agendada com 0,7 s de folga para começarem juntos.
- Se a conexão de alguém travar demais (mais de 12 s de espera em 30 s), essa pessoa para de segurar a sala e alcança sozinha quando carregar.
- Seek e mudança de velocidade só contam quando vêm de clique ou tecla. Assim, um reset interno do player do YouTube não arrasta a sala para o começo.
- Autoplay do YouTube logo ao abrir um vídeo não conta como play de ninguém.

## Mandar para o amigo

O arquivo `SyncReact-extensao.zip` traz só o que a extensão precisa: `manifest.json`, `src/` (com o `config.js` preenchido), `popup/` e `icons/`. Ele descompacta numa pasta fixa (a extensão para de funcionar se a pasta for apagada) e instala igual: `opera://extensions` → Modo de desenvolvedor → Carregar sem compactação.

Para gerar o zip de novo depois de mudanças, compacte essas quatro coisas dentro de uma pasta `SyncReact`.

## Servidor

O endereço do servidor publicado fica em `src/config.js`, que não vai para o git. Copie `src/config.example.js` para `src/config.js` e preencha com o seu endereço.

O servidor fica em `server/`. É um Cloudflare Worker em que cada código de sala vira um Durable Object. Ele só repassa mensagens curtas entre quem está na sala, avisa quando alguém sai e responde a pings com a hora dele. Assim os relógios dos dois PCs batem, mesmo que o Windows de cada um esteja com alguns segundos de diferença.

Publicar (uma vez):

```
cd server
npm install
npx wrangler login      # abre o navegador para entrar na conta da Cloudflare
npx wrangler deploy     # mostra o endereço, algo como https://syncreact.<sua-conta>.workers.dev
```

Depois, coloque esse endereço (com `wss://`) em `src/config.js` e recarregue a extensão. Também dá para colar no popup, em Ajustes → Servidor.

Rodar localmente para testes: `cd server && npm run dev` (porta 8787, sem conta).

Para o uso de vocês dois, o plano grátis da Cloudflare sobra.

Em Ajustes → Servidor, o valor `local` volta ao modo de teste, que sincroniza só abas do mesmo navegador.

## Limites

- Só YouTube, página `/watch` (Shorts e miniplayer ficam de fora).

## Teste automático

```
npm install
npm test                                        # transporte local
SERVER=ws://127.0.0.1:8787 node tools/test-sync.mjs   # pelo servidor (rode "npm run dev" em server/ antes)
```

Abre um Chromium sem janela com a extensão e duas abas do YouTube na mesma sala. Com `SERVER`, abre dois navegadores separados, como dois PCs, e testa também a queda e a volta da conexão. Mede a diferença entre elas em: entrar na sala, play, seek, deriva, pause, contagem, anúncio simulado e troca de vídeo. As capturas ficam em `tools/out/`, junto com o registro de eventos das duas abas quando algum cenário falha.

Limite do teste: no Chromium sem janela, o YouTube não carrega depois de um pulo longo (para 30% do vídeo, por exemplo), nem sem a extensão. Por isso o teste de seek volta só 10 s.

O teste usa o Chromium do Playwright em `%LOCALAPPDATA%\ms-playwright\chromium-1243`. Para usar outro, defina a variável `CHROMIUM` com o caminho do executável.

## Arquivos

- `manifest.json`: Manifest V3.
- `src/content.js`: roda na página do YouTube; controla o vídeo, a linha do tempo, as esperas e o status no player.
- `src/page-bridge.js`: roda no contexto da própria página e faz play, pause e seek pela API do player do YouTube. Mexer no `<video>` por baixo do player faz o YouTube achar que travou e recarregar o vídeo do zero.
- `src/background.js`: guarda quem está em cada sala e repassa as mensagens por WebSocket até o servidor (ou entre abas, no modo local), com reconexão e acerto de relógio.
- `server/`: o Worker da Cloudflare.
- `popup/`: janela do ícone.
- `tools/gen-icons.mjs`: gera os ícones; `tools/test-sync.mjs`: teste de ponta a ponta.
