# LoopSync

LoopSync junta **vídeo ou foto + música** automaticamente, em um item ou em lote:

1. Você escolhe um vídeo (ou uma foto) e um arquivo de áudio/música.
2. O app descobre duração e resolução dos arquivos.
3. O vídeo é repetido quantas vezes forem necessárias; a foto permanece fixa.
4. O resultado termina **exatamente** no ponto em que o áudio termina.
5. O app gera um **MP4 real**, nomeado a partir do áudio, com a música como
   única trilha sonora e duração **exatamente igual** à duração do áudio.

Nenhuma edição criativa é feita no vídeo: apenas *repetir → repetir →
cortar o final quando necessário*. Sem filtros, transições, zoom, textos,
watermarks, beat sync ou qualquer efeito.

## Funcionamento

- **Vídeo mais curto que o áudio:** loop automático até cobrir o áudio e o
  último loop é cortado no ponto correto.
- **Vídeo mais longo que o áudio:** nenhuma repetição; apenas os primeiros N
  segundos do vídeo são usados.
- **Vídeo com a mesma duração do áudio:** usado uma única vez, sem repetição.
- **Foto:** vira um vídeo fixo com a duração do áudio; é possível manter a
  resolução original ou escolher formatos horizontais, verticais, quadrados e
  personalizados (sem esticar ou cortar a imagem).
- **Qualidade:** antes de criar você escolhe a qualidade do **vídeo**
  (automática/cópia do original, ou recodificação por CRF) e do **áudio**
  (bitrate AAC de 96 a 320 kbps) — vale para o modo único e para o lote.
- **Modo Em massa:** combina vários vídeos/fotos e áudios, gera a fila
  sequencialmente e permite baixar ou enviar todos para o YouTube.
- **Vídeo com áudio próprio:** o áudio original **não** é usado; o arquivo de
  áudio escolhido pelo usuário é a trilha final.
- **Duração final:** sempre igual à duração do áudio.
- **Nome final:** deriva do nome de cada áudio, com sanitização Unicode e
  sufixos `(2)`, `(3)` etc. quando há colisões.

## Tecnologia

- Frontend: **React 19 + Vite** (`src/`), com animações em
  [`motion`](https://motion.dev/) e CSS próprio (mobile-first).
- Backend: Node.js + Express (`server.js`) — necessário para o ffmpeg nativo e
  para o módulo YouTube.
- Processamento de mídia: **ffmpeg** via
  [`@ffmpeg-installer/ffmpeg`](https://www.npmjs.com/package/@ffmpeg-installer/ffmpeg)
  e [`@ffprobe-installer/ffprobe`](https://www.npmjs.com/package/@ffprobe-installer/ffprobe)
  no modo servidor, ou **ffmpeg.wasm** (`@ffmpeg/ffmpeg` + `@ffmpeg/core`)
  direto no navegador no modo estático.

### Dois modos de processamento

O app detecta automaticamente onde está rodando (via `/health`):

- **Modo servidor** (`npm start`): o Express processa com ffmpeg nativo —
  rápido e sem limite prático de tamanho de arquivo.
- **Modo estático / Vercel**: sem backend, o processamento acontece
  **100% no navegador do usuário** com ffmpeg.wasm. Os arquivos nunca saem
  do dispositivo — privacidade máxima.

Nos dois modos a operação é equivalente:

1. recebe temporariamente os arquivos selecionados;
2. descobre duração, streams e resolução (com `ffprobe` no servidor);
3. para vídeo, usa `-stream_loop` quando necessário; para foto, cria um stream
   fixo de 30 fps e aplica a resolução escolhida com *scale + pad*;
4. encerra o resultado no tempo exato do áudio com `-t`;
5. mapeia somente o visual (`0:v:0`) e o áudio escolhido (`1:a:0`);
6. exporta em MP4 (`-c:v copy` quando possível para vídeos, ou `libx264` + AAC
   com a qualidade escolhida — CRF do vídeo e bitrate do áudio);
7. apaga os arquivos temporários depois do processamento/download.

### Privacidade

- Não há conta, login ou cadastro.
- Nenhum arquivo é enviado para um serviço externo de terceiros.
- Os arquivos temporários são removidos depois do processamento/download.
- O resultado é baixado e compartilhado pelo usuário.
- No módulo **YouTube** a única integração externa é com o Google, sempre por
  OAuth 2.0 iniciado por você: o LoopSync nunca pede ou guarda a sua senha do
  Google, e os tokens ficam só no servidor (veja
  [docs/YOUTUBE_SETUP.md](docs/YOUTUBE_SETUP.md)).

## YouTube: envio direto para o seu canal

Além de gerar o vídeo, o LoopSync publica: a aba **YouTube** conecta o seu
canal por OAuth 2.0 e faz o upload real pela **YouTube Data API v3**.

**Fluxo principal**

```
LoopSync → YouTube → conectar canal → selecionar vídeo → modelo (template)
→ descrição → tags → título → categoria/privacidade/playlist → miniatura
→ revisar → enviar → progresso → concluído → abrir no YouTube
```

**O que dá para fazer**

- **Conexão do canal:** nome, avatar, status e desconexão (com revogação do
  token no Google).
- **Seleção de vídeo:** nome, tamanho, duração, formato, resolução e fila para
  **envio em lote** — configuração por vídeo com tags/descrição/privacidade
  compartilhadas. Também dá para enviar direto o resultado gerado pelo
  LoopSync, sem novo upload do navegador.
- **Título** editável com contador (100 caracteres).
- **Descrição** carregável da biblioteca de *descrições salvas* e editável
  antes do envio sem alterar a versão salva (5000 caracteres).
- **Tags** com adicionar, remover, editar e reordenar (500 caracteres),
  **conjuntos de tags salvos** e **Gerar sugestões** — que analisa título,
  assunto e descrição e só adiciona o que você clicar.
- **Modelos (templates)** prontos aplicáveis ao envio.
- **Configurações:** privacidade (Público / Não listado / Privado), categoria
  e playlist reais do canal, miniatura própria com prévia (inclusive capturando
  um quadro do vídeo).
- **Revisão** de todos os metadados antes de enviar, ainda editável.
- **Upload resumível** com porcentagem, velocidade, cancelamento e retomada
  automática após queda de conexão, timeout, token expirado ou sessão vencida.
- **Histórico de uploads** com miniatura, título, data, status (Aguardando,
  Enviando, Processando, Concluído, Erro, Cancelado), canal, privacidade e
  link.

O módulo exige o servidor do LoopSync (`npm start`), porque o *client secret*
e os tokens nunca podem ir para o navegador. Em hospedagem estática a aba
YouTube mostra as instruções de instalação.

**Configuração (Google Cloud, credenciais, redirect URI, primeiro upload):**
👉 [docs/YOUTUBE_SETUP.md](docs/YOUTUBE_SETUP.md) — com checklist, cotas da
API, erros comuns e deploy em produção. Modelo de variáveis em
[`.env.example`](.env.example).

## Como rodar

```bash
npm install
npm start
```

O servidor abre em `http://localhost:3000` e serve o app.

Para habilitar o módulo **YouTube**, defina as credenciais OAuth do Google
antes de iniciar (guia completo em
[docs/YOUTUBE_SETUP.md](docs/YOUTUBE_SETUP.md)):

```bash
cp .env.example .env      # edite com o seu Client ID/Secret
set -a; . ./.env; set +a
npm start
```

## Deploy na Vercel

O repositório já contém `vercel.json` configurado (build `npm run build`,
saída `dist/`). O build copia o ffmpeg.wasm dos pacotes npm para
`static/vendor/` (publicado em `dist/vendor/`), então o site não depende de
nenhum CDN externo.

1. Acesse [vercel.com/new](https://vercel.com/new) e importe o repositório
   `RossimDev/LoopSync`;
2. Não é preciso alterar nada (framework: *Other*) — clique em **Deploy**.

Na Vercel o processamento roda com ffmpeg.wasm no navegador do usuário
(uploads para funções serverless são limitados a ~4,5 MB, então processar no
dispositivo é a única arquitetura viável — e também a mais privada).

Nesse modo estático **o módulo YouTube fica indisponível** (ele precisa do
servidor Node para guardar o *client secret* e os tokens). A aba YouTube
mostra as instruções de instalação; para publicar no YouTube, hospede o
LoopSync com `npm start` em um host Node com HTTPS — veja
[docs/YOUTUBE_SETUP.md](docs/YOUTUBE_SETUP.md#14-publicando-em-produção).

## Testes

A validação gera vídeos e áudios sintéticos reais e executa o pipeline
completo de ffmpeg, conferindo que cada MP4 gerado é válido e que a duração
final coincide com a do áudio.

```bash
npm test                     # pipeline de mídia: 10 cenários + utilitários CJS/ESM
npm run test:loopsync:ui     # interface principal + servidor + ffmpeg reais: 70 verificações
npm run test:youtube         # integração do YouTube + API do Google: 41 verificações
npm run test:youtube:ui      # interface completa do YouTube: 129 verificações
npm run test:youtube:browser # E2E em Chromium (layout mobile/desktop + capturas)
npm run test:all             # mídia + ambas as integrações e interfaces
```

### Pipeline de mídia

São verificados cinco cenários de vídeo (repetição, corte e duração igual) e
cinco cenários de foto: PNG/JPG na resolução original, saída vertical
1080×1920, quadrada 1080×1080 e tamanho personalizado normalizado para lados
pares. Todos passam por ffmpeg e ffprobe reais.

## Estrutura

```
server.js                   # servidor Express + endpoints de processamento
lib/media.js                # núcleo de mídia (ffprobe + ffmpeg + foto/vídeo)
lib/image-size.js           # resolução de foto (CJS; espelho ESM em src/lib)
lib/quality.js              # presets de qualidade (CJS; espelho ESM em src/lib)
lib/naming.js               # nomes/Content-Disposition (CJS; espelho ESM)
lib/store.js                # banco local em JSON (sessões, conexão, bibliotecas, uploads)
lib/youtube/client.js       # OAuth 2.0 (PKCE) + YouTube Data API v3
lib/youtube/resumable.js    # motor de upload resumível (blocos, retomada, retries)
lib/youtube/routes.js       # rotas /api/youtube/*
lib/youtube/tags.js         # sugestões de tags
lib/youtube/templates.js    # modelos prontos de metadados
src/App.jsx                 # fluxo único, fallback wasm, DnD e navegação
src/Batch.jsx               # fila de processamento em massa
src/ImageSizePicker.jsx     # seletor de resolução das fotos
src/QualityPicker.jsx       # seletor de qualidade de áudio e vídeo
src/lib/                    # utilitários ESM compartilhados e motor wasm
src/youtube/                # UI do módulo YouTube (uploader, biblioteca, histórico, conexão)
docs/YOUTUBE_SETUP.md       # guia de configuração do Google Cloud + primeiro upload
.env.example                # modelo de variáveis de ambiente
scripts/make-test-assets.js # gera mídia de teste sintética
scripts/mock-google.js      # mock dos endpoints do Google (somente testes)
scripts/validate.js         # 10 cenários reais + concordância CJS/ESM
scripts/validate-youtube.js # validação do módulo YouTube (backend + API)
scripts/test-loopsync-ui.js # interface principal com servidor/ffmpeg reais
scripts/test-youtube-ui.js  # validação da interface do YouTube em jsdom
scripts/test-youtube-browser.js # E2E em Chromium
```
