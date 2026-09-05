# LoopSync

LoopSync junta **1 vídeo + 1 música** automaticamente:

1. Você escolhe um vídeo e um arquivo de áudio/música.
2. O app descobre as durações dos dois arquivos.
3. O vídeo é repetido quantas vezes forem necessárias para cobrir a duração
   do áudio.
4. O último loop é cortado **exatamente** no ponto em que o áudio termina.
5. O resultado é um **MP4 real**, com a música como única trilha sonora e
   duração **exatamente igual** à duração do áudio.

Nenhuma edição criativa é feita no vídeo: apenas *repetir → repetir →
cortar o final quando necessário*. Sem filtros, transições, zoom, textos,
watermarks, beat sync ou qualquer efeito.

## Funcionamento

- **Vídeo mais curto que o áudio:** loop automático até cobrir o áudio e o
  último loop é cortado no ponto correto.
- **Vídeo mais longo que o áudio:** nenhuma repetição; apenas os primeiros N
  segundos do vídeo são usados.
- **Vídeo com a mesma duração do áudio:** usado uma única vez, sem repetição.
- **Vídeo com áudio próprio:** o áudio original **não** é usado; o arquivo de
  áudio escolhido pelo usuário é a trilha final.
- **Duração final:** sempre igual à duração do áudio.

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

Nos dois modos a operação é idêntica:

1. recebe temporariamente os dois arquivos selecionados;
2. descobre as durações com `ffprobe`;
3. monta a sequência de loop usando `-stream_loop` e encerra o vídeo no tempo
   exato do áudio com `-t`;
4. mapeia somente o vídeo do arquivo de vídeo (`0:v:0`) e o áudio do arquivo
   de áudio (`1:a:0`);
5. exporta em MP4 (`-c:v copy` quando possível, senão `libx264` + AAC);
6. apaga os arquivos temporários assim que o processamento termina e o
   resultado é baixado.

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
npm test                  # pipeline de mídia (ffmpeg): 5 cenários
npm run test:youtube      # integração do módulo YouTube + API do Google: 41 verificações
npm run test:youtube:ui   # interface React real em jsdom, fluxo completo: 129 verificações
npm run test:youtube:browser  # E2E em Chromium (layout mobile/desktop + capturas)
npm run test:all          # mídia + integração + interface
```

### Pipeline de mídia

Cenários verificados:

| Teste | Vídeo | Áudio | Comportamento esperado |
| --- | --- | --- | --- |
| 1 | 15s | 2min | loop até 2min exatos |
| 2 | 30s | 2min15s | 4 loops completos + 15s do quinto |
| 3 | 1min | 20s | corta para os primeiros 20s |
| 4 | 30s | 30s | sem repetição |

## Estrutura

```
server.js                   # servidor Express + endpoints de processamento
lib/media.js                # núcleo de mídia (ffprobe + ffmpeg + validação)
lib/store.js                # banco local em JSON (sessões, conexão, bibliotecas, uploads)
lib/youtube/client.js       # OAuth 2.0 (PKCE) + YouTube Data API v3
lib/youtube/resumable.js    # motor de upload resumível (blocos, retomada, retries)
lib/youtube/routes.js       # rotas /api/youtube/*
lib/youtube/tags.js         # sugestões de tags
lib/youtube/templates.js    # modelos prontos de metadados
src/App.jsx                 # interface (navegação LoopSync / YouTube)
src/youtube/                # UI do módulo YouTube (uploader, biblioteca, histórico, conexão)
docs/YOUTUBE_SETUP.md       # guia de configuração do Google Cloud + primeiro upload
.env.example                # modelo de variáveis de ambiente
scripts/make-test-assets.js # gera mídia de teste sintética
scripts/mock-google.js      # mock dos endpoints do Google (somente testes)
scripts/validate.js         # validação automatizada dos 4 cenários de mídia
scripts/validate-youtube.js # validação do módulo YouTube (backend + API)
scripts/test-youtube-ui.js  # validação da interface em jsdom
scripts/test-youtube-browser.js # E2E em Chromium
```
