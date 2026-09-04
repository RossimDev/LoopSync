# YouTube no LoopSync — guia de configuração

Este guia leva você do zero (sem projeto no Google Cloud) até o **primeiro
vídeo publicado** usando o módulo YouTube do LoopSync.

O módulo usa a **YouTube Data API v3 real** — não há modo de simulação no
produto. O único "Google falso" do repositório é `scripts/mock-google.js`,
usado exclusivamente pelos testes automatizados.

> Tempo estimado: 15–25 minutos (a maior parte é esperar o Google Cloud).

---

## Índice

1. [Pré-requisitos](#1-pré-requisitos)
2. [Criar o projeto no Google Cloud](#2-criar-o-projeto-no-google-cloud)
3. [Habilitar a YouTube Data API v3](#3-habilitar-a-youtube-data-api-v3)
4. [Configurar a tela de consentimento OAuth](#4-configurar-a-tela-de-consentimento-oauth)
5. [Criar as credenciais OAuth 2.0](#5-criar-as-credenciais-oauth-20)
6. [Definir as variáveis de ambiente](#6-definir-as-variáveis-de-ambiente)
7. [Rodar o LoopSync](#7-rodar-o-loopsync)
8. [Primeiro upload, passo a passo](#8-primeiro-upload-passo-a-passo)
9. [Onde ficam os seus dados](#9-onde-ficam-os-seus-dados)
10. [Segurança](#10-segurança)
11. [Cotas e limites da API](#11-cotas-e-limites-da-api)
12. [Erros comuns e soluções](#12-erros-comuns-e-soluções)
13. [Testes automatizados](#13-testes-automatizados)
14. [Publicando em produção](#14-publicando-em-produção)
15. [O que a API permite (e o que não permite)](#15-o-que-a-api-permite-e-o-que-não-permite)

---

## 1. Pré-requisitos

| Item | Detalhe |
| --- | --- |
| Node.js | 18 ou superior (recomendado 20+) — usa `fetch` nativo |
| Conta Google | com **um canal do YouTube já criado** (conta sem canal retorna `youtubeSignupRequired`) |
| ffmpeg | já vem resolvido pelos pacotes `@ffmpeg-installer/ffmpeg` e `@ffprobe-installer/ffprobe` |
| Servidor | o módulo YouTube **exige o backend do LoopSync** (`npm start`). Em hospedagem puramente estática (ex.: Vercel sem funções) a aba YouTube mostra as instruções de instalação |
| HTTPS em produção | o Google só aceita `http://localhost` sem TLS; domínios públicos precisam de `https://` |

---

## 2. Criar o projeto no Google Cloud

1. Acesse <https://console.cloud.google.com/> e faça login com a conta Google
   **dona do canal** (ou uma conta com permissão no canal).
2. No seletor de projetos (topo da página) clique em **Novo projeto**.
3. Nome: `LoopSync` (ou o que preferir). Clique em **Criar**.
4. Aguarde a criação e **selecione o projeto** no seletor do topo.
5. Em **Faturamento** (*Billing*) não é necessário vincular cartão para a
   cota gratuita da YouTube Data API v3.

Anote o **ID do projeto** (ex.: `loopsync-412307`) — ele aparece no prefixo do
seu Client ID.

---

## 3. Habilitar a YouTube Data API v3

1. Menu **APIs e serviços → Biblioteca**.
2. Busque **YouTube Data API v3**.
3. Clique em **Ativar** (*Enable*).
4. Confirme em **APIs e serviços → APIs ativadas** que a
   *YouTube Data API v3* aparece na lista.

> Sem essa etapa o upload falha com `403 accessNotConfigured`.

---

## 4. Configurar a tela de consentimento OAuth

1. **APIs e serviços → Tela de permissão OAuth** (*OAuth consent screen*).
2. **User type**: escolha **Externo** (contas Google comuns) e clique em Criar.
3. Preencha:
   - **Nome do app**: `LoopSync`
   - **E-mail de suporte**: o seu e-mail
   - **Domínios autorizados**: deixe em branco para uso local; em produção
     informe o seu domínio (ex.: `seudominio.com`)
   - **E-mail de contato do desenvolvedor**: o seu e-mail
4. Em **Escopos** (*Scopes*) clique em **Adicionar ou remover escopos** e
   marque exatamente estes (são os que o LoopSync solicita):

   | Escopo | Para que serve |
   | --- | --- |
   | `openid` | identificador estável da conta |
   | `.../auth/userinfo.email` | e-mail exibido na conexão |
   | `.../auth/youtube.force-ssl` | upload, playlists e miniatura personalizada |
   | `.../auth/youtube.readonly` | canal, categorias e playlists |
   | `.../auth/youtube.upload` | envio dos vídeos |

5. Em **Público** (*Audience*) adicione **usuários de teste** — todos os
   e-mails Google que vão usar o app enquanto ele estiver em modo *Testing*
   (limite: 100 usuários).
6. **Salvar**.

**Importante sobre o modo de publicação:**

- Em **Testing**, o app mostra o aviso *"Google hasn't verified this app"* —
  é esperado. Clique em **Continuar**. Os tokens de teste **expiram a cada 7
  dias** (basta reconectar).
- Em **Production**, escopos restritos como `youtube.force-ssl` exigem
  **verificação do app** (e, para alguns casos, auditoria). Enquanto você usa
  o LoopSync no seu próprio canal, o modo *Testing* + o seu e-mail como
  usuário de teste é suficiente.

---

## 5. Criar as credenciais OAuth 2.0

1. **APIs e serviços → Credenciais → Criar credenciais → ID do cliente OAuth**.
2. **Tipo de aplicação**: **Aplicativo da Web** (*Web application*).
3. **Nome**: `LoopSync Web`.
4. **URIs de redirecionamento autorizados** (*Authorized redirect URIs*) —
   adicione **todos** os endereços que você vai usar. O caminho é sempre o
   mesmo: `/api/youtube/auth/callback`.

   | Cenário | URI de redirecionamento |
   | --- | --- |
   | Desenvolvimento local | `http://localhost:3000/api/youtube/auth/callback` |
   | Local via IP (testar no celular) | `http://192.168.0.10:3000/api/youtube/auth/callback` |
   | Produção | `https://seudominio.com/api/youtube/auth/callback` |
   | Porta diferente | `http://localhost:8080/api/youtube/auth/callback` |

   > O Google compara o URI **literalmente**: protocolo, host, porta e caminho
   > precisam ser idênticos. Qualquer diferença gera `redirect_uri_mismatch`.

5. Clique em **Criar**. A janela mostra o **Client ID** e o **Client secret** —
   copie os dois agora (o secret pode ser reexibido depois em *Credenciais*).

---

## 6. Definir as variáveis de ambiente

O modelo pronto está em [`.env.example`](../.env.example). As duas variáveis
obrigatórias são:

```bash
GOOGLE_CLIENT_ID=000000000000-xxxxxxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxxxxxxxxxxxxxxxxxxxxxxx
```

Opcional (recomendado em produção):

```bash
GOOGLE_REDIRECT_URI=https://seudominio.com/api/youtube/auth/callback
LOOPSYNC_COOKIE_SECURE=1
```

Sem `GOOGLE_REDIRECT_URI` o LoopSync **deriva** o URI da origem da requisição
(`x-forwarded-proto` / `x-forwarded-host` quando atrás de proxy) — prático em
desenvolvimento, mas em produção defina explicitamente.

Caso especial: se o servidor alcança o Google por um endereço interno (proxy
corporativo, rede privada ou uma demo com endpoints simulados) mas o navegador
precisa de uma URL pública, defina também `GOOGLE_PUBLIC_AUTH_BASE` — ela é
usada **apenas** na URL de autorização aberta no navegador; a troca de código,
o refresh e a revogação continuam usando `GOOGLE_AUTH_BASE`.

### Formas de carregar

**a) Exportar no shell (Linux/macOS):**

```bash
export GOOGLE_CLIENT_ID="000000000000-xxxx.apps.googleusercontent.com"
export GOOGLE_CLIENT_SECRET="GOCSPX-xxxx"
npm start
```

**b) Arquivo `.env` carregado antes de iniciar:**

```bash
cp .env.example .env      # edite com os seus valores
set -a; . ./.env; set +a  # bash/zsh: exporta tudo do arquivo
npm start
```

**c) Windows (PowerShell):**

```powershell
$env:GOOGLE_CLIENT_ID="000000000000-xxxx.apps.googleusercontent.com"
$env:GOOGLE_CLIENT_SECRET="GOCSPX-xxxx"
npm start
```

**d) PM2 / systemd / Docker:** coloque as variáveis no arquivo de ambiente do
serviço (`ecosystem.config.js`, `Environment=` na unit, `-e` no `docker run`).
Nunca coloque os valores no código nem no front-end.

---

## 7. Rodar o LoopSync

```bash
npm install
npm start
```

Saída esperada:

```
LoopSync server listening on http://0.0.0.0:3000
```

Se as credenciais estiverem ausentes você verá:

```
YouTube: credenciais Google ausentes — defina GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET (docs/YOUTUBE_SETUP.md).
```

Nesse caso a aba YouTube mostra um painel de configuração em vez do botão de
conectar. Abra `http://localhost:3000`, clique em **YouTube** na navegação.

Verificação rápida (sem navegador):

```bash
curl -s http://localhost:3000/api/youtube/status | head -c 400
# {"ok":true,"configured":true,"canUpload":true,...}
```

---

## 8. Primeiro upload, passo a passo

1. **Conectar**
   Aba **YouTube → Enviar → Conectar canal do YouTube**. Uma janela mostra o
   que será solicitado; clique em **Conectar com o Google**.
   Você é levado ao Google, escolhe a conta, vê o aviso de app não verificado
   (modo *Testing*) → **Continuar** → **Permitir**.
   O navegador volta para `#/youtube?yt=connected` e o topo passa a mostrar
   **nome do canal + avatar + status conectado**.

2. **Selecionar o vídeo**
   Toque em **Escolher vídeos** (ou arraste arquivos para a área). A fila
   mostra nome, tamanho, duração, formato e resolução. Selecione quantos
   quiser — cada vídeo tem a sua configuração, e tags/descrição/privacidade
   podem ser compartilhadas entre eles.
   *Dica:* um vídeo gerado pelo próprio LoopSync aparece como opção
   **"Usar resultado do LoopSync"** — o arquivo já está no servidor e o envio
   é feito sem novo upload do navegador.

3. **Aplicar um template (opcional)**
   Em **Modelo**, escolha um dos templates prontos (Música, Tutorial, Vlog,
   Gaming, Podcast, Curso). Ele preenche descrição, tags e título com
   placeholders resolvidos a partir do nome do arquivo.

4. **Descrição**
   Use **Descrições salvas** para carregar uma descrição da biblioteca. O
   conteúdo é **copiado** para o vídeo — editar aqui **não altera** a versão
   salva (a interface marca como *editada*). O contador mostra
   `x/5000`.

5. **Tags**
   Adicione digitando e pressionando Enter/vírgula, remova no ✕, edite no
   ícone de lápis e reordene com ‹ › (ou arrastando). **Tags salvas** soma um
   conjunto da biblioteca às tags atuais. **Gerar sugestões** analisa título,
   assunto e descrição e oferece palavras-chave — nada é adicionado
   automaticamente; você clica no que quiser. Limite: 500 caracteres no total.

6. **Título**
   Editável, com contador `x/100`.

7. **Categoria, privacidade e playlist**
   - Privacidade: **Público**, **Não listado** ou **Privado**.
   - Categoria: lista real vinda de `videoCategories.list` do seu país.
   - Playlist: playlists reais do canal conectado (`playlists.list`); o vídeo é
     adicionado com `playlistItems.insert` depois do upload.

8. **Miniatura (opcional)**
   Envie uma imagem (JPEG/PNG, ~1280×720, ≤ 2 MB) ou use **Capturar quadro do
   vídeo**. A prévia aparece antes do envio; o upload da imagem usa
   `thumbnails.set` — requer **canal verificado** no YouTube.

9. **Revisar**
   Clique em **Revisar e enviar**. A tela de revisão mostra título, descrição,
   tags, categoria, privacidade, playlist, idioma, "conteúdo para crianças" e
   miniatura — tudo ainda editável (**Voltar e editar**).

10. **Enviar**
    **Enviar para o YouTube** inicia o upload resumível. Você vê a porcentagem,
    a velocidade, o status (`Enviando` → `Processando` → `Concluído`) e pode
    **cancelar**. Se a conexão cair, o envio retoma do último byte confirmado
    pelo Google (não recomeça do zero).

11. **Concluído**
    O cartão final mostra título, miniatura, **ID do vídeo**, o link e o botão
    **Abrir no YouTube**. O registro fica em **Histórico** com data, canal,
    privacidade, status e link.

---

## 9. Onde ficam os seus dados

| Conteúdo | Local |
| --- | --- |
| Banco local (conexão, descrições salvas, conjuntos de tags, templates, uploads/histórico) | `data/loopsync-store.json` (JSON, escrita atômica via arquivo temporário + `rename`) |
| Tokens de acesso/renovação | **somente no servidor**, dentro do mesmo arquivo, nunca enviados ao navegador |
| Arquivos temporários do LoopSync | apagados após o processamento/download |
| Miniaturas pendentes de envio | mantidas em memória/até a conclusão do job |

Para mudar o local do banco:

```bash
LOOPSYNC_DATA_DIR=/var/lib/loopsync npm start
```

**Backup:** copie `data/loopsync-store.json`. **Migração:** pare o servidor,
copie o arquivo para a nova máquina no mesmo caminho, inicie novamente.

**Isolamento por usuário:** cada registro tem um `ownerId`. Antes de conectar,
o dono é um perfil local (cookie httpOnly `loopsync_profile`); ao conectar, os
dados migram para `google_<id da conta>` e passam a ser visíveis apenas para
essa conta. IDs de outros usuários retornam `404`.

---

## 10. Segurança

O que o módulo **faz**:

- OAuth 2.0 **com PKCE (S256)** e `state` anti-CSRF; `access_type=offline` para
  receber refresh token.
- Guarda `access_token`/`refresh_token` **apenas no servidor**, associados ao
  `ownerId`; renova automaticamente quando expiram (inclusive no meio de um
  upload).
- Usa cookie de sessão **httpOnly** (e `Secure` quando
  `LOOPSYNC_COOKIE_SECURE=1`).
- Valida tamanho de bloco, tipo de arquivo, metadados e limites oficiais
  (título 100, descrição 5000, tags 500 caracteres).
- Ao **desconectar**, chama `token.revoke` no Google e apaga as credenciais do
  banco local.
- Mapeia erros do Google para mensagens em português, sem vazar corpo bruto de
  resposta.

O que o módulo **nunca faz**:

- Nunca pede, recebe ou armazena a **senha do Google**.
- Nunca expõe `GOOGLE_CLIENT_SECRET`, tokens, refresh tokens ou credenciais em
  respostas de API, logs, URLs ou no front-end (existe teste automatizado que
  varre todas as respostas procurando esses valores).
- Nunca coloca segredos em parâmetros de URL — o navegador só recebe a URL de
  autorização pública do Google.

---

## 11. Cotas e limites da API

A cota padrão é **10.000 unidades por dia por projeto** (reinicia à
meia-noite no horário do Pacífico).

| Operação | Unidades |
| --- | --- |
| `videos.insert` (upload) | **1600** |
| `thumbnails.set` (miniatura) | 50 |
| `playlistItems.insert` (adicionar à playlist) | 50 |
| `channels.list`, `playlists.list`, `videoCategories.list`, `videos.list` | 1 cada |

Na prática: ~6 uploads/dia com miniatura e playlist, ou ~6 uploads/dia sem
extras (1600 + 100 ≈ 1700 por vídeo completo).

Outros limites do YouTube:

- Vídeo: até **128 GB** ou **12 horas** (o que for menor).
- Título: 100 caracteres. Descrição: 5000 caracteres. Tags: 500 caracteres no
  total (vírgulas separam tags).
- Miniatura personalizada: exige **canal verificado** (telefone) — sem isso a
  API retorna `403 forbidden`.

---

## 12. Erros comuns e soluções

| Erro / sintoma | Causa | Solução |
| --- | --- | --- |
| `redirect_uri_mismatch` | URI de redirecionamento não cadastrado ou diferente (porta/protocolo/caminho) | Cadastre o URI exato em *Credenciais → ID do cliente → URIs de redirecionamento autorizados* e aguarde ~5 min |
| `access_denied` | Você cancelou a autorização | Nada foi alterado; tente novamente |
| `invalid_client` / `unauthorized_client` | Client ID/secret erros ou tipo de aplicação incorreto | Confira as variáveis; o tipo deve ser **Aplicativo da Web** |
| `403 accessNotConfigured` | YouTube Data API v3 não habilitada | Etapa 3 |
| `invalid_grant` | Código reutilizado/expirado, ou redirect diferente entre autorização e troca | Reconecte; garanta o mesmo `GOOGLE_REDIRECT_URI` |
| `youtubeSignupRequired` | Conta Google sem canal no YouTube | Crie o canal em youtube.com e reconecte |
| `quotaExceeded` (403) | Cota diária esgotada | Aguarde a virada do dia ou solicite aumento de cota |
| `rateLimitExceeded` (429) | Muitas chamadas em sequência | O módulo já tenta de novo com backoff; reduza o volume |
| Vídeo voltou como **Privado** e não pode ser alterado | Projeto novo em **modo de upload privado** (política do YouTube para projetos não auditados) | Envie o formulário de auditoria da API (`youtube.third-party-link.creator`) ou use um projeto já auditado |
| `forbidden` ao enviar miniatura | Canal não verificado | Verifique o canal com telefone no YouTube Studio |
| Token expirou após 7 dias | App em modo *Testing* | Reconecte, ou publique o app em *Production* (com verificação) |
| Aba YouTube pede o servidor | Página estática sem backend | Rode `npm start` e acesse pela porta do servidor |

---

## 13. Testes automatizados

```bash
npm test                  # pipeline de mídia do LoopSync (ffmpeg) — 5 cenários
npm run test:youtube      # integração backend + API do Google (mock) — 41 verificações
npm run test:youtube:ui   # interface React real em jsdom, fluxo completo — 122 verificações
npm run test:youtube:browser  # E2E em Chromium (Puppeteer) — layout e responsividade
npm run test:all          # mídia + integração + interface
```

O que cada um cobre:

- **`test:youtube`** — OAuth com PKCE, dados do canal, categorias e playlists,
  CRUD de descrições/conjuntos de tags, sugestões de tags, upload resumível
  (blocos, retomada, sessão expirada, refresh de token no meio do envio,
  divergência de offset, cancelamento, fila em lote), envio de resultado
  gerado pelo LoopSync direto do servidor, isolamento por usuário, revogação e
  ausência de segredos nas respostas, e o comportamento sem credenciais.
- **`test:youtube:ui`** — renderiza o `App` real (React + motion) em jsdom
  contra o servidor real e o mock do Google, e percorre pela interface:
  navegação, conexão, biblioteca (criar, **editar, duplicar e excluir**
  descrições e conjuntos de tags), seleção de arquivo com metadados, recusa de
  arquivo que não é vídeo, template, descrição salva + edição + **atualizar a
  salva**, tags salvas, sugestões (sem auto-aplicação, seleção individual,
  **adicionar todas** e **limpar**), edição/reordenação/remoção de tag,
  **qual conjunto atualizar** quando há mais de uma origem, contador de título,
  privacidade/categoria/playlist, **miniatura** (prévia, remoção e recusa de
  arquivo que não é imagem), revisão, envio com progresso, conclusão com ID e
  link, histórico, **lote** (fila, aplicar descrição/tags/configurações a
  todos, remover da fila, modal da fila, envio em sequência com
  miniatura/playlist), **preservação da fila e de uploads em andamento ao
  trocar de aba e de área**, desconexão e retorno ao fluxo LoopSync — além de
  checar erros no console. Roda em qualquer ambiente (não exige navegador).
- **`test:youtube:browser`** — mesmo roteiro em Chromium headless com capturas
  de tela e verificação de layout em viewport mobile (390×844) e desktop
  (1440×900). Requer Chromium no ambiente (GitHub Actions, por exemplo).

Os três usam `scripts/mock-google.js`, que implementa OAuth + endpoints da
YouTube Data API v3 (canais, categorias, playlists, upload resumível,
miniaturas, revogação) apenas para testes.

---

## 14. Publicando em produção

1. **HTTPS obrigatório** — o Google não aceita redirect `http://` fora de
   `localhost`. Use um proxy (Nginx/Caddy) ou um host com TLS.
2. **Defina `GOOGLE_REDIRECT_URI`** com o domínio final.
3. **`LOOPSYNC_COOKIE_SECURE=1`** para cookies `Secure`.
4. **Proxy reverso** — o servidor já tem `trust proxy` habilitado e lê
   `x-forwarded-proto`/`x-forwarded-host`; repasse esses cabeçalhos.
5. **Persistência** — o banco é um arquivo JSON em `LOOPSYNC_DATA_DIR`. Monte
   um volume/disco persistente. **Não rode múltiplas instâncias** apontando
   para pastas diferentes: a sessão do usuário precisa encontrar o mesmo
   arquivo (se precisar escalar horizontalmente, use sticky sessions ou migre
   o store para um banco compartilhado).
6. **Uploads grandes** — o corpo é processado em blocos (2/5/8 MB do
   navegador, limite de 16 MB por bloco no servidor via
   `LOOPSYNC_YT_MAX_CHUNK_BYTES`). Ajuste `client_max_body_size` do Nginx para
   ≥ 16 MB e os timeouts do proxy para ≥ 120 s.
7. **Segredos** — use o gerenciador de segredos do host; nunca versione o
   `.env`.

Exemplo com systemd:

```ini
[Service]
WorkingDirectory=/opt/loopsync
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=GOOGLE_CLIENT_ID=000000000000-xxxx.apps.googleusercontent.com
Environment=GOOGLE_CLIENT_SECRET=GOCSPX-xxxx
Environment=GOOGLE_REDIRECT_URI=https://seudominio.com/api/youtube/auth/callback
Environment=LOOPSYNC_DATA_DIR=/var/lib/loopsync
Environment=LOOPSYNC_COOKIE_SECURE=1
ExecStart=/usr/bin/node server.js
Restart=always
```

---

## 15. O que a API permite (e o que não permite)

**Implementado no módulo (tudo via API real):**

- Conexão/desconexão OAuth 2.0 com dados do canal (nome, avatar, status).
- Upload resumível de vídeos com progresso, retomada e cancelamento.
- Título, descrição, tags, categoria, idioma, privacidade,
  "conteúdo para crianças", notificação de inscritos.
- Miniatura personalizada (`thumbnails.set`) com prévia.
- Playlists do canal (`playlists.list` + `playlistItems.insert`).
- Histórico de uploads com status (`videos.list`: `Aguardando`, `Enviando`,
  `Processando`, `Concluído`, `Erro`, `Cancelado`).
- Fila/lote com configuração por vídeo e metadados compartilhados.
- Envio direto do servidor de um resultado gerado pelo LoopSync.

**Aceito pelo backend, ainda sem campo na interface:**

- Agendamento de publicação (`publishAt` — exige `privacyStatus=public`, e o
  vídeo é criado como privado até o horário).
- Licença alternativa (`status.license`).

**Não suportado pela YouTube Data API v3** (só no YouTube Studio, portanto
fora do módulo — sem simulação):

- Telas finais (*end screens*) e cards.
- Monetização, anúncios e direitos autorais.
- Comentários, moderação e publicação na aba Comunidade.
- Legendas/carregamento de subtítulos (exigem app auditado).
- Bloqueio por país/restrições avançadas de incorporação.
- Transmissões ao vivo (`liveBroadcasts`) — o módulo trata vídeos gravados.

Quando um recurso não existe na API, a interface simplesmente não o oferece:
nenhum botão "de mentira" é exibido.

---

## Checklist rápido

- [ ] Projeto criado no Google Cloud
- [ ] YouTube Data API v3 ativada
- [ ] Tela de consentimento configurada + escopos + usuário de teste
- [ ] Credencial OAuth **Web** criada
- [ ] URIs de redirecionamento cadastrados (todos os que você usa)
- [ ] `GOOGLE_CLIENT_ID` e `GOOGLE_CLIENT_SECRET` no ambiente do servidor
- [ ] `npm install && npm start`
- [ ] Canal conectado (nome + avatar visíveis)
- [ ] Primeiro vídeo enviado e aberto no YouTube
- [ ] `data/loopsync-store.json` incluído na sua rotina de backup
