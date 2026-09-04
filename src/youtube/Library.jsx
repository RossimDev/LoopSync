import React, { useCallback, useState } from "react";
import { motion } from "motion/react";
import { Section, Field, TextInput, TextArea, Button, Modal, ConfirmDialog, EmptyState, TagEditor } from "./ui.jsx";
import { formatDate } from "./api.js";

/**
 * Biblioteca do YouTube: descrições salvas, conjuntos de tags e templates.
 * "Usar" copia o conteúdo para o vídeo em configuração — o registro salvo só
 * muda quando o usuário pede explicitamente (Editar / Atualizar).
 */
export default function Library({ data, showToast, onUseDescription, onUseTagSet, onUseTemplate }) {
  const { descriptions, tagSets, templates, limits, loading, actions } = data;
  const [modal, setModal] = useState(null);
  const [confirmState, setConfirmState] = useState(null);
  const [form, setForm] = useState({ name: "", content: "", tags: [] });

  const openDescription = useCallback((description) => {
    setForm({
      name: description ? description.name : "",
      content: description ? description.content : "",
      tags: [],
    });
    setModal({ type: description ? "editDescription" : "newDescription", id: description && description.id });
  }, []);

  const openTagSet = useCallback((tagSet) => {
    setForm({
      name: tagSet ? tagSet.name : "",
      content: "",
      tags: tagSet ? [...(tagSet.tags || [])] : [],
    });
    setModal({ type: tagSet ? "editTagSet" : "newTagSet", id: tagSet && tagSet.id });
  }, []);

  const saveDescription = useCallback(async () => {
    if (!form.name.trim()) {
      showToast("Informe um nome para a descrição.", "error");
      return;
    }
    if (form.content.length > limits.description) {
      showToast(`A descrição pode ter no máximo ${limits.description} caracteres.`, "error");
      return;
    }
    try {
      if (modal.type === "editDescription") {
        await actions.updateDescription(modal.id, { name: form.name.trim(), content: form.content });
        showToast("Descrição atualizada.", "success");
      } else {
        await actions.createDescription({ name: form.name.trim(), content: form.content });
        showToast("Descrição salva na biblioteca.", "success");
      }
      setModal(null);
    } catch (err) {
      showToast(err.message || "Não foi possível salvar a descrição.", "error");
    }
  }, [actions, form.content, form.name, limits.description, modal, showToast]);

  const saveTagSet = useCallback(async () => {
    if (!form.name.trim()) {
      showToast("Informe um nome para o conjunto de tags.", "error");
      return;
    }
    if (!form.tags.length) {
      showToast("Adicione pelo menos uma tag.", "error");
      return;
    }
    try {
      if (modal.type === "editTagSet") {
        await actions.updateTagSet(modal.id, { name: form.name.trim(), tags: form.tags });
        showToast("Conjunto de tags atualizado.", "success");
      } else {
        await actions.createTagSet({ name: form.name.trim(), tags: form.tags });
        showToast("Conjunto de tags salvo.", "success");
      }
      setModal(null);
    } catch (err) {
      showToast(err.message || "Não foi possível salvar o conjunto.", "error");
    }
  }, [actions, form.name, form.tags, modal, showToast]);

  return (
    <div className="yt-library">
      {/* ── descrições salvas ── */}
      <Section
        icon="📝"
        title="Descrições salvas"
        subtitle={`${descriptions.length} descrição(ões) · reutilize e edite antes de cada upload`}
        aside={
          <Button variant="subtle" size="sm" icon="＋" data-testid="new-description" onClick={() => openDescription(null)} disabled={loading.descriptions}>
            Nova descrição
          </Button>
        }
      >
        {descriptions.length ? (
          <ul className="yt-cards">
            {descriptions.map((description) => (
              <motion.li
                key={description.id}
                className="yt-lib-item"
                layout
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ type: "spring", stiffness: 260, damping: 26 }}
              >
                <div className="yt-lib-head">
                  <strong title={description.name}>{description.name}</strong>
                  <span className="yt-lib-count">{description.content.length} caracteres</span>
                </div>
                <p className="yt-lib-content">{description.content || "(sem conteúdo)"}</p>
                <div className="yt-lib-meta">
                  <span>Criada em {formatDate(description.createdAt)}</span>
                  <span>Alterada em {formatDate(description.updatedAt)}</span>
                </div>
                <div className="yt-lib-actions">
                  <Button variant="primary" size="sm" icon="⤵" data-testid={`library-use-description-${description.id}`} onClick={() => onUseDescription(description)}>
                    Usar descrição
                  </Button>
                  <Button variant="ghost" size="sm" icon="✎" data-testid={`library-edit-description-${description.id}`} onClick={() => openDescription(description)}>Editar</Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon="⧉"
                    data-testid={`library-duplicate-description-${description.id}`}
                    onClick={async () => {
                      try {
                        await actions.duplicateDescription(description.id);
                        showToast("Descrição duplicada.", "success");
                      } catch (err) {
                        showToast(err.message, "error");
                      }
                    }}
                  >
                    Duplicar
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon="🗑"
                    data-testid={`library-delete-description-${description.id}`}
                    onClick={() => setConfirmState({ type: "description", item: description })}
                  >
                    Excluir
                  </Button>
                </div>
              </motion.li>
            ))}
          </ul>
        ) : (
          <EmptyState
            icon="📝"
            title="Nenhuma descrição salva"
            description="Crie descrições prontas para reaproveitar em vários vídeos — e edite a cópia antes de cada envio."
            action={<Button variant="primary" onClick={() => openDescription(null)}>Criar primeira descrição</Button>}
          />
        )}
      </Section>

      {/* ── tags salvas ── */}
      <Section
        icon="🏷️"
        title="Tags salvas"
        subtitle={`${tagSets.length} conjunto(s) · carregue, misture e edite as tags antes do upload`}
        aside={
          <Button variant="subtle" size="sm" icon="＋" data-testid="new-tagset" onClick={() => openTagSet(null)} disabled={loading.tagSets}>
            Novo conjunto
          </Button>
        }
      >
        {tagSets.length ? (
          <ul className="yt-cards">
            {tagSets.map((tagSet) => (
              <motion.li key={tagSet.id} className="yt-lib-item" layout initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
                <div className="yt-lib-head">
                  <strong title={tagSet.name}>{tagSet.name}</strong>
                  <span className="yt-lib-count">{(tagSet.tags || []).length} tags</span>
                </div>
                <div className="yt-tag-preview">
                  {(tagSet.tags || []).map((tag) => (
                    <em key={tag}>{tag}</em>
                  ))}
                </div>
                <div className="yt-lib-meta">
                  <span>Criado em {formatDate(tagSet.createdAt)}</span>
                  <span>Alterado em {formatDate(tagSet.updatedAt)}</span>
                </div>
                <div className="yt-lib-actions">
                  <Button variant="primary" size="sm" icon="⤵" data-testid={`library-use-tagset-${tagSet.id}`} onClick={() => onUseTagSet(tagSet)}>
                    Usar tags
                  </Button>
                  <Button variant="ghost" size="sm" icon="＋" data-testid={`library-append-tagset-${tagSet.id}`} onClick={() => onUseTagSet(tagSet, { append: true })}>
                    Somar às atuais
                  </Button>
                  <Button variant="ghost" size="sm" icon="✎" data-testid={`library-edit-tagset-${tagSet.id}`} onClick={() => openTagSet(tagSet)}>Editar</Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon="⧉"
                    data-testid={`library-duplicate-tagset-${tagSet.id}`}
                    onClick={async () => {
                      try {
                        await actions.duplicateTagSet(tagSet.id);
                        showToast("Conjunto duplicado.", "success");
                      } catch (err) {
                        showToast(err.message, "error");
                      }
                    }}
                  >
                    Duplicar
                  </Button>
                  <Button variant="ghost" size="sm" icon="🗑" data-testid={`library-delete-tagset-${tagSet.id}`} onClick={() => setConfirmState({ type: "tagSet", item: tagSet })}>
                    Excluir
                  </Button>
                </div>
              </motion.li>
            ))}
          </ul>
        ) : (
          <EmptyState
            icon="🏷️"
            title="Nenhum conjunto de tags"
            description="Salve grupos como “Tags Música” (música, remix, DJ, electronic, dance, mix) para aplicar em um clique."
            action={<Button variant="primary" onClick={() => openTagSet(null)}>Criar primeiro conjunto</Button>}
          />
        )}
      </Section>

      {/* ── templates ── */}
      <Section
        icon="🧩"
        title="Templates disponíveis"
        subtitle="Selecione um template para aplicar título, descrição, tags e configurações ao vídeo"
      >
        <ul className="yt-cards">
          {templates.map((template) => (
            <motion.li key={template.id} className="yt-lib-item" layout initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
              <div className="yt-lib-head">
                <strong>{template.name}</strong>
                {template.builtin ? <span className="yt-badge tone-idle">padrão</span> : <span className="yt-badge tone-accent">pessoal</span>}
              </div>
              <p className="yt-lib-content">{template.description}</p>
              <div className="yt-tag-preview">
                {(template.tags || []).slice(0, 8).map((tag) => (
                  <em key={tag}>{tag}</em>
                ))}
              </div>
              <div className="yt-lib-meta">
                {template.titlePattern ? <span>Título: {template.titlePattern}</span> : null}
                {template.privacyStatus ? <span>Privacidade: {{ public: "Público", unlisted: "Não listado", private: "Privado" }[template.privacyStatus]}</span> : null}
                {template.categoryId ? <span>Categoria: {template.categoryId}</span> : null}
              </div>
              <div className="yt-lib-actions">
                <Button variant="primary" size="sm" icon="⤵" data-testid={`library-use-template-${template.id}`} onClick={() => onUseTemplate(template)}>
                  Usar template
                </Button>
                {!template.builtin ? (
                  <Button variant="ghost" size="sm" icon="🗑" onClick={() => setConfirmState({ type: "template", item: template })}>
                    Excluir
                  </Button>
                ) : null}
              </div>
            </motion.li>
          ))}
        </ul>
      </Section>

      {/* ── modais ── */}
      <Modal
        open={Boolean(modal && (modal.type === "newDescription" || modal.type === "editDescription"))}
        title={modal && modal.type === "editDescription" ? "Editar descrição" : "Nova descrição salva"}
        description="Disponível para todos os seus uploads. Ao usar no vídeo, você edita uma cópia."
        onClose={() => setModal(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setModal(null)}>Cancelar</Button>
            <Button variant="primary" icon="💾" data-testid="save-description-library" onClick={saveDescription}>Salvar descrição</Button>
          </>
        }
      >
        <Field label="Nome" htmlFor="libDescName" counter={{ text: `${form.name.length}/80`, over: form.name.length > 80 }}>
          <TextInput
            id="libDescName"
            value={form.name}
            maxLength={80}
            placeholder="Ex.: Descrição padrão de músicas"
            onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
          />
        </Field>
        <Field
          label="Conteúdo"
          htmlFor="libDescContent"
          counter={{ text: `${form.content.length}/${limits.description}`, over: form.content.length > limits.description }}
        >
          <TextArea
            id="libDescContent"
            rows={10}
            value={form.content}
            placeholder="Escreva a descrição que será reaproveitada…"
            onChange={(event) => setForm((prev) => ({ ...prev, content: event.target.value }))}
          />
        </Field>
      </Modal>

      <Modal
        open={Boolean(modal && (modal.type === "newTagSet" || modal.type === "editTagSet"))}
        title={modal && modal.type === "editTagSet" ? "Editar conjunto de tags" : "Novo conjunto de tags"}
        description="Salve grupos de tags para reutilizar. As tags do vídeo podem ser editadas sem alterar o conjunto."
        onClose={() => setModal(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setModal(null)}>Cancelar</Button>
            <Button variant="primary" icon="💾" data-testid="save-tagset-library" onClick={saveTagSet}>Salvar conjunto</Button>
          </>
        }
      >
        <Field label="Nome" htmlFor="libTagName" counter={{ text: `${form.name.length}/80`, over: form.name.length > 80 }}>
          <TextInput
            id="libTagName"
            value={form.name}
            maxLength={80}
            placeholder="Ex.: Tags Música"
            onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
          />
        </Field>
        <Field label="Tags" hint="Adicione, remova, edite e reordene (arraste ou use as setas).">
          <TagEditor
            tags={form.tags}
            onChange={(tags) => setForm((prev) => ({ ...prev, tags }))}
            maxTotal={limits.tagsTotalChars}
            placeholder="Ex.: música, remix, DJ…"
          />
        </Field>
      </Modal>

      <ConfirmDialog
        open={Boolean(confirmState)}
        confirmTestId="library-confirm-delete"
        title={
          confirmState && confirmState.type === "description"
            ? `Excluir "${confirmState.item.name}"?`
            : confirmState && confirmState.type === "tagSet"
              ? `Excluir o conjunto "${confirmState.item.name}"?`
              : confirmState && confirmState.type === "template"
                ? `Excluir o template "${confirmState.item.name}"?`
                : "Excluir?"
        }
        confirmLabel="Excluir"
        onCancel={() => setConfirmState(null)}
        onConfirm={async () => {
          const target = confirmState;
          setConfirmState(null);
          if (!target) return;
          try {
            if (target.type === "description") await actions.removeDescription(target.item.id);
            else if (target.type === "tagSet") await actions.removeTagSet(target.item.id);
            else if (target.type === "template") await actions.removeTemplate(target.item.id);
            showToast("Item excluído.", "success");
          } catch (err) {
            showToast(err.message || "Não foi possível excluir.", "error");
          }
        }}
      />
    </div>
  );
}
