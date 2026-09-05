import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";

/* ─── primitivos visuais do módulo YouTube ─────────────────────────
   Seguem os mesmos tokens (cores, raios, espaçamentos) do LoopSync.  */

export function Section({ icon, title, subtitle, aside, children, id, tone = "default", ...rest }) {
  return (
    <section className={`yt-section${tone !== "default" ? ` yt-section--${tone}` : ""}`} id={id} {...rest}>
      <header className="yt-section-head">
        <div className="yt-section-title">
          {icon ? <span className="yt-section-icon" aria-hidden="true">{icon}</span> : null}
          <div>
            <h2>{title}</h2>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
        </div>
        {aside ? <div className="yt-section-aside">{aside}</div> : null}
      </header>
      <div className="yt-section-body">{children}</div>
    </section>
  );
}

export function Field({ label, hint, counter, children, htmlFor, error }) {
  return (
    <div className={`yt-field${error ? " has-error" : ""}`}>
      <div className="yt-field-head">
        <label htmlFor={htmlFor}>{label}</label>
        {counter ? <span className="yt-counter" data-over={counter.over ? "true" : undefined}>{counter.text}</span> : null}
      </div>
      {children}
      {error ? <p className="yt-error">{error}</p> : hint ? <p className="yt-hint">{hint}</p> : null}
    </div>
  );
}

export function TextInput(props) {
  return <input type="text" className="yt-input" {...props} />;
}

export function TextArea(props) {
  return <textarea className="yt-input yt-textarea" {...props} />;
}

export function Select({ children, ...props }) {
  return (
    <div className="yt-select">
      <select className="yt-input" {...props}>
        {children}
      </select>
      <span className="yt-select-arrow" aria-hidden="true">▾</span>
    </div>
  );
}

export function Counter({ value, max }) {
  return { text: `${value}/${max}`, over: value > max };
}

export function Button({ variant = "subtle", size = "md", icon, children, ...props }) {
  return (
    <button type="button" className={`btn ${variant} yt-btn yt-btn--${size}`} {...props}>
      {icon ? <span className="yt-btn-icon" aria-hidden="true">{icon}</span> : null}
      {children}
    </button>
  );
}

export function Toggle({ checked, onChange, label, description }) {
  return (
    <button
      type="button"
      className={`yt-toggle${checked ? " on" : ""}`}
      role="switch"
      aria-checked={Boolean(checked)}
      onClick={() => onChange(!checked)}
    >
      <span className="yt-toggle-track" aria-hidden="true">
        <span className="yt-toggle-thumb" />
      </span>
      <span className="yt-toggle-text">
        <strong>{label}</strong>
        {description ? <small>{description}</small> : null}
      </span>
    </button>
  );
}

export function Segmented({ options, value, onChange, name }) {
  return (
    <div className="yt-segmented" role="radiogroup" aria-label={name}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={value === option.id}
          className={`yt-segment${value === option.id ? " active" : ""}`}
          onClick={() => onChange(option.id)}
          title={option.hint || option.label}
        >
          <strong>{option.label}</strong>
          {option.hint ? <small>{option.hint}</small> : null}
        </button>
      ))}
    </div>
  );
}

export function ProgressBar({ percent, tone = "accent", indeterminate = false, label }) {
  const value = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  return (
    <div className="yt-progress">
      <div
        className={`yt-progress-track${indeterminate ? " indeterminate" : ""}`}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={indeterminate ? undefined : value}
        aria-label={label || "Progresso"}
      >
        <motion.div
          className={`yt-progress-fill tone-${tone}`}
          animate={indeterminate ? { x: ["-100%", "100%"] } : { width: `${value}%` }}
          transition={indeterminate ? { repeat: Infinity, duration: 1.1, ease: "linear" } : { type: "spring", stiffness: 140, damping: 22 }}
          style={indeterminate ? { width: "40%" } : undefined}
        />
      </div>
      <span className="yt-progress-value">{indeterminate ? "…" : `${value}%`}</span>
    </div>
  );
}

const STATUS_LABEL = {
  queued: "Aguardando",
  uploading: "Enviando",
  processing: "Processando",
  done: "Concluído",
  error: "Erro",
  cancelled: "Cancelado",
};

const STATUS_TONE = {
  queued: "idle",
  uploading: "accent",
  processing: "warn",
  done: "ok",
  error: "danger",
  cancelled: "idle",
};

export function StatusBadge({ status, label }) {
  const tone = STATUS_TONE[status] || "idle";
  return (
    <span className={`yt-badge tone-${tone}`}>
      {status === "uploading" || status === "processing" ? <span className="yt-badge-dot" aria-hidden="true" /> : null}
      {label || STATUS_LABEL[status] || status}
    </span>
  );
}

export function EmptyState({ icon = "📭", title, description, action }) {
  return (
    <div className="yt-empty">
      <span className="yt-empty-icon" aria-hidden="true">{icon}</span>
      <strong>{title}</strong>
      {description ? <p>{description}</p> : null}
      {action}
    </div>
  );
}

export function Modal({ open, title, description, onClose, children, footer, size = "md" }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key === "Escape") onClose && onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          className="yt-modal-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          role="presentation"
        >
          <motion.div
            className={`yt-modal size-${size}`}
            role="dialog"
            aria-modal="true"
            aria-label={title}
            initial={{ opacity: 0, y: 24, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 260, damping: 26 }}
            onClick={(event) => event.stopPropagation()}
          >
            <header className="yt-modal-head">
              <div>
                <h3>{title}</h3>
                {description ? <p>{description}</p> : null}
              </div>
              <button type="button" className="yt-icon-btn" onClick={onClose} aria-label="Fechar">
                ✕
              </button>
            </header>
            <div className="yt-modal-body">{typeof children === "function" ? children() : children}</div>
            {footer ? <footer className="yt-modal-foot">{footer}</footer> : null}
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

export function ConfirmDialog({ open, title, description, confirmLabel = "Confirmar", tone = "danger", onConfirm, onCancel, confirmTestId }) {
  return (
    <Modal
      open={open}
      title={title}
      description={description}
      onClose={onCancel}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>Cancelar</Button>
          <Button variant={tone === "danger" ? "danger" : "primary"} data-testid={confirmTestId} onClick={onConfirm}>{confirmLabel}</Button>
        </>
      }
    >
      <p className="yt-modal-text">Esta ação não pode ser desfeita.</p>
    </Modal>
  );
}

/* ─── chips de tags (adicionar / remover / editar / reordenar) ───── */

export function TagEditor({
  tags,
  onChange,
  maxTotal = 500,
  placeholder = "Digite uma tag e pressione Enter",
  suggestions = [],
  onAcceptSuggestion,
  busy = false,
}) {
  const [draft, setDraft] = useState("");
  const [editingIndex, setEditingIndex] = useState(null);
  const [editValue, setEditValue] = useState("");
  const dragIndex = useRef(null);
  const inputId = useId();

  const total = tags.reduce((acc, tag, index) => acc + tag.length + (index ? 1 : 0), 0);

  const addTag = useCallback(
    (raw) => {
      const value = String(raw || "").replace(/,/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
      if (!value) return;
      const key = value.toLowerCase();
      if (tags.some((tag) => tag.toLowerCase() === key)) return;
      if (total + value.length + (tags.length ? 1 : 0) > maxTotal) return;
      onChange([...tags, value]);
    },
    [tags, onChange, total, maxTotal]
  );

  const addMany = useCallback(
    (list) => {
      let next = [...tags];
      let used = total;
      for (const raw of list) {
        const value = String(raw || "").replace(/,/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
        if (!value) continue;
        const key = value.toLowerCase();
        if (next.some((tag) => tag.toLowerCase() === key)) continue;
        const cost = value.length + (next.length ? 1 : 0);
        if (used + cost > maxTotal) break;
        used += cost;
        next.push(value);
      }
      onChange(next);
    },
    [tags, onChange, total, maxTotal]
  );

  const removeAt = (index) => onChange(tags.filter((_, i) => i !== index));

  const move = (index, direction) => {
    const target = index + direction;
    if (target < 0 || target >= tags.length) return;
    const next = [...tags];
    const [item] = next.splice(index, 1);
    next.splice(target, 0, item);
    onChange(next);
  };

  const commitEdit = (index) => {
    const value = editValue.replace(/,/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
    setEditingIndex(null);
    if (!value) {
      removeAt(index);
      return;
    }
    const next = [...tags];
    next[index] = value;
    onChange(next.filter((tag, i) => next.findIndex((t) => t.toLowerCase() === tag.toLowerCase()) === i));
  };

  const onKeyDown = (event) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      if (draft.trim()) {
        addTag(draft);
        setDraft("");
      }
    } else if (event.key === "Backspace" && !draft && tags.length) {
      removeAt(tags.length - 1);
    }
  };

  const onPaste = (event) => {
    const text = event.clipboardData ? event.clipboardData.getData("text") : "";
    if (!text || !text.includes(",")) return;
    event.preventDefault();
    addMany(text.split(","));
    setDraft("");
  };

  return (
    <div className="yt-tags">
      <div className="yt-tag-list" aria-live="polite">
        <AnimatePresence initial={false}>
          {tags.map((tag, index) => (
            <motion.span
              key={`${tag}-${index}`}
              className="yt-tag"
              layout
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              transition={{ type: "spring", stiffness: 320, damping: 28 }}
              draggable={editingIndex !== index}
              onDragStart={() => {
                dragIndex.current = index;
              }}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => {
                if (dragIndex.current === null || dragIndex.current === index) return;
                const next = [...tags];
                const [moved] = next.splice(dragIndex.current, 1);
                next.splice(index, 0, moved);
                dragIndex.current = null;
                onChange(next);
              }}
            >
              {editingIndex === index ? (
                <input
                  className="yt-tag-input"
                  value={editValue}
                  autoFocus
                  onChange={(event) => setEditValue(event.target.value)}
                  onBlur={() => commitEdit(index)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") commitEdit(index);
                    if (event.key === "Escape") setEditingIndex(null);
                  }}
                />
              ) : (
                <>
                  <span className="yt-tag-text">{tag}</span>
                  <span className="yt-tag-tools">
                    <button
                      type="button"
                      aria-label={`Mover ${tag} para trás`}
                      onClick={() => move(index, -1)}
                      disabled={index === 0}
                    >
                      ‹
                    </button>
                    <button
                      type="button"
                      aria-label={`Mover ${tag} para frente`}
                      onClick={() => move(index, 1)}
                      disabled={index === tags.length - 1}
                    >
                      ›
                    </button>
                    <button
                      type="button"
                      aria-label={`Editar ${tag}`}
                      onClick={() => {
                        setEditingIndex(index);
                        setEditValue(tag);
                      }}
                    >
                      ✎
                    </button>
                    <button type="button" aria-label={`Remover ${tag}`} onClick={() => removeAt(index)}>
                      ✕
                    </button>
                  </span>
                </>
              )}
            </motion.span>
          ))}
        </AnimatePresence>
        {!tags.length ? <span className="yt-tag-empty">Nenhuma tag adicionada</span> : null}
      </div>

      <div className="yt-tag-compose">
        <input
          id={inputId}
          className="yt-input"
          value={draft}
          placeholder={placeholder}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          maxLength={60}
        />
        <Button variant="subtle" size="sm" onClick={() => { addTag(draft); setDraft(""); }} disabled={!draft.trim()}>
          Adicionar
        </Button>
      </div>

      <div className="yt-tag-meter">
        <span>{tags.length} tags</span>
        <span data-over={total > maxTotal ? "true" : undefined}>
          {total}/{maxTotal} caracteres
        </span>
      </div>

      {suggestions && suggestions.length ? (
        <div className="yt-suggestions">
          <div className="yt-suggestions-head">
            <strong>Sugestões</strong>
            <div className="yt-suggestions-actions">
              <button type="button" className="yt-link" data-testid="add-all-suggestions" onClick={() => addMany(suggestions.map((s) => s.tag))} disabled={busy}>
                Adicionar todas
              </button>
              <button type="button" className="yt-link" data-testid="clear-tags" onClick={() => onChange([])} disabled={busy || !tags.length}>
                Limpar tags
              </button>
            </div>
          </div>
          <div className="yt-suggestion-list">
            {suggestions.map((suggestion) => {
              const already = tags.some((tag) => tag.toLowerCase() === suggestion.tag.toLowerCase());
              return (
                <button
                  key={suggestion.tag}
                  type="button"
                  className={`yt-suggestion${already ? " used" : ""}`}
                  data-testid={`suggestion-${suggestion.tag.replace(/[^a-z0-9]+/gi, "-")}`}
                  onClick={() => (already ? null : onAcceptSuggestion ? onAcceptSuggestion(suggestion) : addTag(suggestion.tag))}
                  disabled={already}
                  title={`${suggestion.source} · peso ${suggestion.score}`}
                >
                  <span>+ {suggestion.tag}</span>
                  <small>{suggestion.source}</small>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ─── lista selecionável (descrições / tags salvas / templates) ──── */

export function PickerList({ items, emptyTitle, emptyDescription, onSelect, renderItem, action }) {
  if (!items.length) {
    return (
      <EmptyState
        icon="🗂️"
        title={emptyTitle}
        description={emptyDescription}
        action={action}
      />
    );
  }
  return (
    <ul className="yt-picker">
      {items.map((item) => (
        <li key={item.id}>{renderItem(item)}</li>
      ))}
    </ul>
  );
}

export function Spinner({ label }) {
  return (
    <span className="yt-spinner" role="status" aria-label={label || "Carregando"}>
      <motion.span
        className="spinner-ring"
        animate={{ rotate: 360 }}
        transition={{ repeat: Infinity, duration: 1.1, ease: "linear" }}
      />
    </span>
  );
}

export function YouTubeMark({ size = 22 }) {
  return (
    <svg width={size} height={size * 0.7} viewBox="0 0 28 20" fill="none" aria-hidden="true">
      <rect x="0.5" y="0.5" width="27" height="19" rx="6" fill="#FF0000" />
      <path d="M11.4 5.8 L19 10 L11.4 14.2 Z" fill="#fff" />
    </svg>
  );
}
