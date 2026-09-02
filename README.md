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

- Frontend: HTML / CSS / JavaScript puro (sem framework pesado).
- Backend (opcional): Node.js + Express.
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

## Como rodar

```bash
npm install
npm start
```

O servidor abre em `http://localhost:3000` e serve o app.

## Deploy na Vercel

O repositório já contém `vercel.json` configurado (build `npm run build`,
saída `public/`). O build copia o ffmpeg.wasm dos pacotes npm para
`public/vendor/`, então o site não depende de nenhum CDN externo.

1. Acesse [vercel.com/new](https://vercel.com/new) e importe o repositório
   `RossimDev/LoopSync`;
2. Não é preciso alterar nada (framework: *Other*) — clique em **Deploy**.

Na Vercel o processamento roda com ffmpeg.wasm no navegador do usuário
(uploads para funções serverless são limitados a ~4,5 MB, então processar no
dispositivo é a única arquitetura viável — e também a mais privada).

## Testes

A validação gera vídeos e áudios sintéticos reais e executa o pipeline
completo de ffmpeg, conferindo que cada MP4 gerado é válido e que a duração
final coincide com a do áudio.

```bash
npm test
```

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
public/                     # interface do usuário
scripts/make-test-assets.js # gera mídia de teste sintética
scripts/validate.js         # validação automatizada dos 4 cenários
```
