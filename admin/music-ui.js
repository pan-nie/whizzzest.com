export const MUSIC_ADMIN_SCRIPT = String.raw`
const { selectMusicLibrary, loadMusic } = (() => {
  const libraries = {
    wanzai: { api: '/api/music', publicPage: SITE_HOME + '/music/', formats: ['mp3'], limit: 50, label: 'MP3' },
    opera: { api: '/api/opera-music', publicPage: 'https://opera.whizzzest.com/music/', formats: ['mp3', 'm4a', 'ogg', 'wav'], limit: 20, label: 'MP3、M4A、OGG、WAV' }
  };
  const filters = [...document.querySelectorAll('#view-music [data-must]')];
  let library, status = '', offset = 0, loadId = 0, form = null;

  function selectMusicLibrary(key) {
    const selected = libraries[key];
    if (library !== selected) {
      closeTrackForm();
      library = selected;
      setFilter('');
      for (const name of Object.keys(libraries)) {
        const tab = el('mu-' + name);
        tab.classList.toggle('active', name === key);
        if (name === key) tab.setAttribute('aria-current', 'page');
        else tab.removeAttribute('aria-current');
      }
      el('mu-preview').href = library.publicPage;
      el('mu-description-row').style.display = key === 'opera' ? '' : 'none';
      el('mu-file').accept = library.formats.map(ext => '.' + ext).join(',');
      el('mu-file-label').textContent = '音频文件 ' + library.label + '（最多 ' + library.limit + ' MB，自动读取时长）';
      el('mustats').textContent = '';
    }
    loadMusic(true);
  }

  function setFilter(value) {
    status = value;
    for (const filter of filters) {
      const active = filter.dataset.must === value;
      filter.classList.toggle('active', active);
      filter.setAttribute('aria-pressed', String(active));
    }
  }

  async function loadMusic(reset) {
    if (!library) return;
    const requestId = ++loadId;
    const nextOffset = reset ? 0 : offset + MUSIC_PAGE_SIZE;
    const list = el('mulist');
    const more = el('mumore');
    if (reset) list.innerHTML = '<p class="empty">正在加载曲目…</p>';
    more.disabled = true;
    if (reset) more.style.display = 'none';
    const query = '?offset=' + nextOffset + (status ? '&status=' + status : '');
    try {
      const data = await api(library.api + query);
      if (requestId !== loadId) return;
      offset = nextOffset;
      const counts = data.byStatus || {};
      const tracks = data.tracks || [];
      let line = '共 ' + data.total + ' 首 · 已上线 ' + (counts.published || 0) + ' · 已隐藏 ' + (counts.hidden || 0);
      if (data.storage != null) line += ' · 已用存储 ' + (data.storage / 1048576).toFixed(1) + ' MB';
      el('mustats').textContent = line;
      if (reset) list.replaceChildren();
      if (reset && tracks.length === 0) list.innerHTML = '<p class="empty">' +
        (status ? '此状态下没有曲目。' : '还没有曲目，点右上「新增曲目」上传第一首。') + '</p>';
      else for (const track of tracks) list.append(renderTrack(track, library));
      more.style.display = nextOffset + tracks.length < (status ? counts[status] : data.total) ? 'block' : 'none';
    } catch (error) {
      if (requestId === loadId && error.message !== 'unauthorized') {
        if (reset) list.innerHTML = '<p class="empty">加载失败：' + esc(error.message) + '</p>';
        else alert('加载失败：' + error.message);
      }
    } finally {
      if (requestId === loadId) more.disabled = false;
    }
  }

  function renderTrack(track, source) {
    const card = document.createElement('div');
    const published = track.status === 'published';
    card.className = 'msg' + (published ? '' : ' read');
    const image = source === libraries.opera ? track.cover : coverUrl(track.cover);
    const thumbnail = image ? '<img class="vthumb" loading="lazy" alt="" src="' + esc(image) + '">' :
      '<div class="vthumb"></div>';
    const date = track.created_at ? fmtTime(track.created_at.replace('T', ' ').replace('Z', '')) : '';
    const meta = [
      track.artist, vDur(track.duration) ? '时长 ' + vDur(track.duration) : '',
      source === libraries.wanzai ? '播放 ' + (track.plays || 0) + ' 次' : '', date
    ].filter(Boolean).map(esc).join(' · ');
    card.innerHTML = '<div class="vrow1">' + thumbnail + '<div style="min-width:0;flex:1">' +
      '<div class="row1"><span class="name">' + esc(track.title) + '</span>' +
      '<span class="k-badge">曲序 ' + esc(track.sort || 0) + '</span>' +
      '<span class="mst ' + (published ? 'mst-approved">已上线' : 'mst-rejected">已隐藏') + '</span>' +
      (published ? '<a class="mslug" href="' + source.publicPage + '" target="_blank" rel="noopener">前台收听 ↗</a>' : '') +
      '</div>' + (track.description ? '<div class="time">' + esc(track.description) + '</div>' : '') +
      '<div class="meta">' + meta + '</div></div></div>' +
      '<div class="ops"><button type="button" data-act="toggle">' + (published ? '隐藏' : '上线') +
      '</button><button type="button" data-act="edit">编辑</button><button type="button" data-act="del">删除</button></div>';
    card.querySelector('.ops').addEventListener('click', async event => {
      const button = event.target.closest('button[data-act]');
      if (!button) return;
      const action = button.dataset.act;
      if (action === 'edit') {
        openTrackForm(track);
        return;
      }
      if (action === 'del' && !button.dataset.armed) {
        button.dataset.armed = '1';
        button.className = 'danger';
        button.textContent = '确认删除（含音频）';
        setTimeout(() => {
          delete button.dataset.armed;
          button.className = '';
          button.textContent = '删除';
        }, 4000);
        return;
      }
      const data = action === 'toggle' ? { status: published ? 'hidden' : 'published' } : {};
      if (source === libraries.opera) Object.assign(data, { revision: track.revision, mutation: crypto.randomUUID() });
      card.querySelectorAll('.ops button').forEach(control => { control.disabled = true; });
      try {
        await api(source.api + '/' + encodeURIComponent(track.id), {
          method: action === 'toggle' ? 'POST' : 'DELETE',
          headers: { 'content-type': 'application/json' }, body: JSON.stringify(data)
        });
        if (source === library) {
          if (form?.track?.id === track.id) closeTrackForm();
          loadMusic(true);
        }
      } catch (error) {
        if (error.message !== 'unauthorized') alert('操作失败：' + error.message);
        card.querySelectorAll('.ops button').forEach(control => { control.disabled = false; });
      }
    });
    return card;
  }

  function openTrackForm(track) {
    if (form?.busy) return;
    form = { track, id: null, mutation: null, busy: false };
    el('muform-title').textContent = track ? '编辑曲目' : '新增曲目';
    el('mu-title').value = track?.title || '';
    el('mu-artist').value = track?.artist || '';
    el('mu-description').value = track?.description || '';
    el('mu-status').value = track?.status || 'published';
    el('mu-sort').value = track?.sort || 0;
    el('mu-dur').value = track?.duration || '';
    el('mu-file').value = '';
    el('mu-fileinfo').textContent = track ? '已上传音频，保留原文件可留空。' : '';
    el('mu-cover').value = '';
    el('mu-coverinfo').textContent = track?.cover ? '已上传封面，保留原图可留空。' : '';
    el('muform').style.display = '';
    setBusy(false);
    progress(null);
    hint('');
    el('muform').scrollIntoView({ behavior: 'smooth', block: 'start' });
    el('mu-title').focus({ preventScroll: true });
  }

  function closeTrackForm() {
    el('muform').style.display = 'none';
    form = null;
  }

  function setBusy(busy) {
    form.busy = busy;
    el('muform').querySelectorAll('input, textarea, select, button').forEach(control => { control.disabled = busy; });
  }

  function progress(fraction) {
    el('mu-prog').style.display = fraction == null ? 'none' : '';
    el('mu-progbar').style.width = Math.round((fraction || 0) * 100) + '%';
  }

  function hint(message) {
    el('mu-hint').textContent = message;
    el('mu-hint').style.display = message ? '' : 'none';
  }

  el('mu-file').addEventListener('change', event => {
    const file = event.target.files[0];
    const active = form;
    if (!active) return;
    const fileInfo = el('mu-fileinfo');
    if (!file) {
      fileInfo.textContent = '';
      return;
    }
    fileInfo.textContent = file.name + ' · ' + (file.size / 1048576).toFixed(1) + ' MB';
    if (file.size > library.limit * 1048576) {
      fileInfo.textContent += '（超过 ' + library.limit + ' MB）';
      return;
    }
    const audio = document.createElement('audio');
    const url = URL.createObjectURL(file);
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => {
      if (active === form && !active.busy && el('mu-file').files[0] === file && Number.isFinite(audio.duration)) {
        el('mu-dur').value = Math.round(audio.duration);
      }
      URL.revokeObjectURL(url);
    };
    audio.onerror = () => URL.revokeObjectURL(url);
    audio.src = url;
  });

  el('muform').addEventListener('input', () => {
    if (form) form.mutation = null;
  });

  el('musave').addEventListener('click', async () => {
    const active = form;
    if (!active || active.busy) return;
    const source = library;
    const track = active.track;
    const file = el('mu-file').files[0];
    const cover = el('mu-cover').files[0];
    const payload = {
      title: val('mu-title'), artist: val('mu-artist'), status: val('mu-status'),
      sort: Number(val('mu-sort') || 0), duration: Number(val('mu-dur') || 0)
    };
    if (!payload.title) return hint('请填写曲名。');
    if (!track && !file) return hint('请选择要上传的音频。');
    if (file && (file.size > source.limit * 1048576 ||
        !source.formats.includes(file.name.split('.').pop().toLowerCase()))) {
      return hint('请选择 ' + source.label + ' 文件，最多 ' + source.limit + ' MB。');
    }
    if (cover && cover.size > 5 * 1048576) return hint('封面图不能超过 5 MB。');

    const path = source.api + (track ? '/' + encodeURIComponent(track.id) : '');
    const uploadProgress = fraction => { if (form === active) progress(fraction); };
    const uploadHint = message => { if (form === active) hint(message); };
    setBusy(true);
    try {
      if (source === libraries.opera) {
        active.id ||= crypto.randomUUID();
        active.mutation ||= crypto.randomUUID();
        const data = new FormData();
        Object.assign(payload, { id: active.id, mutation: active.mutation, description: val('mu-description') });
        if (track) payload.revision = track.revision;
        for (const [key, value] of Object.entries(payload)) data.set(key, value);
        if (file) data.set('audio', file);
        if (cover) data.set('cover', cover);
        if (file || cover) uploadProgress(0);
        uploadHint(file || cover ? '正在上传并保存…' : '正在保存…');
        await putFile(path, data, file || cover ? uploadProgress : null, 'POST');
      } else {
        if (file) {
          uploadProgress(0);
          uploadHint('音频上传中，请勿关闭页面…');
          payload.file_key = (await putFile(source.api + '/upload', file, uploadProgress)).key;
        }
        if (cover) {
          uploadHint('封面上传中…');
          payload.cover = (await putFile(source.api + '/cover', cover)).key;
        }
        uploadHint('正在保存…');
        await api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      }
      if (form === active) closeTrackForm();
      if (library === source) loadMusic(true);
    } catch (error) {
      if (error.message !== 'unauthorized') uploadHint('保存失败：' + error.message);
    } finally {
      if (form === active) {
        setBusy(false);
        progress(null);
      }
    }
  });

  for (const filter of filters) filter.addEventListener('click', () => {
    setFilter(filter.dataset.must);
    loadMusic(true);
  });
  el('muadd').addEventListener('click', () => openTrackForm(null));
  el('mucancel').addEventListener('click', closeTrackForm);
  el('mumore').addEventListener('click', () => loadMusic(false));

  return { selectMusicLibrary, loadMusic };
})();
`;
