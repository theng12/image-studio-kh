// Theme controller. Applies the user's preferred theme to <html data-theme="…">
// and listens for OS-level light/dark changes when the user picks "system".

let cleanupSystemListener = null;

function setAttr(theme) {
  document.documentElement.setAttribute('data-theme', theme);
}

export function applyTheme(themePref) {
  // Detach any previous system listener.
  if (cleanupSystemListener) {
    cleanupSystemListener();
    cleanupSystemListener = null;
  }

  if (themePref === 'system') {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => setAttr(mq.matches ? 'dark' : 'light');
    apply();
    mq.addEventListener('change', apply);
    cleanupSystemListener = () => mq.removeEventListener('change', apply);
    return;
  }

  setAttr(themePref === 'dark' ? 'dark' : 'light');
}
