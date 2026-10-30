// Palette and light/dark mode. Stored per browser; the page works without storage.
(() => {
  const root = document.documentElement;
  const PALETTES = ['fjord', 'lagoon', 'heather', 'moss'];
  const read = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
  const write = (key, value) => { try { localStorage.setItem(key, value); } catch { /* storage unavailable */ } };
  const systemDark = () => window.matchMedia?.('(prefers-color-scheme: dark)').matches;

  function apply(palette, mode) {
    root.dataset.palette = PALETTES.includes(palette) ? palette : 'fjord';
    root.dataset.theme = mode === 'dark' || mode === 'light' ? mode : (systemDark() ? 'dark' : 'light');
    document.querySelectorAll('.swatch').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.palette === root.dataset.palette)));
    const toggle = document.getElementById('theme-toggle');
    if (toggle) toggle.setAttribute('aria-label', root.dataset.theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
  }

  apply(read('ro-palette'), read('ro-theme'));
  document.addEventListener('DOMContentLoaded', () => {
    apply(root.dataset.palette, root.dataset.theme);
    document.querySelectorAll('.swatch').forEach((b) => b.addEventListener('click', () => { write('ro-palette', b.dataset.palette); apply(b.dataset.palette, root.dataset.theme); }));
    document.getElementById('theme-toggle')?.addEventListener('click', () => { const next = root.dataset.theme === 'dark' ? 'light' : 'dark'; write('ro-theme', next); apply(root.dataset.palette, next); });
  });
})();
