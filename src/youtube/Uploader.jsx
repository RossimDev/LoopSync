import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  youtubeApi,
  uploadToYouTube,
  uploadLocalResult,
  readVideoMeta,
  captureVideoFrame,
  captureFrameFromUrl,
  blobToDataUrl,
  formatBytes,
  formatDuration,
  extensionOf,
  ApiError,
} from "./api.js";
import {
  Section,
  Field,
  TextInput,
  TextArea,
  Select,
  Button,
  Toggle,
  Segmented,
  ProgressBar,
  StatusBadge,
  TagEditor,
  Modal,
  ConfirmDialog,
  EmptyState,
  Spinner,
} from "./ui.jsx";

let uidCounter = 0;
const uid = () => `item_${Date.now().toString(36)}_${(uidCounter += 1)}`;

const LANGUAGE_OPTIONS = [
  { id: "pt-BR", label: "Português (Brasil)" },
  { id: "pt", label: "Português" },
  { id: "en", label: "English" },
  { id: "es", label: "Español" },
  { id: "es-419", label: "Español (Latinoamérica)" },
  { id: "fr", label: "Français" },
  { id: "de", label: "Deutsch" },
  { id: "it", label: "Italiano" },
  { id: "ja", label: "日本語" },
];

function emptyMeta(limits) {
  return {
    title: "",
    description: "",
    tags: [],
    categoryId: "",
    privacyStatus: "private",
    playlistId: "",
    playlistTitle: "",
    categoryTitle: "",
    madeForKids: false,
    language: "pt-BR",
    notifySubscribers: false,
    thumbnail: null,
    templateId: null,
    templateName: null,
    descriptionSourceId: null,
    descriptionSourceName: null,
    descriptionDirty: false,
    tagSetSourceIds: [],
    tagSetSourceName: null,
    tagsDirty: false,
    subject: "",
  };
}

function titleFromFileName(name) {
  const base = String(name || "")
    .replace(/\.[a-z0-9]{1,5}$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : "";
}

export default function Uploader({ data, showToast, incomingVideo, onIncomingConsumed, applyRequest, onApplyHandled }) {
  const { status, channel, connected, limits, descriptions, tagSets, templates, categories, categoriesFallback, playlists, loading, actions } = data;

  const [items, setItems] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [view, setView] = useState("config"); // config | review | sending | done
  const [suggestions, setSuggestions] = useState([]);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestSubject, setSuggestSubject] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [modal, setModal] = useState(null); // {type, ...}
  const [confirmState, setConfirmState] = useState(null);
  const [draftName, setDraftName] = useState("");
  const [queueRunning, setQueueRunning] = useState(false);

  const fileInputRef = useRef(null);
  const thumbInputRef = useRef(null);
  const controllersRef = useRef(new Map());
  const itemsRef = useRef(items);
  const queueStopRef = useRef(false);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  /* ── helpers de estado ── */

  const patchItem = useCallback((id, patch) => {
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }, []);

  const patchMeta = useCallback((id, patch) => {
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, meta: { ...item.meta, ...patch } } : item)));
  }, []);

  const patchUpload = useCallback((id, patch) => {
    setItems((prev) =>
      prev.map((item) => (item.id === id ? { ...item, upload: { ...(item.upload || {}), ...patch } } : item))
    );
  }, []);

  const active = useMemo(() => items.find((item) => item.id === activeId) || items[0] || null, [items, activeId]);
  const activeIndex = useMemo(() => (active ? items.findIndex((item) => item.id === active.id) : -1), [items, active]);

  useEffect(() => {
    if (active && active.id !== activeId) setActiveId(active.id);
  }, [active, activeId]);

  /* ── seleção de vídeos ── */

  const addFiles = useCallback(
    async (fileList) => {
      const files = Array.from(fileList || []);
      if (!files.length) return;
      const accepted = [];
      for (const file of files) {
        if (!file.type.startsWith("video/") && !/\.(mp4|mov|m4v|webm|mkv|avi|wmv|flv|3gp|mpg|mpeg|ts)$/i.test(file.name)) {
          showToast(`"${file.name}" não é um arquivo de vídeo suportado.`, "error");
          continue;
        }
        if (!file.size) {
          showToast(`"${file.name}" está vazio ou não pôde ser lido.`, "error");
          continue;
        }
        const meta = await readVideoMeta(file);
        let poster = null;
        try {
          const frame = await captureVideoFrame(file);
          if (frame && frame.blob) poster = await blobToDataUrl(frame.blob);
        } catch {
          poster = null;
        }
        accepted.push({
          id: uid(),
          file,
          name: file.name,
          size: file.size,
          format: extensionOf(file) || (file.type.split("/")[1] || "").toUpperCase(),
          mime: file.type || "video/mp4",
          duration: meta.duration,
          width: meta.width,
          height: meta.height,
          poster,
          meta: {
            ...emptyMeta(limits),
            title: titleFromFileName(file.name),
            thumbnail: poster ? { dataUrl: poster, mime: "image/jpeg", name: "Quadro do vídeo", size: 0, source: "frame" } : null,
          },
          upload: null,
        });
      }
      if (!accepted.length) return;
      setItems((prev) => {
        const next = [...prev, ...accepted];
        if (!activeId) setActiveId(next[0].id);
        return next;
      });
      if (accepted.length > 1) showToast(`${accepted.length} vídeos adicionados à fila.`, "info");
      setView("config");
    },
    [activeId, limits, showToast]
  );

  const removeItem = useCallback((id) => {
    const controller = controllersRef.current.get(id);
    if (controller) controller.abort();
    controllersRef.current.delete(id);
    setItems((prev) => prev.filter((item) => item.id !== id));
  }, []);

  /* ── vídeo vindo do fluxo principal do LoopSync ──
     Duas origens possíveis:
       a) `sourceJobId`  -> MP4 já processado no servidor (nada volta ao navegador)
       b) `file`         -> Blob/File (modo navegador)                            */

  useEffect(() => {
    if (!incomingVideo) return;
    let cancelled = false;

    (async () => {
      const fromServer = Boolean(incomingVideo.sourceJobId);
      const name = incomingVideo.name || (incomingVideo.file && incomingVideo.file.name) || "LoopSync.mp4";
      const size = Number(incomingVideo.size || (incomingVideo.file && incomingVideo.file.size) || 0);

      let duration = incomingVideo.duration || null;
      let poster = null;

      try {
        if (fromServer && incomingVideo.previewUrl) {
          const frame = await captureFrameFromUrl(incomingVideo.previewUrl);
          if (frame && frame.blob) {
            poster = await blobToDataUrl(frame.blob);
            duration = duration || frame.duration || null;
          }
        } else if (incomingVideo.file) {
          const meta = await readVideoMeta(incomingVideo.file);
          duration = meta.duration;
          const frame = await captureVideoFrame(incomingVideo.file);
          if (frame && frame.blob) poster = await blobToDataUrl(frame.blob);
        }
      } catch {
        poster = null;
      }
      if (cancelled) return;

      const item = {
        id: uid(),
        file: incomingVideo.file || null,
        sourceJobId: fromServer ? incomingVideo.sourceJobId : null,
        previewUrl: incomingVideo.previewUrl || null,
        name,
        size,
        format: extensionOf({ name }) || "MP4",
        mime: (incomingVideo.file && incomingVideo.file.type) || "video/mp4",
        duration,
        width: null,
        height: null,
        poster,
        fromLoopSync: true,
        meta: {
          ...emptyMeta(limits),
          title: incomingVideo.title || titleFromFileName(name),
          thumbnail: poster ? { dataUrl: poster, mime: "image/jpeg", name: "Quadro do vídeo", size: 0, source: "frame" } : null,
        },
        upload: null,
      };

      setItems((prev) => [item, ...prev]);
      setActiveId(item.id);
      setView("config");
      showToast("Vídeo gerado no LoopSync adicionado ao envio do YouTube.", "info");
      onIncomingConsumed && onIncomingConsumed();
    })();

    return () => {
      cancelled = true;
    };
  }, [incomingVideo]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── templates ── */

  const applyTemplate = useCallback(
    async (templateId) => {
      if (!active) return;
      try {
        const resolved = await actions.resolveTemplate(templateId, {
          fileName: active.name,
          title: titleFromFileName(active.name),
          duration: active.duration,
          fileSize: active.size,
          channelTitle: (channel && channel.title) || "",
        });
        const template = templates.find((item) => item.id === templateId);
        patchMeta(active.id, {
          title: resolved.title || active.meta.title,
          description: resolved.description || "",
          tags: resolved.tags || [],
          categoryId: resolved.categoryId || "",
          privacyStatus: resolved.privacyStatus || "private",
          playlistId: resolved.playlistId || "",
          madeForKids: Boolean(resolved.madeForKids),
          language: resolved.language || "pt-BR",
          notifySubscribers: Boolean(resolved.notifySubscribers),
          templateId: resolved.id,
          templateName: resolved.name || (template && template.name) || "Template",
          categoryTitle: (categories.find((c) => c.id === resolved.categoryId) || {}).title || "",
          playlistTitle: (playlists.find((p) => p.id === resolved.playlistId) || {}).title || "",
          descriptionDirty: false,
          descriptionSourceId: null,
          descriptionSourceName: null,
          tagsDirty: false,
          tagSetSourceIds: [],
          tagSetSourceName: null,
        });
        setSuggestions([]);
        showToast(`Template "${resolved.name || template?.name}" aplicado.`, "info");
      } catch (err) {
        showToast(err.message || "Não foi possível aplicar o template.", "error");
      }
    },
    [active, actions, categories, channel, patchMeta, playlists, showToast, templates]
  );

  /* ── descrições salvas ── */

  const applyDescription = useCallback(
    (description) => {
      if (!active) return;
      patchMeta(active.id, {
        description: description.content,
        descriptionSourceId: description.id,
        descriptionSourceName: description.name,
        descriptionDirty: false,
      });
      showToast(`Descrição "${description.name}" carregada. Você pode editá-la livremente.`, "info");
    },
    [active, patchMeta, showToast]
  );

  const editDescription = useCallback(
    (value) => {
      if (!active) return;
      const dirty = active.meta.descriptionSourceId ? value !== (descriptions.find((d) => d.id === active.meta.descriptionSourceId) || {}).content : true;
      patchMeta(active.id, { description: value, descriptionDirty: Boolean(active.meta.descriptionSourceId) && dirty });
    },
    [active, descriptions, patchMeta]
  );

  const saveDescriptionBack = useCallback(async () => {
    if (!active || !active.meta.descriptionSourceId) return;
    try {
      await actions.updateDescription(active.meta.descriptionSourceId, {
        name: active.meta.descriptionSourceName,
        content: active.meta.description,
      });
      patchMeta(active.id, { descriptionDirty: false });
      showToast("Descrição salva atualizada.", "info");
    } catch (err) {
      showToast(err.message || "Não foi possível atualizar a descrição salva.", "error");
    }
  }, [active, actions, patchMeta, showToast]);

  /* ── tags salvas ── */

  const applyTagSet = useCallback(
    (tagSet, { replace = false } = {}) => {
      if (!active) return;
      const current = replace ? [] : active.meta.tags;
      const merged = [...current];
      for (const tag of tagSet.tags || []) {
        if (!merged.some((item) => item.toLowerCase() === String(tag).toLowerCase())) merged.push(tag);
      }
      const sourceIds = new Set(active.meta.tagSetSourceIds || []);
      sourceIds.add(tagSet.id);
      // Só não há nada a "salvar de volta" quando a lista do vídeo ficou
      // idêntica à do conjunto. Misturar conjuntos (ou somar sobre tags que já
      // existiam) gera uma diferença pendente — o botão precisa ficar ativo.
      const setName = (tagSet.tags || []).map((tag) => String(tag));
      const identicalToSet =
        merged.length === setName.length && merged.every((tag, index) => String(tag) === setName[index]);
      patchMeta(active.id, {
        tags: merged,
        tagSetSourceIds: [...sourceIds],
        tagSetSourceName: tagSet.name,
        tagsDirty: !identicalToSet,
      });
      setSuggestions((prev) => prev.filter((s) => !merged.some((tag) => tag.toLowerCase() === s.tag.toLowerCase())));
      showToast(`Tags do conjunto "${tagSet.name}" carregadas (${replace ? "substituindo" : "somando"}).`, "info");
    },
    [active, patchMeta, showToast]
  );

  const onTagsChange = useCallback(
    (next) => {
      if (!active) return;
      patchMeta(active.id, { tags: next, tagsDirty: true });
    },
    [active, patchMeta]
  );

  const saveTagsBack = useCallback(async () => {
    if (!active) return;
    const sourceIds = active.meta.tagSetSourceIds || [];
    if (!sourceIds.length) {
      setModal({ type: "saveTagSet" });
      setDraftName(active.meta.tagSetSourceName || "Tags do vídeo");
      return;
    }
    if (sourceIds.length > 1) {
      setModal({ type: "chooseTagSet", sourceIds });
      return;
    }
    const tagSet = tagSets.find((item) => item.id === sourceIds[0]);
    if (!tagSet) {
      setModal({ type: "saveTagSet" });
      return;
    }
    try {
      await actions.updateTagSet(tagSet.id, { name: tagSet.name, tags: active.meta.tags });
      patchMeta(active.id, { tagsDirty: false });
      showToast(`Conjunto "${tagSet.name}" atualizado com as tags do vídeo.`, "info");
    } catch (err) {
      showToast(err.message || "Não foi possível salvar as tags.", "error");
    }
  }, [active, actions, patchMeta, showToast, tagSets]);

  /* ── sugestões de tags ── */

  const generateSuggestions = useCallback(async () => {
    if (!active) return;
    setSuggesting(true);
    setShowSuggestions(true);
    try {
      const result = await youtubeApi.suggestions({
        title: active.meta.title || titleFromFileName(active.name),
        subject: active.meta.subject || "",
        description: active.meta.description || "",
        baseTags: active.meta.tags,
        limit: 24,
      });
      setSuggestions(result.suggestions || []);
      if (!(result.suggestions || []).length) showToast("Nenhuma sugestão encontrada para este título. Descreva o assunto para melhorar.", "info");
    } catch (err) {
      showToast(err.message || "Não foi possível gerar sugestões.", "error");
    } finally {
      setSuggesting(false);
    }
  }, [active, showToast]);

  /* ── thumbnail ── */

  const onThumbnailFile = useCallback(
    async (file) => {
      if (!file || !active) return;
      if (!/^image\//.test(file.type)) {
        showToast("Selecione uma imagem (JPG, PNG, GIF, BMP ou WEBP).", "error");
        return;
      }
      if (file.size > 2 * 1024 * 1024) {
        showToast("A miniatura deve ter no máximo 2 MB (recomendado 1280×720).", "error");
        return;
      }
      try {
        const dataUrl = await blobToDataUrl(file);
        patchMeta(active.id, { thumbnail: { dataUrl, mime: file.type, name: file.name, size: file.size, source: "file" } });
      } catch {
        showToast("Não foi possível ler a imagem selecionada.", "error");
      }
    },
    [active, patchMeta, showToast]
  );

  const useFrameAsThumbnail = useCallback(async () => {
    if (!active) return;
    let poster = active.poster;
    if (!poster && active.previewUrl) {
      const frame = await captureFrameFromUrl(active.previewUrl);
      if (frame && frame.blob) {
        poster = await blobToDataUrl(frame.blob);
        patchItem(active.id, { poster });
      }
    }
    if (!poster) {
      showToast("Não foi possível capturar um quadro deste vídeo.", "error");
      return;
    }
    patchMeta(active.id, { thumbnail: { dataUrl: poster, mime: "image/jpeg", name: "Quadro do vídeo", size: 0, source: "frame" } });
  }, [active, patchItem, patchMeta, showToast]);

  /* ── aplicar configurações em vários vídeos (lote) ── */

  const applyToAll = useCallback(
    (fields) => {
      if (!active) return;
      const source = active.meta;
      setItems((prev) =>
        prev.map((item) => {
          if (item.id === active.id) return item;
          const meta = { ...item.meta };
          if (fields.description) {
            meta.description = source.description;
            meta.descriptionSourceId = source.descriptionSourceId;
            meta.descriptionSourceName = source.descriptionSourceName;
            meta.descriptionDirty = source.descriptionDirty;
          }
          if (fields.tags) {
            meta.tags = [...source.tags];
            meta.tagSetSourceIds = [...(source.tagSetSourceIds || [])];
            meta.tagSetSourceName = source.tagSetSourceName;
            meta.tagsDirty = source.tagsDirty;
          }
          if (fields.settings) {
            meta.categoryId = source.categoryId;
            meta.categoryTitle = source.categoryTitle;
            meta.privacyStatus = source.privacyStatus;
            meta.playlistId = source.playlistId;
            meta.playlistTitle = source.playlistTitle;
            meta.madeForKids = source.madeForKids;
            meta.language = source.language;
            meta.notifySubscribers = source.notifySubscribers;
          }
          if (fields.title) meta.title = source.title;
          return { ...item, meta };
        })
      );
      showToast("Configurações aplicadas aos vídeos da fila.", "info");
    },
    [active, showToast]
  );

  /* ── envio ── */

  const buildMetadata = useCallback(
    (item) => {
      const meta = item.meta;
      const category = categories.find((c) => c.id === meta.categoryId);
      const playlist = playlists.find((p) => p.id === meta.playlistId);
      return {
        title: meta.title.trim(),
        description: meta.description,
        tags: meta.tags,
        categoryId: meta.categoryId || null,
        categoryTitle: (category && category.title) || meta.categoryTitle || null,
        privacyStatus: meta.privacyStatus,
        playlistId: meta.playlistId || null,
        playlistTitle: (playlist && playlist.title) || meta.playlistTitle || null,
        madeForKids: meta.madeForKids,
        language: meta.language,
        notifySubscribers: meta.notifySubscribers,
        duration: item.duration || null,
        templateId: meta.templateId,
        templateName: meta.templateName,
        descriptionSourceId: meta.descriptionSourceId,
        tagSetSourceIds: meta.tagSetSourceIds,
        thumbnailDataUrl: meta.thumbnail ? meta.thumbnail.dataUrl : null,
        thumbnailMime: meta.thumbnail ? meta.thumbnail.mime : "image/jpeg",
      };
    },
    [categories, playlists]
  );

  const validateItem = useCallback(
    (item) => {
      const errors = [];
      if (!item.file && !item.sourceJobId) errors.push("Selecione um arquivo de vídeo.");
      if (item.sourceJobId && !item.size) errors.push("O vídeo gerado não está mais disponível no servidor. Gere novamente.");
      if (!item.meta.title.trim()) errors.push("Informe o título do vídeo.");
      if (item.meta.title.trim().length > limits.title) errors.push(`O título deve ter no máximo ${limits.title} caracteres.`);
      if (item.meta.description.length > limits.description) errors.push(`A descrição deve ter no máximo ${limits.description} caracteres.`);
      if (!item.meta.privacyStatus) errors.push("Selecione a privacidade.");
      return errors;
    },
    [limits]
  );

  const sendItem = useCallback(
    async (item, { reuseUploadId = null } = {}) => {
      if (!connected) {
        showToast("Conecte seu canal do YouTube antes de enviar.", "error");
        return null;
      }
      const errors = validateItem(item);
      if (errors.length) {
        showToast(errors[0], "error");
        setView("config");
        setActiveId(item.id);
        return null;
      }

      const controller = new AbortController();
      controllersRef.current.set(item.id, controller);
      setView("sending");
      patchUpload(item.id, { status: "queued", progress: 0, phase: "preparando", error: null });

      const track = (state) => {
        const fromUpload = state.upload || null;
        patchUpload(item.id, {
          status:
            state.phase === "cancelado"
              ? "cancelled"
              : fromUpload && fromUpload.status
                ? fromUpload.status
                : "uploading",
          progress: fromUpload && fromUpload.status === "processing" ? 100 : state.percent || 0,
          phase: state.phase,
          received: state.received != null ? state.received : fromUpload && fromUpload.received,
          warning: state.warning || state.thumbnailWarning || null,
          retryIn: state.retryIn || null,
          restarted: state.restarted || false,
          videoId: fromUpload ? fromUpload.videoId : undefined,
          uploadId: state.uploadId || (fromUpload && fromUpload.id) || reuseUploadId || undefined,
        });
      };

      try {
        const metadata = buildMetadata(item);
        const result = item.sourceJobId
          ? await uploadLocalResult({
              jobId: item.sourceJobId,
              metadata,
              signal: controller.signal,
              uploadId: reuseUploadId,
              onProgress: track,
            })
          : await uploadToYouTube({
              file: item.file,
              metadata,
              signal: controller.signal,
              uploadId: reuseUploadId,
              onProgress: track,
            });
        patchUpload(item.id, {
          status: result.status === "cancelled" ? "cancelled" : "done",
          progress: 100,
          phase: "concluido",
          videoId: result.videoId || null,
          videoUrl: result.videoUrl || null,
          thumbnailUrl: result.thumbnailUrl || null,
          thumbnailApplied: result.thumbnailApplied,
          thumbnailError: result.thumbnailError || null,
          playlistApplied: result.playlistApplied,
          playlistError: result.playlistError || null,
          uploadId: result.id,
          error: null,
        });
        if (result.status !== "cancelled") {
          showToast("Upload concluído com sucesso!", "success");
          setView("done");
          actions.refreshHistory();
        }
        return result;
      } catch (err) {
        const cancelled = err && err.name === "AbortError";
        patchUpload(item.id, {
          status: cancelled ? "cancelled" : "error",
          phase: cancelled ? "cancelado" : "erro",
          error: cancelled ? "Envio cancelado." : err.message,
          retryable: Boolean(err && err.retryable),
          uploadId: (err && err.upload && err.upload.id) || reuseUploadId || null,
          videoId: (err && err.upload && err.upload.videoId) || null,
        });
        if (!cancelled) showToast(err.message || "Não foi possível enviar o vídeo.", "error");
        return null;
      } finally {
        controllersRef.current.delete(item.id);
      }
    },
    [actions, buildMetadata, connected, patchUpload, showToast, validateItem]
  );

  const cancelItem = useCallback(
    async (item) => {
      const controller = controllersRef.current.get(item.id);
      if (controller) controller.abort();
      if (item.upload && item.upload.uploadId) {
        try {
          await youtubeApi.uploads.cancel(item.upload.uploadId);
        } catch {
          /* ignora */
        }
      }
      patchUpload(item.id, { status: "cancelled", phase: "cancelado" });
      showToast("Envio cancelado.", "info");
    },
    [patchUpload, showToast]
  );

  const retryItem = useCallback(
    async (item) => {
      if (!item.upload || !item.upload.uploadId) return sendItem(item);
      patchUpload(item.id, { status: "queued", error: null, phase: "retomando" });
      return sendItem(item, { reuseUploadId: item.upload.uploadId });
    },
    [patchUpload, sendItem]
  );

  const sendQueue = useCallback(async () => {
    const pending = itemsRef.current.filter((item) => !item.upload || item.upload.status === "error" || item.upload.status === "cancelled");
    if (!pending.length) {
      showToast("Nenhum vídeo aguardando envio.", "info");
      return;
    }
    queueStopRef.current = false;
    setQueueRunning(true);
    for (const item of pending) {
      if (queueStopRef.current) break;
      setActiveId(item.id);
      // eslint-disable-next-line no-await-in-loop
      await sendItem(item);
    }
    setQueueRunning(false);
    actions.refreshHistory();
  }, [actions, sendItem, showToast]);

  const stopQueue = useCallback(() => {
    queueStopRef.current = true;
    for (const controller of controllersRef.current.values()) controller.abort();
    setQueueRunning(false);
  }, []);

  /* ── efeitos ── */

  // Ações vindas da aba Biblioteca ("Usar descrição" / "Usar tags" / template).
  useEffect(() => {
    if (!applyRequest) return;
    const handle = async () => {
      if (!itemsRef.current.length) {
        showToast("Selecione um vídeo primeiro para aplicar este conteúdo.", "error");
        return;
      }
      if (applyRequest.type === "description") applyDescription(applyRequest.payload);
      else if (applyRequest.type === "tagSet") applyTagSet(applyRequest.payload, { replace: !applyRequest.options?.append });
      else if (applyRequest.type === "template") await applyTemplate(applyRequest.payload.id);
    };
    handle();
    onApplyHandled && onApplyHandled();
  }, [applyRequest]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (connected && !categories.length) actions.refreshCategories({ force: true });
    if (connected && !playlists.length) actions.refreshPlaylists({ force: true });
  }, [connected]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => {
    for (const controller of controllersRef.current.values()) controller.abort();
  }, []);

  /* ── render helpers ── */

  const canSend = Boolean(connected && active && !validateItem(active).length && !(active.upload && ["uploading", "processing"].includes(active.upload.status)));
  const sending = Boolean(active && active.upload && ["queued", "uploading"].includes(active.upload.status));

  // O modal de conexão precisa existir também no estado desconectado: sem ele o
  // clique em "Conectar canal do YouTube" mudava o estado e nada aparecia.
  const connectModal = (
    <Modal open={Boolean(modal && modal.type === "connect")} title="Conectar canal do YouTube" onClose={() => setModal(null)} size="sm">
      <p className="yt-modal-text">Você será levado ao Google para autorizar o LoopSync a enviar vídeos para o seu canal.</p>
      <div className="yt-actions">
        <Button variant="ghost" onClick={() => setModal(null)}>Cancelar</Button>
        <Button variant="primary" data-testid="connect-google-modal" onClick={() => actions.startConnection("/#/youtube")}>Conectar com o Google</Button>
      </div>
    </Modal>
  );

  if (!connected) {
    return (
      <>
        <EmptyState
          icon="🔌"
          title="Conecte seu canal para começar"
          description="O envio para o YouTube só é liberado depois que você conecta um canal pela conta do Google."
          action={<Button variant="primary" data-testid="connect-cta" onClick={() => setModal({ type: "connect" })}>Conectar canal do YouTube</Button>}
        />
        {connectModal}
      </>
    );
  }

  return (
    <div className="yt-uploader">
      {/* ── fila / vídeos ── */}
      <Section
        icon="🎞️"
        title="Vídeos"
        subtitle={items.length ? `${items.length} vídeo(s) na fila — toque para configurar cada um` : "Selecione um ou vários vídeos do dispositivo"}
        aside={
          items.length ? (
            <div className="yt-section-actions">
              <Button variant="ghost" size="sm" icon="＋" onClick={() => fileInputRef.current && fileInputRef.current.click()}>
                Adicionar
              </Button>
              <Button variant="ghost" size="sm" icon="🗑" onClick={() => setConfirmState({ type: "clearQueue" })}>
                Limpar fila
              </Button>
            </div>
          ) : null
        }
      >
        <div
          className={`yt-dropzone${items.length ? " compact" : ""}`}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            addFiles(event.dataTransfer && event.dataTransfer.files);
          }}
        >
          <input
            ref={fileInputRef}
            data-testid="video-input"
            type="file"
            accept="video/*"
            multiple
            hidden
            onChange={(event) => {
              addFiles(event.target.files);
              event.target.value = "";
            }}
          />
          {!items.length ? (
            <div className="yt-dropzone-inner">
              <span className="yt-dropzone-icon" aria-hidden="true">⬆️</span>
              <strong>Selecionar vídeo</strong>
              <p>Toque para escolher do dispositivo ou arraste vários arquivos para criar uma fila de envio.</p>
              <Button variant="primary" data-testid="pick-videos" onClick={() => fileInputRef.current && fileInputRef.current.click()}>
                Escolher vídeos
              </Button>
            </div>
          ) : (
            <ul className="yt-queue">
              <AnimatePresence initial={false}>
                {items.map((item) => (
                  <motion.li
                    key={item.id}
                    layout
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.97 }}
                    className={`yt-queue-item${item.id === (active && active.id) ? " active" : ""}`}
                  >
                    <button type="button" className="yt-queue-main" data-testid={`queue-select-${item.id}`} onClick={() => { setActiveId(item.id); setView("config"); }}>
                      <span className="yt-queue-thumb">
                        {item.poster ? <img src={item.poster} alt="" /> : <span aria-hidden="true">🎬</span>}
                        {item.upload && item.upload.status === "done" && item.upload.thumbnailUrl ? <img src={item.upload.thumbnailUrl} alt="" /> : null}
                      </span>
                      <span className="yt-queue-info">
                        <strong title={item.meta.title || item.name}>{item.meta.title || item.name}</strong>
                        <small>
                          {item.name} · {formatBytes(item.size)}
                          {item.duration ? ` · ${formatDuration(item.duration)}` : ""}
                          {item.format ? ` · ${item.format}` : ""}
                        </small>
                        {item.upload ? (
                          <span className="yt-queue-progress">
                            <StatusBadge status={item.upload.status} />
                            {["queued", "uploading"].includes(item.upload.status) ? (
                              <ProgressBar percent={item.upload.progress || 0} />
                            ) : null}
                          </span>
                        ) : (
                          <StatusBadge status="queued" label="Aguardando configuração" />
                        )}
                      </span>
                    </button>
                    <span className="yt-queue-tools">
                      {item.upload && item.upload.status === "error" ? (
                        <button type="button" className="yt-icon-btn" title="Tentar novamente" data-testid={`queue-retry-${item.id}`} onClick={() => retryItem(item)}>↻</button>
                      ) : null}
                      {item.upload && ["queued", "uploading"].includes(item.upload.status) ? (
                        <button type="button" className="yt-icon-btn" title="Cancelar envio" data-testid={`queue-cancel-${item.id}`} onClick={() => cancelItem(item)}>■</button>
                      ) : null}
                      <button type="button" className="yt-icon-btn" title="Remover da fila" data-testid={`queue-remove-${item.id}`} onClick={() => removeItem(item.id)}>✕</button>
                    </span>
                  </motion.li>
                ))}
              </AnimatePresence>
            </ul>
          )}
        </div>

        {items.length > 1 ? (
          <div className="yt-batch">
            <strong>Aplicar as configurações do vídeo selecionado aos demais:</strong>
            <div className="yt-batch-actions">
              <Button variant="ghost" size="sm" data-testid="apply-all-description" onClick={() => applyToAll({ description: true })}>Descrição</Button>
              <Button variant="ghost" size="sm" data-testid="apply-all-tags" onClick={() => applyToAll({ tags: true })}>Tags</Button>
              <Button variant="ghost" size="sm" data-testid="apply-all-settings" onClick={() => applyToAll({ settings: true })}>Configurações</Button>
              <Button variant="ghost" size="sm" data-testid="apply-all-everything" onClick={() => applyToAll({ description: true, tags: true, settings: true })}>Tudo</Button>
            </div>
          </div>
        ) : null}
      </Section>

      {active ? (
        <>
          {/* ── arquivo selecionado ── */}
          <Section icon="📄" title="Arquivo selecionado" subtitle={active.name}>
            <div className="yt-file-grid">
              <div className="yt-file-preview">
                {active.previewUrl ? (
                  <video src={active.previewUrl} controls playsInline preload="metadata" />
                ) : active.poster ? (
                  <img src={active.poster} alt={`Prévia de ${active.name}`} />
                ) : (
                  <span aria-hidden="true">🎬</span>
                )}
                {active.fromLoopSync ? <span className="yt-flag">Gerado no LoopSync</span> : null}
              </div>
              <dl className="yt-file-meta">
                <div><dt>Nome</dt><dd title={active.name}>{active.name}</dd></div>
                <div><dt>Tamanho</dt><dd>{formatBytes(active.size)}</dd></div>
                <div><dt>Duração</dt><dd>{active.duration ? formatDuration(active.duration) : "—"}</dd></div>
                <div><dt>Formato</dt><dd>{active.format || "—"}</dd></div>
                {active.width ? <div><dt>Resolução</dt><dd>{active.width}×{active.height}</dd></div> : null}
              </dl>
            </div>
          </Section>

          {/* ── template ── */}
          <Section
            icon="🧩"
            title="Template"
            subtitle="Aplique um template existente ao vídeo (título, descrição, tags e configurações)"
            aside={active.meta.templateName ? <span className="yt-badge tone-accent">{active.meta.templateName}</span> : null}
          >
            <div className="yt-template-grid">
              {templates.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  className={`yt-template${active.meta.templateId === template.id ? " active" : ""}`}
                  data-testid={`template-${template.id}`}
                  onClick={() => applyTemplate(template.id)}
                >
                  <strong>{template.name}</strong>
                  <small>{template.description || (template.tags || []).slice(0, 4).join(" · ")}</small>
                  <span className="yt-template-tags">{(template.tags || []).slice(0, 5).map((tag) => <em key={tag}>{tag}</em>)}</span>
                </button>
              ))}
            </div>
            {active.meta.templateId ? (
              <Button variant="ghost" size="sm" onClick={() => patchMeta(active.id, { templateId: null, templateName: null })}>
                Remover template
              </Button>
            ) : null}
          </Section>

          {/* ── título ── */}
          <Section icon="🔤" title="Título" subtitle="Aparece nos resultados de busca e na página do vídeo">
            <Field
              label="Título do vídeo"
              htmlFor="ytTitle"
              counter={{ text: `${active.meta.title.length}/${limits.title}`, over: active.meta.title.length > limits.title }}
              error={active.meta.title.length > limits.title ? `Máximo de ${limits.title} caracteres.` : null}
            >
              <TextInput
                id="ytTitle"
                value={active.meta.title}
                maxLength={limits.title + 20}
                placeholder="Ex.: Mix de música eletrônica — set ao vivo"
                onChange={(event) => patchMeta(active.id, { title: event.target.value })}
              />
            </Field>
          </Section>

          {/* ── descrição ── */}
          <Section
            icon="📝"
            title="Descrição"
            subtitle="Use uma descrição salva e edite à vontade — a versão salva só muda se você pedir"
            aside={
              active.meta.descriptionSourceId ? (
                <span className="yt-badge tone-accent">
                  {active.meta.descriptionSourceName}
                  {active.meta.descriptionDirty ? " · editada" : ""}
                </span>
              ) : null
            }
          >
            <Field
              label="Descrição do vídeo"
              htmlFor="ytDescription"
              counter={{ text: `${active.meta.description.length}/${limits.description}`, over: active.meta.description.length > limits.description }}
            >
              <TextArea
                id="ytDescription"
                rows={8}
                value={active.meta.description}
                placeholder="Descreva o vídeo, adicione links, capítulos e redes sociais…"
                onChange={(event) => editDescription(event.target.value)}
              />
            </Field>

            <div className="yt-row-actions">
              <Button variant="ghost" size="sm" icon="📚" data-testid="pick-description" onClick={() => setModal({ type: "pickDescription" })}>
                Usar descrição salva
              </Button>
              <Button variant="ghost" size="sm" icon="💾" data-testid="save-description" onClick={() => { setModal({ type: "saveDescription" }); setDraftName(active.meta.descriptionSourceName || ""); }}>
                Salvar como nova
              </Button>
              {active.meta.descriptionSourceId ? (
                <Button variant="ghost" size="sm" icon="↺" data-testid="update-saved-description" onClick={saveDescriptionBack} disabled={!active.meta.descriptionDirty}>
                  Atualizar descrição salva
                </Button>
              ) : null}
            </div>

            {descriptions.length ? (
              <div className="yt-mini-list">
                <strong>Descrições salvas</strong>
                <ul>
                  {descriptions.slice(0, 4).map((description) => (
                    <li key={description.id}>
                      <button type="button" onClick={() => applyDescription(description)} title={description.content}>
                        <span>{description.name}</span>
                        <small>{description.content.slice(0, 60)}{description.content.length > 60 ? "…" : ""}</small>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </Section>

          {/* ── tags ── */}
          <Section
            icon="🏷️"
            title="Tags"
            subtitle="Palavras-chave enviadas ao YouTube — adicione, remova, edite e reordene"
            aside={active.meta.tagSetSourceName ? <span className="yt-badge tone-accent">{active.meta.tagSetSourceName}{active.meta.tagsDirty ? " · editadas" : ""}</span> : null}
          >
            <TagEditor
              tags={active.meta.tags}
              onChange={onTagsChange}
              maxTotal={limits.tagsTotalChars}
              suggestions={showSuggestions ? suggestions : []}
            />

            <div className="yt-row-actions">
              <Button variant="ghost" size="sm" icon="✨" data-testid="generate-suggestions" onClick={generateSuggestions} disabled={suggesting}>
                {suggesting ? "Gerando…" : "Gerar sugestões"}
              </Button>
              <Button variant="ghost" size="sm" icon="🗂️" data-testid="pick-tagset" onClick={() => setModal({ type: "pickTagSet" })}>
                Usar tags salvas
              </Button>
              <Button variant="ghost" size="sm" icon="💾" data-testid="save-tagset" onClick={() => { setModal({ type: "saveTagSet" }); setDraftName(active.meta.tagSetSourceName || ""); }}>
                Salvar conjunto
              </Button>
              {active.meta.tagSetSourceIds && active.meta.tagSetSourceIds.length ? (
                <Button variant="ghost" size="sm" icon="↺" data-testid="update-saved-tagset" onClick={saveTagsBack} disabled={!active.meta.tagsDirty}>
                  Salvar alterações
                </Button>
              ) : null}
            </div>

            <Field label="Assunto (melhora as sugestões)" htmlFor="ytSubject" hint="Ex.: set de house gravado em São Paulo">
              <TextInput
                id="ytSubject"
                value={active.meta.subject}
                placeholder="Sobre o que é o vídeo?"
                onChange={(event) => patchMeta(active.id, { subject: event.target.value })}
              />
            </Field>
          </Section>

          {/* ── configurações ── */}
          <Section icon="⚙️" title="Configurações do YouTube" subtitle="Privacidade, categoria, playlist e miniatura">
            <Field label="Privacidade" hint="Você pode mudar depois direto no YouTube Studio.">
              <Segmented
                name="Privacidade"
                options={(status && status.privacyOptions) || [
                  { id: "public", label: "Público" },
                  { id: "unlisted", label: "Não listado" },
                  { id: "private", label: "Privado" },
                ]}
                value={active.meta.privacyStatus}
                onChange={(value) => patchMeta(active.id, { privacyStatus: value })}
              />
            </Field>

            <div className="yt-two-col">
              <Field
                label="Categoria"
                htmlFor="ytCategory"
                hint={categoriesFallback ? "Lista padrão (a API não retornou categorias)." : loading.categories ? "Carregando categorias…" : "Categorias do canal via API"}
              >
                <Select
                  id="ytCategory"
                  value={active.meta.categoryId}
                  onChange={(event) => {
                    const found = categories.find((item) => item.id === event.target.value);
                    patchMeta(active.id, { categoryId: event.target.value, categoryTitle: (found && found.title) || "" });
                  }}
                >
                  <option value="">Selecionar categoria</option>
                  {categories.map((category) => (
                    <option key={category.id} value={category.id}>{category.title}</option>
                  ))}
                </Select>
              </Field>

              <Field label="Playlist" htmlFor="ytPlaylist" hint={playlists.length ? `${playlists.length} playlist(s) do canal` : "Nenhuma playlist encontrada no canal"}>
                <Select
                  id="ytPlaylist"
                  value={active.meta.playlistId}
                  onChange={(event) => {
                    const found = playlists.find((item) => item.id === event.target.value);
                    patchMeta(active.id, { playlistId: event.target.value, playlistTitle: (found && found.title) || "" });
                  }}
                >
                  <option value="">Não adicionar a playlist</option>
                  {playlists.map((playlist) => (
                    <option key={playlist.id} value={playlist.id}>{playlist.title} ({playlist.itemCount})</option>
                  ))}
                </Select>
              </Field>
            </div>

            <div className="yt-two-col">
              <Field label="Idioma do vídeo" htmlFor="ytLanguage">
                <Select id="ytLanguage" value={active.meta.language} onChange={(event) => patchMeta(active.id, { language: event.target.value })}>
                  {LANGUAGE_OPTIONS.map((option) => (
                    <option key={option.id} value={option.id}>{option.label}</option>
                  ))}
                </Select>
              </Field>
              <div className="yt-toggles">
                <Toggle
                  checked={active.meta.madeForKids}
                  onChange={(value) => patchMeta(active.id, { madeForKids: value })}
                  label="Conteúdo para crianças"
                  description="Obrigatório pela lei COPPA. Desative se não for infantil."
                />
                <Toggle
                  checked={active.meta.notifySubscribers}
                  onChange={(value) => patchMeta(active.id, { notifySubscribers: value })}
                  label="Notificar inscritos"
                  description="Envia notificação aos inscritos do canal."
                />
              </div>
            </div>

            <Field label="Thumbnail" hint="JPG, PNG, GIF, BMP ou WEBP — até 2 MB (recomendado 1280×720).">
              <div className="yt-thumb">
                <div className="yt-thumb-preview">
                  {active.meta.thumbnail ? (
                    <img src={active.meta.thumbnail.dataUrl} alt="Prévia da miniatura" />
                  ) : (
                    <span aria-hidden="true">🖼️</span>
                  )}
                  {active.meta.thumbnail ? <span className="yt-thumb-source">{active.meta.thumbnail.source === "frame" ? "Quadro do vídeo" : active.meta.thumbnail.name}</span> : null}
                </div>
                <div className="yt-thumb-actions">
                  <input
                    ref={thumbInputRef}
                    data-testid="thumbnail-input"
                    type="file"
                    accept="image/*"
                    hidden
                    onChange={(event) => {
                      onThumbnailFile(event.target.files && event.target.files[0]);
                      event.target.value = "";
                    }}
                  />
                  <Button variant="subtle" size="sm" data-testid="pick-thumbnail" onClick={() => thumbInputRef.current && thumbInputRef.current.click()}>
                    {active.meta.thumbnail ? "Trocar imagem" : "Selecionar imagem"}
                  </Button>
                  {active.poster ? (
                    <Button variant="ghost" size="sm" data-testid="use-frame-thumbnail" onClick={useFrameAsThumbnail}>Usar quadro do vídeo</Button>
                  ) : null}
                  {active.meta.thumbnail ? (
                    <Button variant="ghost" size="sm" data-testid="remove-thumbnail" onClick={() => patchMeta(active.id, { thumbnail: null })}>Remover</Button>
                  ) : null}
                </div>
              </div>
            </Field>
          </Section>

          {/* ── revisão / envio ── */}
          <AnimatePresence mode="wait">
            {view === "review" ? (
              <motion.div key="review" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                <Section icon="👀" title="Revisão" subtitle="Confira tudo antes de enviar — você pode voltar e editar qualquer informação">
                  <div className="yt-review">
                    <div className="yt-review-thumb">
                      {active.meta.thumbnail ? <img src={active.meta.thumbnail.dataUrl} alt="Miniatura" /> : <span aria-hidden="true">🎬</span>}
                      <span className="yt-review-duration">{active.duration ? formatDuration(active.duration) : "--:--"}</span>
                    </div>
                    <dl>
                      <div><dt>Título</dt><dd>{active.meta.title || "—"}</dd></div>
                      <div><dt>Descrição</dt><dd className="pre">{active.meta.description || "—"}</dd></div>
                      <div>
                        <dt>Tags ({active.meta.tags.length})</dt>
                        <dd className="yt-review-tags">{active.meta.tags.length ? active.meta.tags.map((tag) => <em key={tag}>{tag}</em>) : "—"}</dd>
                      </div>
                      <div><dt>Categoria</dt><dd>{active.meta.categoryTitle || (categories.find((c) => c.id === active.meta.categoryId) || {}).title || "Não definida"}</dd></div>
                      <div><dt>Privacidade</dt><dd>{({ public: "Público", unlisted: "Não listado", private: "Privado" })[active.meta.privacyStatus]}</dd></div>
                      <div><dt>Playlist</dt><dd>{active.meta.playlistTitle || (playlists.find((p) => p.id === active.meta.playlistId) || {}).title || "Nenhuma"}</dd></div>
                      <div><dt>Canal</dt><dd>{(channel && channel.title) || "—"}</dd></div>
                      <div><dt>Arquivo</dt><dd>{active.name} · {formatBytes(active.size)}</dd></div>
                    </dl>
                  </div>
                  <div className="yt-actions">
                    <Button variant="ghost" onClick={() => setView("config")}>← Voltar e editar</Button>
                    <Button variant="primary" icon="▶" data-testid="send-to-youtube" onClick={() => sendItem(active)} disabled={sending}>
                      Enviar para o YouTube
                    </Button>
                  </div>
                </Section>
              </motion.div>
            ) : null}
          </AnimatePresence>

          {/* ── progresso ── */}
          {active.upload && ["queued", "uploading", "processing"].includes(active.upload.status) ? (
            <Section icon="📡" title="Enviando para o YouTube" subtitle={active.meta.title || active.name} tone="accent">
              <ProgressBar
                percent={active.upload.status === "processing" ? 100 : active.upload.progress || 0}
                indeterminate={active.upload.status === "processing"}
              />
              <p className="yt-progress-text">
                <StatusBadge status={active.upload.status} />
                <span>
                  {active.upload.phase === "reconectando"
                    ? `Conexão interrompida — tentando retomar em ${active.upload.retryIn || 5}s (envio não recomeça)`
                    : active.upload.phase === "retomando"
                      ? "Retomando envio de onde parou…"
                      : active.upload.status === "processing"
                        ? "Vídeo enviado. O YouTube está processando…"
                        : `${formatBytes(active.upload.received || 0)} de ${formatBytes(active.size)}`}
                </span>
              </p>
              {active.upload.warning ? <p className="yt-warning">{active.upload.warning}</p> : null}
              <div className="yt-actions">
                <Button variant="ghost" icon="■" onClick={() => cancelItem(active)}>Cancelar envio</Button>
              </div>
            </Section>
          ) : null}

          {/* ── erro ── */}
          {active.upload && active.upload.status === "error" ? (
            <Section icon="⚠️" title="Falha no envio" tone="danger">
              <p className="yt-error-block">{active.upload.error}</p>
              <div className="yt-actions">
                <Button variant="ghost" onClick={() => setView("config")}>Editar dados</Button>
                <Button variant="primary" icon="↻" onClick={() => retryItem(active)}>Retomar envio</Button>
              </div>
            </Section>
          ) : null}

          {/* ── concluído ── */}
          {active.upload && active.upload.status === "done" ? (
            <Section icon="✅" title="Upload concluído com sucesso!" tone="ok" data-testid="upload-done">
              <div className="yt-done">
                <div className="yt-done-thumb">
                  {active.upload.thumbnailUrl ? (
                    <img src={active.upload.thumbnailUrl} alt="Miniatura do vídeo publicado" />
                  ) : active.meta.thumbnail ? (
                    <img src={active.meta.thumbnail.dataUrl} alt="Miniatura" />
                  ) : (
                    <span aria-hidden="true">🎬</span>
                  )}
                </div>
                <dl>
                  <div><dt>Título</dt><dd>{active.meta.title}</dd></div>
                  <div><dt>ID do vídeo</dt><dd className="mono">{active.upload.videoId || "—"}</dd></div>
                  <div><dt>Link</dt><dd><a href={active.upload.videoUrl} target="_blank" rel="noreferrer noopener">{active.upload.videoUrl}</a></dd></div>
                  <div><dt>Privacidade</dt><dd>{({ public: "Público", unlisted: "Não listado", private: "Privado" })[active.meta.privacyStatus]}</dd></div>
                  {active.upload.thumbnailError ? <div><dt>Miniatura</dt><dd>{active.upload.thumbnailError}</dd></div> : null}
                  {active.upload.playlistError ? <div><dt>Playlist</dt><dd>{active.upload.playlistError}</dd></div> : null}
                </dl>
              </div>
              <div className="yt-actions">
                <a className="btn primary yt-btn" data-testid="open-on-youtube" href={active.upload.videoUrl} target="_blank" rel="noreferrer noopener">
                  <span className="yt-btn-icon" aria-hidden="true">▶</span> Abrir no YouTube
                </a>
                <Button variant="ghost" onClick={() => { patchItem(active.id, { upload: null }); setView("config"); }}>
                  Enviar outro vídeo
                </Button>
              </div>
            </Section>
          ) : null}

          {/* ── barra de ações ── */}
          {view === "config" ? (
            <div className="yt-actionbar">
              <Button variant="ghost" data-testid="open-queue" onClick={() => setModal({ type: "queue" })} disabled={items.length < 2}>
                Fila ({items.length})
              </Button>
              {items.length > 1 ? (
                <Button variant="subtle" icon="⏩" data-testid="send-all" onClick={queueRunning ? stopQueue : sendQueue} disabled={!connected}>
                  {queueRunning ? "Parar fila" : `Enviar todos (${items.filter((i) => !i.upload || ["error", "cancelled"].includes(i.upload.status)).length})`}
                </Button>
              ) : null}
              <Button variant="primary" icon="👀" data-testid="goto-review" onClick={() => setView("review")} disabled={!canSend && !active.meta.title.trim()}>
                Revisar e enviar
              </Button>
            </div>
          ) : null}
        </>
      ) : null}

      {/* ── modais ── */}
      <Modal
        open={modal && modal.type === "pickDescription"}
        title="Usar descrição salva"
        description="O conteúdo é copiado para o vídeo — a descrição salva não é alterada."
        onClose={() => setModal(null)}
        footer={<Button variant="ghost" data-testid="close-description-picker" onClick={() => setModal(null)}>Fechar</Button>}
      >
        {descriptions.length ? (
          <ul className="yt-picker">
            {descriptions.map((description) => (
              <li key={description.id}>
                <div className="yt-picker-item">
                  <div className="yt-picker-text">
                    <strong>{description.name}</strong>
                    <small>{description.content.slice(0, 120)}{description.content.length > 120 ? "…" : ""}</small>
                    <span className="yt-picker-meta">{description.tags ? "" : ""}Atualizada em {new Date(description.updatedAt).toLocaleString("pt-BR")}</span>
                  </div>
                  <Button
                    variant="subtle"
                    size="sm"
                    data-testid={`use-description-${description.id}`}
                    onClick={() => {
                      applyDescription(description);
                      setModal(null);
                    }}
                  >
                    Usar descrição
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState icon="📝" title="Nenhuma descrição salva" description="Crie uma descrição na aba Biblioteca para reutilizar aqui." />
        )}
      </Modal>

{active ? <Modal
        open={modal && modal.type === "saveDescription"}
        title="Salvar descrição"
        description="Guarde esta descrição para usar em outros vídeos."
        onClose={() => setModal(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setModal(null)}>Cancelar</Button>
            <Button
              variant="primary"
              data-testid="save-description-confirm"
              onClick={async () => {
                if (!draftName.trim()) {
                  showToast("Informe um nome para a descrição.", "error");
                  return;
                }
                try {
                  const item = await actions.createDescription({ name: draftName.trim(), content: active.meta.description });
                  patchMeta(active.id, { descriptionSourceId: item.id, descriptionSourceName: item.name, descriptionDirty: false });
                  setModal(null);
                  setDraftName("");
                  showToast("Descrição salva na biblioteca.", "success");
                } catch (err) {
                  showToast(err.message, "error");
                }
              }}
            >
              Salvar descrição
            </Button>
          </>
        }
      >
        <Field label="Nome da descrição" htmlFor="descName" counter={{ text: `${draftName.length}/80`, over: draftName.length > 80 }}>
          <TextInput id="descName" value={draftName} maxLength={80} onChange={(event) => setDraftName(event.target.value)} placeholder="Ex.: Descrição padrão de músicas" />
        </Field>
        <Field label="Conteúdo" hint={`${active.meta.description.length} caracteres`}>
          <TextArea rows={5} readOnly value={active.meta.description} />
        </Field>
      </Modal>
       : null}

      <Modal
        open={modal && modal.type === "pickTagSet"}
        title="Usar tags salvas"
        description="As tags são somadas às atuais. Você pode editar tudo antes do envio."
        onClose={() => setModal(null)}
        footer={<Button variant="ghost" data-testid="close-tagset-picker" onClick={() => setModal(null)}>Fechar</Button>}
      >
        {tagSets.length ? (
          <ul className="yt-picker">
            {tagSets.map((tagSet) => (
              <li key={tagSet.id}>
                <div className="yt-picker-item">
                  <div className="yt-picker-text">
                    <strong>{tagSet.name}</strong>
                    <small>{(tagSet.tags || []).join(", ")}</small>
                    <span className="yt-picker-meta">{(tagSet.tags || []).length} tags</span>
                  </div>
                  <span className="yt-picker-actions">
                    <Button variant="subtle" size="sm" data-testid={`use-tagset-${tagSet.id}`} onClick={() => { applyTagSet(tagSet); }}>Somar</Button>
                    <Button variant="ghost" size="sm" data-testid={`replace-tagset-${tagSet.id}`} onClick={() => { applyTagSet(tagSet, { replace: true }); setModal(null); }}>Substituir</Button>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState icon="🏷️" title="Nenhum conjunto salvo" description="Salve um conjunto de tags na aba Biblioteca para reutilizar." />
        )}
      </Modal>

{active ?       <Modal
        open={modal && modal.type === "saveTagSet"}
        title="Salvar conjunto de tags"
        onClose={() => setModal(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setModal(null)}>Cancelar</Button>
            <Button
              variant="primary"
              data-testid="save-tagset-confirm"
              onClick={async () => {
                if (!draftName.trim()) {
                  showToast("Informe um nome para o conjunto.", "error");
                  return;
                }
                try {
                  await actions.createTagSet({ name: draftName.trim(), tags: active.meta.tags });
                  setModal(null);
                  setDraftName("");
                  showToast("Conjunto de tags salvo.", "success");
                } catch (err) {
                  showToast(err.message, "error");
                }
              }}
            >
              Salvar conjunto
            </Button>
          </>
        }
      >
        <Field label="Nome do conjunto" htmlFor="tagSetName" counter={{ text: `${draftName.length}/80`, over: draftName.length > 80 }}>
          <TextInput id="tagSetName" value={draftName} maxLength={80} onChange={(event) => setDraftName(event.target.value)} placeholder="Ex.: Tags Música" />
        </Field>
        <Field label={`Tags (${active.meta.tags.length})`}>
          <div className="yt-tag-preview">{active.meta.tags.length ? active.meta.tags.map((tag) => <em key={tag}>{tag}</em>) : "Nenhuma tag"}</div>
        </Field>
      </Modal>
       : null}

{modal ?       <Modal
        open={modal && modal.type === "chooseTagSet"}
        title="Atualizar qual conjunto?"
        description="As tags deste vídeo vieram de mais de um conjunto. Escolha qual atualizar."
        onClose={() => setModal(null)}
        size="sm"
      >
        <ul className="yt-picker">
          {(modal.sourceIds || []).map((id) => {
            const tagSet = tagSets.find((item) => item.id === id);
            if (!tagSet) return null;
            return (
              <li key={id}>
                <div className="yt-picker-item">
                  <div className="yt-picker-text">
                    <strong>{tagSet.name}</strong>
                    <small>{(tagSet.tags || []).join(", ")}</small>
                  </div>
                  <Button
                    variant="subtle"
                    size="sm"
                    data-testid={`choose-tagset-${tagSet.id}`}
                    onClick={async () => {
                      try {
                        await actions.updateTagSet(tagSet.id, { name: tagSet.name, tags: active.meta.tags });
                        patchMeta(active.id, { tagsDirty: false });
                        setModal(null);
                        showToast(`Conjunto "${tagSet.name}" atualizado.`, "success");
                      } catch (err) {
                        showToast(err.message, "error");
                      }
                    }}
                  >
                    Atualizar
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      </Modal>
       : null}

      <Modal open={modal && modal.type === "queue"} title="Fila de envio" description="Configure cada vídeo individualmente ou envie todos em sequência." onClose={() => setModal(null)}>
        <ul className="yt-picker">
          {items.map((item, index) => (
            <li key={item.id}>
              <div className="yt-picker-item">
                <div className="yt-picker-text">
                  <strong>{index + 1}. {item.meta.title || item.name}</strong>
                  <small>{item.name} · {formatBytes(item.size)}</small>
                </div>
                <span className="yt-picker-actions">
                  {item.upload ? <StatusBadge status={item.upload.status} /> : <StatusBadge status="queued" label="Aguardando" />}
                  <Button variant="ghost" size="sm" onClick={() => { setActiveId(item.id); setModal(null); setView("config"); }}>Configurar</Button>
                </span>
              </div>
            </li>
          ))}
        </ul>
      </Modal>

      {connectModal}

      <ConfirmDialog
        open={Boolean(confirmState)}
        title={confirmState && confirmState.type === "clearQueue" ? "Limpar fila de vídeos?" : "Confirmar"}
        description="Todos os vídeos selecionados e configurações não enviadas serão descartados."
        confirmLabel="Limpar fila"
        onCancel={() => setConfirmState(null)}
        onConfirm={() => {
          for (const controller of controllersRef.current.values()) controller.abort();
          controllersRef.current.clear();
          setItems([]);
          setActiveId(null);
          setView("config");
          setConfirmState(null);
          showToast("Fila limpa.", "info");
        }}
      />

      {suggesting ? (
        <div className="yt-float-loading">
          <Spinner label="Gerando sugestões" /> Gerando sugestões de tags…
        </div>
      ) : null}
    </div>
  );
}
