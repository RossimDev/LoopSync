import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { youtubeApi, ApiError } from "./api.js";

/**
 * Estado compartilhado do módulo YouTube: conexão, bibliotecas (descrições,
 * tags, templates), dados do canal (categorias/playlists) e histórico.
 *
 * Todas as leituras são escopadas no servidor pelo dono da sessão — o
 * frontend nunca manipula tokens.
 */
export function useYouTubeData() {
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState(null);
  const [serverAvailable, setServerAvailable] = useState(true);
  const [descriptions, setDescriptions] = useState([]);
  const [tagSets, setTagSets] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [categories, setCategories] = useState([]);
  const [categoriesFallback, setCategoriesFallback] = useState(false);
  const [playlists, setPlaylists] = useState([]);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState({ descriptions: false, tagSets: false, templates: false, categories: false, playlists: false, history: false });
  const [error, setError] = useState(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const setLoad = useCallback((key, value) => {
    if (!mounted.current) return;
    setLoading((prev) => ({ ...prev, [key]: value }));
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const data = await youtubeApi.status();
      if (!mounted.current) return data;
      setStatus(data);
      setServerAvailable(true);
      setError(null);
      return data;
    } catch (err) {
      if (!mounted.current) return null;
      if (err instanceof ApiError && (err.code === "network" || err.status === 404)) {
        setServerAvailable(false);
      }
      setStatus(null);
      return null;
    }
  }, []);

  const refreshDescriptions = useCallback(async () => {
    setLoad("descriptions", true);
    try {
      const data = await youtubeApi.descriptions.list();
      if (mounted.current) setDescriptions(data.items || []);
    } catch (err) {
      if (mounted.current) setError(err.message);
    } finally {
      setLoad("descriptions", false);
    }
  }, [setLoad]);

  const refreshTagSets = useCallback(async () => {
    setLoad("tagSets", true);
    try {
      const data = await youtubeApi.tagSets.list();
      if (mounted.current) setTagSets(data.items || []);
    } catch (err) {
      if (mounted.current) setError(err.message);
    } finally {
      setLoad("tagSets", false);
    }
  }, [setLoad]);

  const refreshTemplates = useCallback(async () => {
    setLoad("templates", true);
    try {
      const data = await youtubeApi.templates.list();
      if (mounted.current) setTemplates(data.items || []);
    } catch (err) {
      if (mounted.current) setError(err.message);
    } finally {
      setLoad("templates", false);
    }
  }, [setLoad]);

  const refreshCategories = useCallback(async ({ force = false } = {}) => {
    if (!force && categories.length) return categories;
    setLoad("categories", true);
    try {
      const data = await youtubeApi.categories();
      if (mounted.current) {
        setCategories(data.items || []);
        setCategoriesFallback(Boolean(data.fallback));
      }
      return data.items || [];
    } catch (err) {
      if (mounted.current && err instanceof ApiError && err.code === "not_connected") {
        setCategories([]);
      }
      return [];
    } finally {
      setLoad("categories", false);
    }
  }, [categories.length, setLoad]);

  const refreshPlaylists = useCallback(async ({ force = false } = {}) => {
    if (!force && playlists.length) return playlists;
    setLoad("playlists", true);
    try {
      const data = await youtubeApi.playlists();
      if (mounted.current) setPlaylists(data.items || []);
      return data.items || [];
    } catch (err) {
      if (mounted.current && err instanceof ApiError && err.code === "not_connected") {
        setPlaylists([]);
      }
      return [];
    } finally {
      setLoad("playlists", false);
    }
  }, [playlists.length, setLoad]);

  const refreshHistory = useCallback(async () => {
    setLoad("history", true);
    try {
      const data = await youtubeApi.uploads.list({ limit: 50 });
      if (mounted.current) setHistory(data.items || []);
      return data.items || [];
    } catch (err) {
      if (mounted.current && !(err instanceof ApiError && err.code === "not_connected")) {
        setError(err.message);
      }
      return [];
    } finally {
      setLoad("history", false);
    }
  }, [setLoad]);

  /* ── biblioteca de descrições ── */
  const createDescription = useCallback(async (payload) => {
    const data = await youtubeApi.descriptions.create(payload);
    await refreshDescriptions();
    return data.item;
  }, [refreshDescriptions]);

  const updateDescription = useCallback(async (id, payload) => {
    const data = await youtubeApi.descriptions.update(id, payload);
    await refreshDescriptions();
    return data.item;
  }, [refreshDescriptions]);

  const duplicateDescription = useCallback(async (id) => {
    await youtubeApi.descriptions.duplicate(id);
    await refreshDescriptions();
  }, [refreshDescriptions]);

  const removeDescription = useCallback(async (id) => {
    await youtubeApi.descriptions.remove(id);
    await refreshDescriptions();
  }, [refreshDescriptions]);

  /* ── conjuntos de tags ── */
  const createTagSet = useCallback(async (payload) => {
    const data = await youtubeApi.tagSets.create(payload);
    await refreshTagSets();
    return data.item;
  }, [refreshTagSets]);

  const updateTagSet = useCallback(async (id, payload) => {
    const data = await youtubeApi.tagSets.update(id, payload);
    await refreshTagSets();
    return data.item;
  }, [refreshTagSets]);

  const duplicateTagSet = useCallback(async (id) => {
    await youtubeApi.tagSets.duplicate(id);
    await refreshTagSets();
  }, [refreshTagSets]);

  const removeTagSet = useCallback(async (id) => {
    await youtubeApi.tagSets.remove(id);
    await refreshTagSets();
  }, [refreshTagSets]);

  /* ── templates ── */
  const createTemplate = useCallback(async (payload) => {
    const data = await youtubeApi.templates.create(payload);
    await refreshTemplates();
    return data.item;
  }, [refreshTemplates]);

  const removeTemplate = useCallback(async (id) => {
    await youtubeApi.templates.remove(id);
    await refreshTemplates();
  }, [refreshTemplates]);

  const resolveTemplate = useCallback(async (id, context) => {
    const data = await youtubeApi.templates.resolve(id, context);
    return data.template;
  }, []);

  /* ── conexão ── */
  const startConnection = useCallback(async (returnTo) => {
    const data = await youtubeApi.authStart(returnTo);
    if (data && data.url) window.location.href = data.url;
    return data;
  }, []);

  const disconnect = useCallback(async () => {
    await youtubeApi.disconnect();
    if (!mounted.current) return;
    setPlaylists([]);
    setCategories([]);
    await refreshStatus();
  }, [refreshStatus]);

  const refreshChannel = useCallback(async () => {
    try {
      const data = await youtubeApi.channel();
      await refreshStatus();
      return data.channel;
    } catch (err) {
      if (mounted.current) setError(err.message);
      return null;
    }
  }, [refreshStatus]);

  /* ── boot ── */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const data = await refreshStatus();
      if (cancelled) return;
      await Promise.all([refreshDescriptions(), refreshTagSets(), refreshTemplates()]);
      if (data && data.connected) {
        await Promise.all([refreshCategories({ force: true }), refreshPlaylists({ force: true }), refreshHistory()]);
      }
      if (!cancelled) setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshStatus, refreshDescriptions, refreshTagSets, refreshTemplates, refreshCategories, refreshPlaylists, refreshHistory]);

  const connected = Boolean(status && status.connected);
  const channel = status ? status.channel : null;
  const limits = useMemo(
    () => ({
      title: (status && status.limits && status.limits.title) || 100,
      description: (status && status.limits && status.limits.description) || 5000,
      tagsTotalChars: (status && status.limits && status.limits.tagsTotalChars) || 500,
      maxChunkBytes: (status && status.limits && status.limits.maxChunkBytes) || 5 * 1024 * 1024,
    }),
    [status]
  );

  return {
    ready,
    status,
    serverAvailable,
    connected,
    channel,
    limits,
    descriptions,
    tagSets,
    templates,
    categories,
    categoriesFallback,
    playlists,
    history,
    loading,
    error,
    setError,
    actions: {
      refreshStatus,
      refreshDescriptions,
      refreshTagSets,
      refreshTemplates,
      refreshCategories,
      refreshPlaylists,
      refreshHistory,
      createDescription,
      updateDescription,
      duplicateDescription,
      removeDescription,
      createTagSet,
      updateTagSet,
      duplicateTagSet,
      removeTagSet,
      createTemplate,
      removeTemplate,
      resolveTemplate,
      startConnection,
      disconnect,
      refreshChannel,
    },
  };
}
