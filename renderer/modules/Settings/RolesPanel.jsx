/**
 * v0.49.51 — Roles & permissions panel (Settings tab).
 *
 * Lists roles, and lets an admin create/edit/delete them by ticking
 * capabilities in a grouped matrix. Admin is shown locked (full access).
 * Built-in roles (Editor/Photographer/Viewer) are editable but not
 * deletable; custom roles are fully editable + deletable (unless assigned
 * to a user). "Clone" seeds a new role from any existing one.
 *
 * Enforcement is server-side (permissions.js); this is the authoring UI.
 */

import { useEffect, useMemo, useState } from 'react';
import { Button, Input, Textarea, EmptyState } from '../../components/ui.jsx';
import { confirm } from '../../components/ConfirmModal.jsx';

export function RolesPanel({ addToast }) {
  const [roles, setRoles] = useState([]);
  const [capabilities, setCapabilities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedKey, setSelectedKey] = useState(null);
  // Draft being edited: { mode:'edit'|'create', key?, name, description, perms:Set }
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const [r, caps] = await Promise.all([
        window.api.roles.list(),
        window.api.roles.capabilities(),
      ]);
      setRoles(Array.isArray(r) ? r : []);
      setCapabilities(Array.isArray(caps) ? caps : []);
    } catch (err) {
      addToast?.(`Failed to load roles: ${err.message}`, 'error');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  // Group capabilities by their `group` for the matrix.
  const grouped = useMemo(() => {
    const m = new Map();
    for (const c of capabilities) {
      if (!m.has(c.group)) m.set(c.group, []);
      m.get(c.group).push(c);
    }
    return Array.from(m.entries());
  }, [capabilities]);

  const selected = roles.find((r) => r.key === selectedKey) || null;

  function startEdit(role) {
    setSelectedKey(role.key);
    if (role.isSystem) { setDraft(null); return; } // admin is locked, no draft
    setDraft({
      mode: 'edit', key: role.key, name: role.name,
      description: role.description || '',
      perms: new Set(role.permissions || []),
    });
  }

  function startCreate(seedRole) {
    setSelectedKey(null);
    setDraft({
      mode: 'create',
      name: seedRole ? `${seedRole.name} copy` : '',
      description: seedRole?.description || '',
      // Clone the seed's perms (admin '*' expands to all real caps so the
      // clone is an editable full-access role rather than another superuser).
      perms: new Set(
        seedRole
          ? (seedRole.permissions.includes('*') ? capabilities.map((c) => c.key) : seedRole.permissions)
          : [],
      ),
    });
  }

  function togglePerm(key) {
    setDraft((d) => {
      const next = new Set(d.perms);
      if (next.has(key)) next.delete(key); else next.add(key);
      return { ...d, perms: next };
    });
  }

  async function save() {
    if (!draft) return;
    const name = draft.name.trim();
    if (!name) { addToast?.('Role name is required', 'error'); return; }
    setSaving(true);
    try {
      const permissions = Array.from(draft.perms);
      if (draft.mode === 'create') {
        const created = await window.api.roles.create({ name, description: draft.description, permissions });
        addToast?.(`Role "${created.name}" created`, 'success');
        await load();
        setSelectedKey(created.key);
        startEdit(created);
      } else {
        await window.api.roles.update(draft.key, { name, description: draft.description, permissions });
        addToast?.('Role saved', 'success');
        await load();
      }
    } catch (err) {
      addToast?.(err.message, 'error');
    } finally {
      setSaving(false);
    }
  }

  async function remove(role) {
    const ok = await confirm({
      title: `Delete role "${role.name}"?`,
      body: 'Users assigned to this role must be reassigned first. This cannot be undone.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      await window.api.roles.remove(role.key);
      addToast?.('Role deleted', 'success');
      setDraft(null);
      setSelectedKey(null);
      await load();
    } catch (err) {
      addToast?.(err.message, 'info');
    }
  }

  function permCount(role) {
    if (role.permissions.includes('*')) return 'Full access';
    const n = role.permissions.length;
    return n === 0 ? 'Browse only' : `${n} ${n === 1 ? 'capability' : 'capabilities'}`;
  }

  if (loading) return <div className="muted">Loading roles…</div>;

  return (
    <div className="roles-panel">
      <p className="muted" style={{ marginBottom: 'var(--s-3)' }}>
        Roles control what each user can do. Pick a role to edit its capabilities, or
        create a new one. <strong>Admin</strong> always has full access and can’t be changed.
        Changes take effect on the server (clients pick them up on their next reconnect).
      </p>

      <div className="roles-panel__layout">
        {/* Role list */}
        <div className="roles-list">
          {roles.map((r) => (
            <button
              key={r.key}
              type="button"
              className={`role-card${(selectedKey === r.key || (draft?.mode === 'edit' && draft.key === r.key)) ? ' is-active' : ''}`}
              onClick={() => startEdit(r)}
            >
              <div className="role-card__name">
                {r.name}
                {r.isSystem ? <span className="role-card__lock" title="Locked">🔒</span> : null}
                {r.isBuiltin && !r.isSystem ? <span className="role-card__tag">built-in</span> : null}
              </div>
              <div className="role-card__meta">{permCount(r)}</div>
            </button>
          ))}
          <Button variant="ghost" onClick={() => startCreate(null)}>+ New role</Button>
        </div>

        {/* Editor */}
        <div className="roles-editor">
          {selected?.isSystem && !draft && (
            <div className="roles-editor__locked">
              <h3>{selected.name}</h3>
              <p className="muted">{selected.description}</p>
              <p className="muted">This role has <strong>full access</strong> to everything and is locked so you can’t accidentally lock yourself out. To restrict someone, assign them a different role.</p>
            </div>
          )}

          {draft && (
            <div className="roles-editor__form">
              <div className="form-grid">
                <label className="field">
                  <span className="field__label">Role name *</span>
                  <Input value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} placeholder="e.g. Bookkeeper" />
                </label>
                <label className="field field--full">
                  <span className="field__label">Description</span>
                  <Textarea rows={2} value={draft.description} onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))} placeholder="What this role is for." />
                </label>
              </div>

              <div className="roles-matrix">
                <div className="roles-matrix__head">
                  <span>Capabilities</span>
                  <span className="muted">{draft.perms.size} of {capabilities.length} enabled</span>
                </div>
                {grouped.map(([group, caps]) => (
                  <div key={group} className="roles-matrix__group">
                    <div className="roles-matrix__group-title">{group}</div>
                    {caps.map((c) => (
                      <label key={c.key} className="roles-matrix__row">
                        <input type="checkbox" checked={draft.perms.has(c.key)} onChange={() => togglePerm(c.key)} />
                        <span className="roles-matrix__label">
                          <strong>{c.label}</strong>
                          <span className="muted">{c.description}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                ))}
              </div>

              <div className="roles-editor__actions">
                <Button variant="primary" onClick={save} disabled={saving}>
                  {saving ? 'Saving…' : draft.mode === 'create' ? 'Create role' : 'Save changes'}
                </Button>
                {draft.mode === 'edit' && selected && (
                  <Button variant="ghost" onClick={() => startCreate(selected)}>Clone</Button>
                )}
                {draft.mode === 'edit' && selected && !selected.isBuiltin && (
                  <Button variant="ghost" onClick={() => remove(selected)}>Delete role</Button>
                )}
                <Button variant="ghost" onClick={() => { setDraft(null); setSelectedKey(null); }}>Cancel</Button>
              </div>
            </div>
          )}

          {!draft && !selected?.isSystem && (
            <EmptyState title="Pick a role" body="Select a role on the left to edit its capabilities, or create a new one." />
          )}
        </div>
      </div>
    </div>
  );
}
