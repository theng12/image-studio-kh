/**
 * v0.26.34: turn opaque "fetch failed" errors into something the user
 * can act on.
 *
 * Node.js's native fetch (used by the standalone-mode test handler
 * AND the client-mode test handler AND the client RPC layer) wraps
 * every low-level failure as a one-line `TypeError: fetch failed`.
 * The actual reason — DNS miss, refused connection, bad URL — sits
 * in `err.cause` (a Node `SystemError`), which the renderer toast
 * never sees because we stringify `err.message` and toss the rest.
 *
 * The two surfaces that need this:
 *   - `client:testConnection` (settings.js + client/index.js) — the
 *     "Test connection" button in Settings.
 *   - The client RPC dispatcher (`rpc()` in client/index.js) — so a
 *     mid-session network blip surfaces a real toast instead of
 *     "Server unreachable: fetch failed".
 *
 * Strategy: peel back err.cause.code, map the common Node socket /
 * DNS codes to a one-line friendly explanation + a concrete next
 * step. Falls back to the raw cause string for codes we don't
 * recognise, which is still strictly more informative than "fetch
 * failed" because it includes at least the syscall + addr.
 *
 * Also validates URL shape — Node's native fetch throws a separate
 * "Invalid URL" error when the user typed `100.64.0.5:13180` without
 * `http://`. We catch that BEFORE the fetch so the error is
 * deterministic and the message is friendly.
 */

/**
 * Validate a user-supplied server URL. Returns `{ ok: true }` on
 * success, or `{ ok: false, error: string }` with a one-line message
 * describing exactly what's wrong + how to fix it.
 *
 * What we check (in order):
 *   1. Non-empty + string type
 *   2. Includes a scheme (http:// or https://). The #1 cause of
 *      `Invalid URL` is the user typing `100.64.0.5:13180` and Node
 *      thinking the `:13180` is the URL scheme.
 *   3. The URL parses as a valid WHATWG URL
 *   4. Host is non-empty
 *   5. Scheme is exactly http or https (no ftp, no file, no app)
 */
function validateServerUrl(url) {
  if (typeof url !== 'string' || !url.trim()) {
    return { ok: false, error: 'Server URL is empty. Paste an address like http://100.64.0.5:13180 from the server Mac\'s Settings → Multi-Mac page.' };
  }
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    return {
      ok: false,
      error:
        `Server URL must start with http:// (or https://). You typed: "${trimmed}". ` +
        `Try adding the scheme — e.g. http://${trimmed}`,
    };
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch (_err) {
    return { ok: false, error: `Server URL is malformed: "${trimmed}". Format should be http://<ip-or-host>:<port> — e.g. http://100.64.0.5:13180` };
  }
  if (!parsed.host) {
    return { ok: false, error: `Server URL has no host part. Format: http://<ip-or-host>:<port> — e.g. http://100.64.0.5:13180` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: `Server URL must use http: or https: scheme (got "${parsed.protocol}").` };
  }
  return { ok: true };
}

/**
 * Translate a thrown fetch error into a friendly one-line message
 * for the user, plus a structured `{ code, hint }` payload the UI can
 * use for icons / colours.
 *
 * @param {Error}   err     The error thrown by `await fetch(...)`.
 * @param {string} [baseUrl] The URL we tried to reach (for the hint
 *   message). Optional.
 * @returns {{ message: string, code: string | null, hint: string }}
 */
function analyzeFetchError(err, baseUrl) {
  // The cause chain in Node's native fetch: TypeError(fetch failed)
  //   → cause: SystemError { code, errno, syscall, address, port }
  //   → optionally further nested for IPv6 vs IPv4 retry chains
  // Walk the chain until we hit something with a code we recognise.
  let cause = err?.cause;
  let code = null;
  let address = null;
  let port = null;
  while (cause && code == null) {
    if (cause.code) { code = cause.code; }
    if (cause.address) address = cause.address;
    if (cause.port)    port = cause.port;
    cause = cause.cause;
  }

  const where = baseUrl ? ` (${baseUrl})` : '';

  // Map the common Node socket / DNS codes to actionable messages.
  // Ordered roughly by how often we expect to see them in practice.
  switch (code) {
    case 'ECONNREFUSED':
      return {
        code,
        message:
          `Server refused the connection${where}. ` +
          `The most likely reasons: the server Mac isn't running Server mode (check its Settings → Multi-Mac shows "Listening on port ${port || 'N'}"), or the port number is wrong.`,
        hint: 'Server not listening on this port',
      };
    case 'ENOTFOUND':
      return {
        code,
        message:
          `Hostname not found${where}. ` +
          `DNS couldn't resolve the address. If you're using a Tailscale name, make sure Tailscale is running on this Mac. If you typed an IP, double-check it for typos.`,
        hint: 'Hostname / IP not reachable',
      };
    case 'ETIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
      return {
        code,
        message:
          `Connection timed out${where}. ` +
          `Either the server is blocked by a firewall, or you and the server aren't on the same network. ` +
          `Tailscale users: confirm both Macs are signed into the same tailnet.`,
        hint: 'Network unreachable',
      };
    case 'ECONNRESET':
      return {
        code,
        message:
          `Server dropped the connection mid-handshake${where}. ` +
          `Likely a server crash or restart. Check the server Mac's Settings → Multi-Mac shows "Listening" and try again.`,
        hint: 'Server reset connection',
      };
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return {
        code,
        message:
          `No network route to ${address || 'server'}${where}. ` +
          `Your Mac and the server aren't on the same network. Verify the server's IP (look at the green address chips on its Multi-Mac page) and that you're connected to the same Wi-Fi / Tailscale / VPN.`,
        hint: 'No route to host',
      };
    case 'CERT_HAS_EXPIRED':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
      return {
        code,
        message:
          `TLS certificate problem${where}: ${code}. ` +
          `If the server is on HTTP (not HTTPS), drop the "https://" from the URL.`,
        hint: 'TLS / certificate problem',
      };
    default:
      break;
  }

  // Special-case Node's Invalid URL — `fetch` throws this as a
  // TypeError with no `.cause`. The validateServerUrl() pre-check
  // catches the common case (missing http://) but odd characters
  // can still slip past.
  if (err?.message?.includes('Invalid URL')) {
    return {
      code: 'INVALID_URL',
      message:
        `Server URL is invalid${where}. ` +
        `Format should be http://<ip-or-host>:<port> — e.g. http://100.64.0.5:13180`,
      hint: 'Malformed URL',
    };
  }

  // Fallback: surface the cause string if we have one, else the
  // top-level message. Strictly better than the raw "fetch failed".
  const rawCause = err?.cause
    ? `${err.cause.code || ''} ${err.cause.syscall || ''} ${err.cause.message || err.cause}`.trim()
    : null;
  return {
    code: code || null,
    message: `Couldn't reach server${where}: ${rawCause || err?.message || 'unknown error'}`,
    hint: 'Network error',
  };
}

/**
 * v0.26.34: full network diagnostic. Walks through the layers of the
 * client → server handshake and returns a step list so the user can
 * see EXACTLY where things break.
 *
 * Steps (each carries `{ name, ok, message, code? }`):
 *   1. url       — URL shape (scheme + host + port well-formed)
 *   2. ping      — unauthenticated GET /api/ping. Confirms the
 *                  server process is alive + reachable from this Mac.
 *   3. whoami    — authenticated GET /api/whoami. Confirms the token
 *                  is valid.
 *
 * If step N fails, steps N+1… are skipped (`ok: null, skipped: true`)
 * so the user sees the chain stopped at the first real failure.
 * Returns `{ overall: 'ok'|'fail', steps, serverVersion?, user? }`.
 *
 * Used by Settings → Multi-Mac → "Run network diagnostic" button to
 * give a step-by-step "URL OK · ping OK · token rejected" rather
 * than the single-line testConnection error.
 */
async function diagnoseServer({ url, token } = {}) {
  const steps = [];

  // Step 1: URL shape.
  const urlCheck = validateServerUrl(url);
  steps.push({
    name: 'url',
    label: 'URL format',
    ok: urlCheck.ok,
    message: urlCheck.ok ? 'http(s)://host:port — looks well-formed' : urlCheck.error,
  });
  if (!urlCheck.ok) {
    return { overall: 'fail', steps };
  }
  const base = url.trim().replace(/\/+$/, '');

  // Step 2: unauthenticated ping. /api/ping is a public endpoint
  // (returns { ok: true, app, version }) — failure here means
  // "network or server process is wrong," cleanly separated from
  // any token issue.
  let serverVersion = null;
  let pingOk = false;
  try {
    const res = await fetch(`${base}/api/ping`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      steps.push({
        name: 'ping',
        label: 'Server reachable',
        ok: false,
        message: `Server returned ${res.status} on /api/ping. The address is reachable but isn't an Image Studio KH server.`,
      });
      return { overall: 'fail', steps };
    }
    const body = await res.json().catch(() => ({}));
    serverVersion = body?.version ?? null;
    pingOk = true;
    steps.push({
      name: 'ping',
      label: 'Server reachable',
      ok: true,
      message: serverVersion ? `Reachable. Server is running Image Studio KH v${serverVersion}.` : 'Reachable.',
    });
  } catch (err) {
    const analyzed = analyzeFetchError(err, base);
    steps.push({
      name: 'ping',
      label: 'Server reachable',
      ok: false,
      message: analyzed.message,
      code: analyzed.code,
    });
    return { overall: 'fail', steps };
  }

  // Step 3: authenticated whoami. Confirms the token is valid + the
  // server has a user record matching it.
  if (!token || !String(token).trim()) {
    steps.push({
      name: 'whoami',
      label: 'Token accepted',
      ok: false,
      message: 'Token is empty. Ask the server admin to copy yours from their Settings → Multi-Mac → Users page.',
    });
    return { overall: 'fail', steps };
  }
  try {
    const res = await fetch(`${base}/api/whoami`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 401) {
      steps.push({
        name: 'whoami',
        label: 'Token accepted',
        ok: false,
        message: 'Server is reachable but rejected the token. Ask the admin to regenerate it (their Settings → Multi-Mac → Users → ↻ button).',
      });
      return { overall: 'fail', steps, serverVersion };
    }
    if (!res.ok) {
      steps.push({
        name: 'whoami',
        label: 'Token accepted',
        ok: false,
        message: `Server returned ${res.status} on /api/whoami.`,
      });
      return { overall: 'fail', steps, serverVersion };
    }
    const data = await res.json();
    steps.push({
      name: 'whoami',
      label: 'Token accepted',
      ok: true,
      message: `Token accepted. Hello ${data.user.name} (${data.user.role}).`,
    });
    return { overall: 'ok', steps, serverVersion, user: data.user };
  } catch (err) {
    const analyzed = analyzeFetchError(err, base);
    steps.push({
      name: 'whoami',
      label: 'Token accepted',
      ok: false,
      message: analyzed.message,
      code: analyzed.code,
    });
    return { overall: 'fail', steps, serverVersion };
  }
}

module.exports = {
  validateServerUrl,
  analyzeFetchError,
  diagnoseServer,
};
