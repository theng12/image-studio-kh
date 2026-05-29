/**
 * v0.21.0: users:* IPC handlers, extracted from the monolithic ipc.js.
 *
 * Only relevant in server mode (and the bootstrap flow that creates
 * a default owner the first time someone flips a Mac to server).
 * Clients never call the mutation channels — they talk to the
 * server's HTTP API via RPC instead, and admin UI lives only on
 * the server Mac.
 *
 * Two safe-subset channels are exposed for clients:
 *   - users:listForAttribution → id + name + role (no tokens)
 *   - users:presence → currently-connected WebSocket users
 *
 * Tokens never leak. They're returned only when a user is
 * created or regenerated (one-time display in the admin UI).
 */

const { ipcMain } = require('electron');

function register({ expose }) {
  ipcMain.handle('users:list', () => {
    const users = require('../db/users');
    return users.list();
  });
  ipcMain.handle('users:create', (_e, { name, role }) => {
    const users = require('../db/users');
    return users.create({ name, role });
  });
  ipcMain.handle('users:update', (_e, { id, patch }) => {
    const users = require('../db/users');
    return users.update(id, patch);
  });
  ipcMain.handle('users:remove', (_e, id) => {
    const users = require('../db/users');
    return users.remove(id);
  });
  ipcMain.handle('users:regenerateToken', (_e, id) => {
    const users = require('../db/users');
    return users.regenerateToken(id);
  });
  /* Bootstrap helper: called by Settings when the user flips into
     server mode and the users table is still empty. Creates a default
     "Owner" with admin role and returns it (including the token,
     which the UI shows for one-time copy). */
  ipcMain.handle('users:ensureOwner', () => {
    const users = require('../db/users');
    return users.ensureOwner();
  });

  /* v0.15.3: safe-subset user list for attribution lookups. Returns
     only id + name + role — no tokens. Clients receive this so they
     can render "Edited 2 min ago by Theng" without ever seeing
     anyone else's authentication material. */
  expose('users:listForAttribution', () => {
    const users = require('../db/users');
    return users.list().map((u) => ({ id: u.id, name: u.name, role: u.role }));
  });

  /* v0.15.3: presence — who's currently connected via WebSocket.
     Exposed to clients so the Settings page (and a future presence
     chip in the sidebar) can show "Theng is online". Returns
     [{id, name, role, connectedAt}]. */
  expose('users:presence', () => {
    const events = require('../events');
    return events.getPresence();
  });
}

module.exports = { register };
