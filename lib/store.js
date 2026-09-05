"use strict";

/**
 * LoopSync — camada de persistência.
 *
 * O LoopSync não usa nenhum banco externo: tudo é local e privado. Para o
 * módulo do YouTube foi adicionado um "banco" em arquivo JSON, gravado de
 * forma atômica (arquivo temporário + rename) e serializado por processo,
 * mantendo a mesma filosofia do projeto (zero dependências externas).
 *
 * Coleções:
 *   sessions     — sessão local (cookie httpOnly) -> dono dos dados
 *   authStates   — estado + PKCE de um fluxo OAuth em andamento (curto prazo)
 *   connections  — tokens OAuth e dados do canal do YouTube
 *   descriptions — biblioteca de descrições salvas
 *   tagSets      — conjuntos de tags salvos
 *   uploads      — histórico + estado dos uploads (inclui sessão resumível)
 *   templates    — templates de configuração disponíveis
 *
 * SEGURANÇA: todo acesso é filtrado por `ownerId`. Nenhum método devolve
 * registros de outro dono, e os tokens nunca saem do servidor.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const COLLECTIONS = [
  "descriptions",
  "tagSets",
  "uploads",
  "templates",
  "connections",
];

const MAPS = ["sessions", "authStates"];

const DEFAULT_DATA_DIR = path.join(__dirname, "..", "data");

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 dias
const AUTH_STATE_TTL_MS = 1000 * 60 * 10; // 10 minutos

function nowIso() {
  return new Date().toISOString();
}

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString("hex")}`;
}

class Store {
  /**
   * @param {object} [options]
   * @param {string} [options.dir] diretório onde o banco JSON é gravado
   * @param {string} [options.file] nome do arquivo do banco
   */
  constructor(options = {}) {
    const dir = options.dir || process.env.LOOPSYNC_DATA_DIR || DEFAULT_DATA_DIR;
    this.dir = dir;
    this.file = options.file || path.join(dir, "loopsync-store.json");
    this.data = {
      version: 1,
      createdAt: nowIso(),
      sessions: {},
      authStates: {},
      descriptions: [],
      tagSets: [],
      uploads: [],
      templates: [],
      connections: [],
      profiles: {},
    };
    this.writeQueue = Promise.resolve();
    this.loaded = false;
    fs.mkdirSync(this.dir, { recursive: true });
    this.load();
  }

  /* ── persistência ─────────────────────────────────────────────── */

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = fs.readFileSync(this.file, "utf8");
        const parsed = JSON.parse(raw);
        this.data = { ...this.data, ...parsed };
        for (const key of COLLECTIONS) {
          if (!Array.isArray(this.data[key])) this.data[key] = [];
        }
        for (const key of MAPS) {
          if (!this.data[key] || typeof this.data[key] !== "object") this.data[key] = {};
        }
      }
    } catch (err) {
      // Banco corrompido não pode derrubar o app: mantém cópia e recomeça.
      try {
        fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
      } catch {
        /* ignore */
      }
      console.error("LoopSync store: arquivo inválido, iniciando vazio.", err.message);
    }
    this.loaded = true;
    this.pruneExpired();
  }

  /** Gravação atômica e serializada. */
  persist() {
    this.writeQueue = this.writeQueue.then(() => {
      return new Promise((resolve) => {
        const tmp = `${this.file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
        try {
          fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf8");
          fs.renameSync(tmp, this.file);
        } catch (err) {
          try { fs.unlinkSync(tmp); } catch { /* ignore */ }
          console.error("LoopSync store: falha ao gravar.", err.message);
        }
        resolve();
      });
    });
    return this.writeQueue;
  }

  async flush() {
    await this.persist();
  }

  pruneExpired() {
    const now = Date.now();
    let dirty = false;
    for (const [id, session] of Object.entries(this.data.sessions || {})) {
      if (session.expiresAt && new Date(session.expiresAt).getTime() < now) {
        delete this.data.sessions[id];
        dirty = true;
      }
    }
    for (const [state, value] of Object.entries(this.data.authStates || {})) {
      if (value.expiresAt && new Date(value.expiresAt).getTime() < now) {
        delete this.data.authStates[state];
        dirty = true;
      }
    }
    if (dirty) this.persist();
  }

  /* ── perfis / sessões ─────────────────────────────────────────── */

  /**
   * Cria (ou reaproveita) um perfil local. Enquanto o usuário não conecta uma
   * conta Google, os dados ficam neste perfil do dispositivo; ao conectar, os
   * dados são migrados para o `googleUserId` (veja `migrateOwner`).
   */
  ensureProfile(localId) {
    if (localId && this.data.profiles[localId]) return localId;
    const id = localId || newId("local");
    this.data.profiles[id] = { id, createdAt: nowIso() };
    this.persist();
    return id;
  }

  createSession(ownerId, extra = {}) {
    const id = crypto.randomBytes(32).toString("hex");
    this.data.sessions[id] = {
      id,
      ownerId,
      createdAt: nowIso(),
      expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
      ...extra,
    };
    this.persist();
    return this.data.sessions[id];
  }

  getSession(id) {
    if (!id) return null;
    const session = this.data.sessions[id];
    if (!session) return null;
    if (session.expiresAt && new Date(session.expiresAt).getTime() < Date.now()) {
      delete this.data.sessions[id];
      this.persist();
      return null;
    }
    return session;
  }

  updateSession(id, patch) {
    const session = this.getSession(id);
    if (!session) return null;
    Object.assign(session, patch);
    this.persist();
    return session;
  }

  deleteSession(id) {
    if (this.data.sessions[id]) {
      delete this.data.sessions[id];
      this.persist();
    }
  }

  /* ── estados OAuth (state + PKCE) ─────────────────────────────── */

  createAuthState(payload) {
    const state = crypto.randomBytes(24).toString("base64url");
    this.data.authStates[state] = {
      ...payload,
      createdAt: nowIso(),
      expiresAt: new Date(Date.now() + AUTH_STATE_TTL_MS).toISOString(),
    };
    this.persist();
    return state;
  }

  /** Remove e devolve o estado (uso único). */
  takeAuthState(state) {
    const value = this.data.authStates[state];
    if (!value) return null;
    delete this.data.authStates[state];
    this.persist();
    if (value.expiresAt && new Date(value.expiresAt).getTime() < Date.now()) return null;
    return value;
  }

  /* ── coleções genéricas (sempre escopadas por dono) ───────────── */

  list(collection, ownerId) {
    this.assertCollection(collection);
    return this.data[collection]
      .filter((item) => item.ownerId === ownerId || item.ownerId === null)
      .sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
  }

  listAll(collection, ownerId) {
    this.assertCollection(collection);
    return this.data[collection].filter((item) => item.ownerId === ownerId);
  }

  get(collection, id, ownerId) {
    this.assertCollection(collection);
    return (
      this.data[collection].find(
        (item) => item.id === id && (item.ownerId === ownerId || item.ownerId === null)
      ) || null
    );
  }

  insert(collection, record) {
    this.assertCollection(collection);
    const prefix = collection.slice(0, 3).toLowerCase();
    const created = {
      id: record.id || newId(prefix),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      ...record,
    };
    created.createdAt = record.createdAt || created.createdAt;
    created.updatedAt = nowIso();
    this.data[collection].push(created);
    this.persist();
    return created;
  }

  update(collection, id, ownerId, patch) {
    const item = this.get(collection, id, ownerId);
    if (!item) return null;
    if (item.ownerId === null) return null; // registros públicos (templates) são imutáveis
    Object.assign(item, patch, { id: item.id, ownerId: item.ownerId, updatedAt: nowIso() });
    this.persist();
    return item;
  }

  remove(collection, id, ownerId) {
    this.assertCollection(collection);
    const index = this.data[collection].findIndex(
      (item) => item.id === id && item.ownerId === ownerId
    );
    if (index === -1) return false;
    this.data[collection].splice(index, 1);
    this.persist();
    return true;
  }

  /**
   * Move os dados de um perfil local para o dono definitivo (conta Google),
   * preservando a biblioteca do usuário quando ele conecta o canal.
   */
  migrateOwner(fromOwnerId, toOwnerId) {
    if (!fromOwnerId || !toOwnerId || fromOwnerId === toOwnerId) return 0;
    let moved = 0;
    for (const collection of COLLECTIONS) {
      for (const item of this.data[collection]) {
        if (item.ownerId === fromOwnerId) {
          item.ownerId = toOwnerId;
          moved += 1;
        }
      }
    }
    if (moved) this.persist();
    return moved;
  }

  assertCollection(collection) {
    if (!COLLECTIONS.includes(collection)) {
      throw new Error(`Coleção desconhecida: ${collection}`);
    }
  }

  /* ── conexões YouTube ─────────────────────────────────────────── */

  findConnectionByOwner(ownerId) {
    return (
      this.data.connections.find(
        (item) => item.ownerId === ownerId && !item.disconnectedAt
      ) || null
    );
  }

  findConnectionByGoogleUser(googleUserId) {
    return (
      this.data.connections.find(
        (item) => item.googleUserId === googleUserId && !item.disconnectedAt
      ) || null
    );
  }

  upsertConnection(record) {
    const existing = record.googleUserId
      ? this.findConnectionByGoogleUser(record.googleUserId)
      : null;
    if (existing) {
      Object.assign(existing, record, { id: existing.id, updatedAt: nowIso() });
      delete existing.disconnectedAt;
      this.persist();
      return existing;
    }
    return this.insert("connections", record);
  }

  disconnect(connectionId, ownerId) {
    const connection = this.get("connections", connectionId, ownerId);
    if (!connection) return null;
    connection.disconnectedAt = nowIso();
    connection.accessToken = null;
    connection.refreshToken = null;
    connection.idToken = null;
    connection.updatedAt = nowIso();
    this.persist();
    return connection;
  }
}

let singleton = null;

function getStore(options) {
  if (!singleton) singleton = new Store(options);
  return singleton;
}

function resetStore() {
  singleton = null;
}

module.exports = {
  Store,
  getStore,
  resetStore,
  newId,
  nowIso,
  SESSION_TTL_MS,
  AUTH_STATE_TTL_MS,
  COLLECTIONS,
};
