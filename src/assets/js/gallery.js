const gallery = document.querySelector('[data-photo-gallery]');
const preview = document.querySelector('.photo-gallery-preview');

if (gallery && typeof preview?.showModal === 'function') {
  const image = preview.querySelector('img');
  const caption = preview.querySelector('figcaption');

  gallery.addEventListener('click', (event) => {
    const link = event.target.closest('a[data-photo-link]');
    if (!link || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    event.preventDefault();
    image.alt = link.querySelector('img').alt;
    image.src = link.href;
    caption.textContent = link.closest('figure').querySelector('h2').textContent;
    preview.showModal();
  });

  preview.addEventListener('close', () => image.removeAttribute('src'));
}
