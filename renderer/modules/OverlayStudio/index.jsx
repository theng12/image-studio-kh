import { useEffect, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Button, EmptyState } from '../../components/ui.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { TemplateList } from './TemplateList.jsx';
import { TemplateEditor } from './TemplateEditor.jsx';

/**
 * Overlay Studio router.
 *
 * Two views in one module: the **list** (browse / create / duplicate /
 * delete templates) and the **editor** (design a single template).
 * Selecting a template from the list opens the editor; closing the
 * editor returns to the list. Both share the same `templates` array in
 * local state so create/delete actions in either view stay in sync
 * without a full IPC re-fetch loop.
 *
 * No company gating — templates are global per spec. The page still
 * checks for an active company for the *preview* (we need a product to
 * fill tokens against in the live editor), but the list itself is
 * always available.
 */
export function OverlayStudio() {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const setActiveModule = useAppStore((s) => s.setActiveModule);
  const addToast = useAppStore((s) => s.addToast);

  const [templates, setTemplates] = useState([]);
  const [editingId, setEditingId] = useState(null);  // null = list view; uuid = editor view
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (!window.api?.templates?.list) {
          throw new Error(
            "window.api.templates not exposed — the preload bridge didn't load it. " +
            "Try restarting the app; if it persists, the install is missing the Overlay Studio plumbing.",
          );
        }
        const list = await window.api.templates.list();
        if (!cancelled) setTemplates(Array.isArray(list) ? list : []);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[OverlayStudio] failed to load templates:', err);
        if (!cancelled) addToast(err.message, 'error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [addToast]);

  async function refresh() {
    try {
      const list = await window.api.templates.list();
      setTemplates(Array.isArray(list) ? list : []);
    } catch (err) {
      addToast(err.message, 'error');
    }
  }

  async function handleCreate() {
    try {
      const t = await window.api.templates.create({
        name: 'Untitled template',
        canvasWidth: 2000,
        canvasHeight: 2000,
        elements: [],
        tags: [],
      });
      await refresh();
      setEditingId(t.id);   // jump straight into the editor for a fresh one
    } catch (err) {
      addToast(err.message, 'error');
    }
  }

  async function handleDuplicate(id) {
    try {
      const t = await window.api.templates.duplicate(id);
      await refresh();
      addToast(`Duplicated to "${t.name}"`, 'success');
    } catch (err) {
      addToast(err.message, 'error');
    }
  }

  async function handleDelete(id) {
    try {
      await window.api.templates.remove(id);
      await refresh();
      addToast('Template deleted', 'success');
    } catch (err) {
      addToast(err.message, 'error');
    }
  }

  // Header subtitle differs per view so users always know what state they're in.
  const subtitleList = 'Reusable text + barcode + logo overlays you can apply to many products at once. Templates are shared across companies — design once, use everywhere.';
  const editingTemplate = templates.find((t) => t.id === editingId);
  const subtitleEditor = editingTemplate
    ? `Editing "${editingTemplate.name}" · ${editingTemplate.canvasWidth}×${editingTemplate.canvasHeight}`
    : 'Editing template…';

  if (editingId) {
    return (
      <div className="page page--overlay">
        <PageHeader
          title="Overlay Studio"
          subtitle={subtitleEditor}
          backTo={{ module: 'overlay', label: 'All templates' }}
          // Custom back handler: stay in the module, just leave the editor.
          onBackOverride={() => setEditingId(null)}
        />
        <TemplateEditor
          templateId={editingId}
          onClose={() => { setEditingId(null); refresh(); }}
          onChanged={refresh}
        />
      </div>
    );
  }

  return (
    <div className="page page--overlay">
      <PageHeader
        title="Overlay Studio"
        subtitle={subtitleList}
        actions={
          <Button variant="primary" onClick={handleCreate}>
            + New template
          </Button>
        }
      />

      {loading ? (
        <EmptyState title="Loading templates…" />
      ) : templates.length === 0 ? (
        <EmptyState
          title="No templates yet"
          body="Templates compose text, barcodes, and logos onto your product photos. Create one to get started — you can apply it to a batch of products from the Library afterwards."
          action={<Button variant="primary" onClick={handleCreate}>+ New template</Button>}
        />
      ) : (
        <TemplateList
          templates={templates}
          activeCompanyId={activeCompanyId}
          onOpen={(id) => setEditingId(id)}
          onDuplicate={handleDuplicate}
          onDelete={handleDelete}
        />
      )}
    </div>
  );
}
