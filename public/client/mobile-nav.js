// One menu and one set of permission-filtered links on every screen.
const sidebar = document.querySelector('.dashboard-sidebar');
const toggle = document.querySelector('.mobile-nav-toggle');
if (sidebar && toggle) {
  const compact = window.matchMedia('(max-width: 1020px)');
  const content = document.querySelector('.dashboard-content');
  const close = sidebar.querySelector('.mobile-nav-close');
  const backdrop = document.createElement('div');
  backdrop.className = 'mobile-nav-backdrop';
  backdrop.setAttribute('aria-hidden', 'true');
  backdrop.hidden = true;
  document.body.append(backdrop);
  let lastSidebarFocus = null;
  const setOpen = (requested, restoreFocus = false) => {
    const open = Boolean(requested && compact.matches);
    sidebar.classList.toggle('mobile-menu-open', open);
    document.body.classList.toggle('mobile-menu-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    backdrop.hidden = !open;
    sidebar.inert = compact.matches && !open;
    if (content) content.inert = open;
    if (open) {
      sidebar.setAttribute('role', 'dialog');
      sidebar.setAttribute('aria-modal', 'true');
      (close || sidebar.querySelector('a'))?.focus();
    } else {
      sidebar.removeAttribute('role');
      sidebar.removeAttribute('aria-modal');
      if (restoreFocus) toggle.focus();
    }
  };
  document.addEventListener('focusin', event => {
    if (sidebar.contains(event.target)) lastSidebarFocus = event.target;
  });
  // A script failure leaves the original navigation visible and usable.
  sidebar.classList.add('nav-ready');
  toggle.hidden = false;
  if (close) close.hidden = false;
  setOpen(false);
  toggle.addEventListener('click', () => setOpen(toggle.getAttribute('aria-expanded') !== 'true', toggle.getAttribute('aria-expanded') === 'true'));
  close?.addEventListener('click', () => setOpen(false, true));
  backdrop.addEventListener('click', () => setOpen(false, true));
  sidebar.addEventListener('click', event => {
    if (compact.matches && event.target.closest?.('a[href]') && !event.metaKey && !event.ctrlKey) setOpen(false);
  });
  document.addEventListener('keydown', event => {
    if (!compact.matches || toggle.getAttribute('aria-expanded') !== 'true') return;
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false, true);
    } else if (event.key === 'Tab') {
      const links = [...sidebar.querySelectorAll('a[href],button,summary,input,select,[tabindex="0"]')]
        .filter(element => !element.disabled && element.getClientRects().length);
      const first = links[0], last = links.at(-1);
      if (event.shiftKey && (document.activeElement === first || !sidebar.contains(document.activeElement))) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !sidebar.contains(document.activeElement))) {
        event.preventDefault(); first?.focus();
      }
    }
  });
  compact.addEventListener('change', () => {
    const active = document.activeElement === document.body ? lastSidebarFocus : document.activeElement;
    setOpen(false, compact.matches && sidebar.contains(active));
    if (!compact.matches && active === toggle) sidebar.querySelector('.side-nav-direct')?.focus();
  });
  window.addEventListener('pageshow', () => setOpen(false));
  window.addEventListener('warehouse:page-loaded', () => setOpen(false));
}
