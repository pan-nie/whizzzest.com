export const GALLERY_PANEL = `
<div id="view-gallery" class="wrap" style="display:none">
  <div class="range">
    <a href="https://whizzzest.com/gallery/" target="_blank" rel="noopener">查看公开图库</a>
    <button id="gallery-add" type="button" class="primary">上传照片</button>
  </div>
  <form class="panel" id="gallery-form" hidden>
    <h3 id="gallery-form-title">上传照片</h3>
    <div class="mgrid">
      <label class="wide" id="gallery-file-label">照片 *
        <input name="photo" type="file" accept="image/*" required>
        <span class="vfile">浏览器会校正方向、去除拍摄元数据并生成网页副本。请先检查画面中的隐私信息。</span>
      </label>
      <label>中文标题 *<input name="title_zh" required maxlength="120"></label>
      <label>拍摄地点 *<input name="location_zh" required maxlength="160"></label>
      <label>公开摄影署名 *<input name="photographer" required maxlength="120"></label>
      <label>拍摄日期<input name="taken_on" placeholder="YYYY-MM-DD 或 YYYY-MM" maxlength="10"></label>
      <label class="wide">中文替代文本 *<input name="alt_zh" required maxlength="340" placeholder="简述照片中最重要的画面"></label>
      <label class="wide">使用许可 *<input name="license_zh" required maxlength="220" placeholder="署名归属及转载授权说明"></label>
      <label>发布状态<select name="status"><option value="draft">草稿</option><option value="published">发布</option><option value="hidden">下线</option></select></label>
      <label>排序（小者靠前）<input name="sort" type="number" value="0" min="-100000" max="100000" step="1"></label>
    </div>
    <details style="margin-top:12px">
      <summary>英文资料（选填）</summary>
      <div class="mgrid">
        <label>英文标题<input name="title_en" maxlength="120"></label>
        <label>英文地点<input name="location_en" maxlength="160"></label>
        <label class="wide">英文替代文本<input name="alt_en" maxlength="340"></label>
        <label class="wide">英文许可说明<input name="license_en" maxlength="220"></label>
      </div>
    </details>
    <div class="ops" style="margin-top:12px">
      <button id="gallery-save" class="primary" type="submit">保存</button>
      <button id="gallery-cancel" type="button">取消</button>
    </div>
  </form>
  <p id="gallery-feedback" class="vhint" role="status" aria-live="polite"></p>
  <div class="list" id="gallery-list"></div>
  <button class="more" id="gallery-more" type="button" style="display:none">加载更多</button>
</div>`;

// Keep the browser script as text so the Worker bundler does not introduce helpers into it.
export const GALLERY_INIT = String.raw`(function initGallery(api, el) {
  const form = el('gallery-form');
  const box = el('gallery-list');
  const feedback = el('gallery-feedback');
  const more = el('gallery-more');
  const add = el('gallery-add');
  const cancel = el('gallery-cancel');
  const save = el('gallery-save');
  const photo = form.elements.namedItem('photo');
  const statuses = { draft: '草稿', published: '已发布', hidden: '已下线', deleted: '待清理' };
  const errors = {
    conflict: '这条记录已变更，请刷新列表后重新操作。',
    bad_fields: '请检查必填项、日期和排序。',
    bad_photo: '图片无法发布。请重新选择 JPG、PNG 或 WebP 照片。',
    photo_too_large: '图片文件过大。请换一张较小的照片。',
    upload_failed: '图片写入失败，请重试。',
    save_failed: '保存结果未确认，请使用当前表单重试。',
    cleanup_pending: '照片已停止公开访问。请重试清理存储。',
  };
  let editing;
  let pendingId;
  let busy = false;
  let offset = 0;
  let sequence = 0;

  function hint(error) {
    feedback.textContent = errors[error.message] || error.message;
  }

  function showForm(row) {
    if (busy) return;
    editing = row;
    pendingId = row?.id || crypto.randomUUID();
    form.reset();
    for (const field of form.elements) {
      if (field.name && row && row[field.name] != null) field.value = row[field.name];
    }
    photo.required = !row;
    photo.disabled = Boolean(row);
    el('gallery-file-label').style.display = row ? 'none' : '';
    el('gallery-form-title').textContent = row ? '编辑照片资料' : '上传照片';
    feedback.textContent = '';
    form.hidden = false;
    (row ? form.elements.namedItem('title_zh') : photo).focus();
  }

  function button(label, action, css) {
    const item = document.createElement('button');
    item.type = 'button';
    item.textContent = label;
    if (css) item.className = css;
    item.addEventListener('click', action);
    return item;
  }

  function render(row) {
    const card = document.createElement('div');
    card.className = 'msg read';
    const title = document.createElement('strong');
    title.textContent = row.title_zh;
    const info = document.createElement('p');
    info.className = 'time';
    info.textContent = [statuses[row.status], row.location_zh, row.photographer, row.taken_on].filter(Boolean).join(' · ');
    if (row.status !== 'deleted') {
      const link = document.createElement('a');
      link.href = '/api/gallery/' + row.id + '/full';
      link.target = '_blank';
      link.rel = 'noopener';
      const thumbnail = document.createElement('img');
      thumbnail.width = 120;
      thumbnail.loading = 'lazy';
      thumbnail.alt = row.alt_zh;
      thumbnail.src = '/api/gallery/' + row.id + '/thumb';
      link.append(thumbnail);
      card.append(link);
    }
    const ops = document.createElement('div');
    ops.className = 'ops';
    if (row.status !== 'deleted') {
      ops.append(button('编辑资料', () => showForm(row)));
      ops.append(button(row.status === 'published' ? '下线' : '发布', async () => {
        if (busy) return;
        const body = new FormData();
        for (const field of form.elements) {
          if (field.name && row[field.name] != null) body.set(field.name, row[field.name]);
        }
        const status = row.status === 'published' ? 'hidden' : 'published';
        body.set('status', status);
        body.set('revision', row.revision);
        await run(async () => {
          await api('/api/gallery/' + row.id, { method: 'POST', body });
          form.hidden = true;
          feedback.textContent = status === 'published' ? '已发布。' : '已下线。';
          await load();
        });
      }));
    }
    ops.append(button(row.status === 'deleted' ? '重试清理' : '删除', async () => {
      if (busy || (row.status !== 'deleted' && !confirm('删除这张照片及其网页副本？'))) return;
      await run(async () => {
        try {
          await api('/api/gallery/' + row.id + '?revision=' + row.revision, { method: 'DELETE' });
        } finally {
          form.hidden = true;
          await load();
        }
        feedback.textContent = '已删除。';
      });
    }, 'danger'));
    card.append(title, info, ops);
    return card;
  }

  async function load(reset = true) {
    const loadId = ++sequence;
    if (reset) offset = 0;
    more.disabled = true;
    try {
      const { photos, more: hasMore } = await api('/api/gallery?offset=' + offset);
      if (loadId !== sequence) return;
      if (reset) box.replaceChildren();
      if (!offset && !photos.length) {
        const empty = document.createElement('p');
        empty.className = 'empty';
        empty.textContent = '图库还没有照片。';
        box.append(empty);
      }
      box.append(...photos.map(render));
      offset += photos.length;
      more.style.display = hasMore ? '' : 'none';
    } catch (error) {
      if (loadId === sequence) hint(error);
    } finally {
      if (loadId === sequence) more.disabled = false;
    }
  }

  async function run(action) {
    if (busy) return;
    busy = true;
    add.disabled = cancel.disabled = save.disabled = true;
    try { await action(); }
    catch (error) { hint(error); }
    finally {
      busy = false;
      add.disabled = cancel.disabled = save.disabled = false;
    }
  }

  async function encode(file, body) {
    if (!file?.size) throw new Error('请选择一张照片。');
    if (file.size > 32 * 1024 * 1024) throw new Error(errors.photo_too_large);
    let image;
    try { image = await createImageBitmap(file); }
    catch { throw new Error('浏览器无法读取照片。可先导出 JPG 或 PNG。'); }

    async function variant(edge, quality) {
      const scale = Math.min(1, edge / Math.max(image.width, image.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      const context = canvas.getContext('2d', { alpha: false });
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
      if (!blob || blob.type !== 'image/jpeg') throw new Error(errors.bad_photo);
      return blob;
    }

    try {
      body.set('full', await variant(2048, 0.88), 'full.jpg');
      body.set('thumb', await variant(640, 0.8), 'thumb.jpg');
    } finally { image.close(); }
  }

  add.addEventListener('click', () => showForm());
  cancel.addEventListener('click', () => { form.hidden = true; add.focus(); });
  more.addEventListener('click', () => load(false));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    run(async () => {
      const body = new FormData(form);
      const file = body.get('photo');
      body.delete('photo');
      if (editing) {
        body.set('revision', editing.revision);
        feedback.textContent = '正在保存…';
      } else {
        body.set('id', pendingId);
        feedback.textContent = '正在处理照片并上传…';
        await encode(file, body);
      }
      await api(editing ? '/api/gallery/' + editing.id : '/api/gallery', { method: 'POST', body });
      form.hidden = true;
      feedback.textContent = body.get('status') === 'published' ? '已保存并发布。' : '已保存。';
      await load();
      add.focus();
    });
  });
  return load;
})(api, el)`;
