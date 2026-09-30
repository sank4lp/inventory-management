const sidebar = document.querySelector('.dashboard-sidebar');
const toggle = sidebar?.querySelector('.mobile-nav-toggle');
if (toggle) {
  const compact = window.matchMedia('(max-width: 1020px)');
  let lastSidebarFocus = null;
  document.addEventListener('focusin', (event) => {
    lastSidebarFocus = sidebar.contains(event.target) ? event.target : null;
  });
  document.addEventListener('pointerdown', (event) => {
    if (!sidebar.contains(event.target)) lastSidebarFocus = null;
  });
  const setOpen = (open, restoreFocus = false) => {
    sidebar.classList.toggle('mobile-menu-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.textContent = open ? 'Close menu' : 'Menu';
    if (restoreFocus) toggle.focus();
  };
  // Without this module, navigation stays visible instead of becoming unreachable.
  sidebar.classList.add('nav-ready');
  toggle.hidden = false;
  toggle.addEventListener('click', () => setOpen(toggle.getAttribute('aria-expanded') !== 'true'));
  sidebar.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && compact.matches && toggle.getAttribute('aria-expanded') === 'true') {
      event.preventDefault();
      setOpen(false, true);
    }
  });
  compact.addEventListener('change', () => {
    // A breakpoint can hide the focused link before the media-change event runs.
    const active = document.activeElement === document.body ? lastSidebarFocus : document.activeElement;
    setOpen(false, compact.matches && sidebar.contains(active) && active !== toggle && !active.closest('.dashboard-brand'));
    if (!compact.matches && active === toggle) sidebar.querySelector('.side-nav-direct')?.focus();
  });
  window.addEventListener('pageshow', () => setOpen(false));
}
