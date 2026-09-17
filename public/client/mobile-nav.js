const toggle=document.querySelector('.mobile-nav-toggle');
toggle?.addEventListener('click',()=>{const open=toggle.getAttribute('aria-expanded')!=='true';toggle.setAttribute('aria-expanded',String(open));toggle.closest('.dashboard-sidebar').classList.toggle('mobile-menu-open',open);});
