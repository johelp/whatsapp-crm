/**
 * a11y.js — Mejora de accesibilidad para el contenido que renderiza app.js dinámicamente.
 *  - Botones con solo icono/emoji: aria-label tomado de su title.
 *  - div/span con onclick: role="button", tabindex y activación con Enter/Espacio.
 *  - Modales: role="dialog" aria-modal; foco al abrir y al cerrar.
 *  - Campos: asocia <label> con su control cuando no tiene "for".
 */
(function () {
  let seq = 0;

  function enhance(root) {
    root.querySelectorAll('button:not([aria-label]), a[title]:not([aria-label])').forEach(el => {
      const txt = (el.textContent || '').replace(/[\s​]+/g, '');
      const hasWord = /[A-Za-zÁÉÍÓÚáéíóúñÑ]{3,}/.test(el.textContent || '');
      if (el.title && !hasWord) el.setAttribute('aria-label', el.title);
      else if (!txt && !el.title && !el.querySelector('svg title')) el.setAttribute('aria-label', 'Acción');
    });

    root.querySelectorAll('div[onclick], span[onclick], li[onclick], td[onclick]').forEach(el => {
      if (el.hasAttribute('role')) return;
      el.setAttribute('role', 'button');
      if (!el.hasAttribute('tabindex')) el.tabIndex = 0;
    });

    root.querySelectorAll('.modal-box, .modal-overlay > div').forEach(el => {
      if (!el.hasAttribute('role')) { el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); }
    });

    // Menú colapsado: cada ítem muestra su nombre como tooltip y para lectores de pantalla
    root.querySelectorAll('.nav-item:not([title])').forEach(a => {
      const t = a.querySelector('.nav-label')?.textContent.trim(); if (t) a.setAttribute('title', t);
    });
    const pill = root.querySelector('#wa-pill'), st = root.querySelector('#wa-status-text');
    if (pill && st) { pill.setAttribute('title', 'WhatsApp: ' + st.textContent.trim()); pill.setAttribute('role', 'button'); pill.tabIndex = 0; }

    root.querySelectorAll('.field > label:not([for])').forEach(label => {
      const ctrl = label.parentElement.querySelector('input, select, textarea');
      if (!ctrl) return;
      if (!ctrl.id) ctrl.id = 'f' + (++seq);
      label.setAttribute('for', ctrl.id);
    });

    root.querySelectorAll('input:not([aria-label]):not([id^="f"])[placeholder], textarea[placeholder]:not([aria-label])').forEach(el => {
      if (!el.labels || !el.labels.length) el.setAttribute('aria-label', el.placeholder);
    });
  }

  // Enter / Espacio activan los elementos role="button" que no son <button>
  document.addEventListener('keydown', (e) => {
    const el = e.target;
    if (!el || el.getAttribute?.('role') !== 'button' || /^(BUTTON|A|INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); }
  });

  let t = null;
  const obs = new MutationObserver(() => { clearTimeout(t); t = setTimeout(() => enhance(document), 80); });
  function start() { enhance(document); obs.observe(document.body, { childList: true, subtree: true }); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
