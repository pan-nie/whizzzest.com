export const NOTICES_PANEL = `
<div id="view-notices" class="wrap" style="display:none">
  <div class="range"><h2>万载活动公告</h2><button id="notice-add" type="button" class="primary">新建公告</button></div>
  <p id="notice-feedback" class="vhint" role="status"></p>
  <form id="notice-form" class="panel" hidden>
    <h3 id="notice-form-title">新建公告</h3>
    <div class="mgrid">
      <label class="wide">标题<input name="title" required maxlength="120"></label>
      <label class="wide">事实摘要<textarea name="summary" rows="3" maxlength="600"></textarea></label>
      <label>地点<input name="location" maxlength="160"></label>
      <label>场次状态<select name="state">
        <option value="scheduled">按公告安排</option><option value="rescheduled">已改期</option>
        <option value="postponed">延期，时间待定</option><option value="cancelled">已取消</option>
      </select></label>
      <label>来源方<input name="source_name" maxlength="120"></label>
      <label class="wide">原公告链接<input name="source_url" type="url" maxlength="2000" placeholder="https://"></label>
      <label>原公告标题<input name="source_title" maxlength="160"></label>
      <label>原公告刊载日<input name="source_date" type="date"></label>
      <label>核验日期<input name="verified_on" type="date"></label>
      <label class="wide"><span id="notice-sessions-label">场次</span><textarea name="sessions" rows="4" maxlength="900" aria-describedby="notice-time-help"></textarea></label>
    </div>
    <p id="notice-time-help" class="vhint">北京时间，每行一个场次。填日期或日期及时间。用 / 分隔开始和结束，例如 2026-10-31 / 2026-11-02，或 2026-12-05 20:00 / 2026-12-05 21:00。未填结束时间的场次在当天结束后归档。</p>
    <div id="notice-change-fields" class="mgrid" hidden>
      <label id="notice-previous-label" class="wide">原定场次<textarea name="previous_sessions" rows="3" maxlength="900" aria-describedby="notice-time-help"></textarea></label>
      <label class="wide">变更说明<textarea name="change_note" rows="2" maxlength="300"></textarea></label>
      <label id="notice-until-label">变更提示保留至（可选）<input name="visible_through" type="date"></label>
    </div>
    <div class="ops"><button type="submit" class="primary">保存草稿</button><button id="notice-cancel" type="button">取消</button></div>
  </form>
  <div class="list" id="notice-list"></div>
  <div class="ops"><button type="button" id="notice-prev" hidden>上一页</button><button type="button" id="notice-next" hidden>下一页</button></div>
  <dialog id="notice-review" class="panel" aria-labelledby="notice-review-title" style="margin:auto;width:min(560px,calc(100% - 32px));max-height:80vh;overflow:auto">
    <h3 id="notice-review-title">审核公告</h3>
    <div id="notice-preview" style="white-space:pre-line;overflow-wrap:anywhere"></div>
    <p id="notice-review-feedback" class="vhint" role="status"></p>
    <div class="ops">
      <button id="notice-publish" type="button" class="primary">确认发布</button>
      <form method="dialog"><button type="submit" autofocus>返回</button></form>
    </div>
  </dialog>
</div>`;

export const NOTICES_INIT = String.raw`(function initNotices(api, el) {
  const path = '/api/activity-notices';
  const form = el('notice-form');
  const list = el('notice-list');
  const dialog = el('notice-review');
  const publish = el('notice-publish');
  const feedback = el('notice-feedback');
  const reviewFeedback = el('notice-review-feedback');
  const labels = { scheduled: '按公告安排', rescheduled: '已改期', postponed: '延期，时间待定', cancelled: '已取消' };
  const errors = {
    bad_fields: '请检查字段格式。来源链接必须使用 HTTPS，场次不得重叠。',
    incomplete: '请补齐摘要、地点、来源、刊载和核验日期、场次及所需的变更信息，再审核发布。',
    schedule_change: '已发布公告的场次有变。请选择改期、延期或取消，并附对应来源。',
    conflict: '这条公告已更新。请刷新列表后，按最新版本继续。',
    invalid_transition: '这条公告已下线，请刷新列表。',
  };
  let editing;
  let pendingId;
  let reviewing;
  let page = 1;
  let loading = 0;
  let busy = false;

  function errorText(error) { return errors[error.message] || '操作未完成，请重试。'; }
  function post(url, body) {
    return api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }
  function scheduleText(sessions) {
    return sessions.map(({ start, end }) => (end ? start + ' / ' + end : start).replaceAll('T', ' ')).join('\n');
  }
  function readSchedule(value) {
    return value.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
      const parts = line.split('/').map((part) => part.trim().replace(/\s+/g, 'T'));
      if (parts.length > 2 || (parts.length === 2 && !parts[1])) throw new Error('bad_fields');
      const [start, end = ''] = parts;
      return { start, end };
    });
  }

  function updateFields() {
    const state = form.elements.state.value;
    const suspended = state === 'postponed' || state === 'cancelled';
    el('notice-change-fields').hidden = state === 'scheduled';
    el('notice-previous-label').hidden = state !== 'rescheduled';
    el('notice-until-label').hidden = !suspended;
    el('notice-sessions-label').textContent = suspended ? '原定场次' : state === 'rescheduled' ? '改期后场次' : '场次';
  }

  function edit(row, rescheduling = false) {
    if (busy) return;
    editing = row;
    pendingId = row?.id || crypto.randomUUID();
    form.reset();
    const draft = row?.draft || {};
    for (const field of form.elements) {
      if (field.name && typeof draft[field.name] === 'string') field.value = draft[field.name];
    }
    form.elements.sessions.value = scheduleText(draft.sessions || []);
    form.elements.previous_sessions.value = scheduleText(draft.previous_sessions || []);
    if (rescheduling && draft.state === 'scheduled') {
      form.elements.state.value = 'rescheduled';
      form.elements.previous_sessions.value = scheduleText(draft.sessions);
    }
    el('notice-form-title').textContent = rescheduling ? '变更场次' : row ? '编辑公告草稿' : '新建公告';
    updateFields();
    feedback.textContent = '';
    form.hidden = false;
    (rescheduling ? form.elements.state : form.elements.title).focus();
  }

  function review(row) {
    reviewing = row;
    const draft = row.draft;
    const box = el('notice-preview');
    const schedule = scheduleText(draft.sessions);
    const previous = scheduleText(draft.previous_sessions);
    box.textContent = [draft.title, labels[draft.state], draft.location, schedule,
      previous && '原定场次\n' + previous, draft.change_note, draft.summary,
      [draft.source_name, draft.source_date, draft.verified_on && '核验于 ' + draft.verified_on].filter(Boolean).join(' · '),
      draft.visible_through && '变更提示保留至 ' + draft.visible_through].filter(Boolean).join('\n');
    if (draft.source_url) {
      const source = document.createElement('a');
      source.href = draft.source_url;
      source.target = '_blank';
      source.rel = 'noopener';
      source.textContent = draft.source_title || '查看原公告';
      box.append(document.createElement('br'), source);
    }
    reviewFeedback.textContent = '';
    dialog.showModal();
  }

  function button(label, action) {
    const item = document.createElement('button');
    item.type = 'button';
    item.textContent = label;
    item.addEventListener('click', action);
    return item;
  }

  async function act(row, action) {
    if (busy) return;
    busy = true;
    publish.disabled = true;
    const noticeStatus = action === 'publish' ? reviewFeedback : feedback;
    try {
      await post(path + '/' + row.id + '/' + action, { revision: row.revision });
      if (dialog.open) dialog.close();
      if (editing?.id === row.id) form.hidden = true;
      await load(page);
      feedback.textContent = action === 'publish' ? '公告已发布。' : '公告已下线。';
      el('notice-add').focus();
    } catch (error) {
      noticeStatus.textContent = errorText(error);
    } finally {
      busy = false;
      publish.disabled = false;
    }
  }

  function render(row) {
    const card = document.createElement('article');
    card.className = 'msg read';
    const title = document.createElement('strong');
    title.textContent = row.draft.title;
    const info = document.createElement('p');
    info.className = 'time';
    const isPublic = row.published_revision !== null;
    const pending = row.revision !== row.published_revision;
    const status = isPublic ? (row.public_until <= Date.now() ? '已归档' : '已发布') : '草稿';
    info.textContent = [status, isPublic && pending && '另有待审草稿', labels[row.draft.state], row.draft.source_name].filter(Boolean).join(' · ');
    const actions = document.createElement('div');
    actions.className = 'ops';
    actions.append(button('编辑草稿', () => edit(row)));
    if (isPublic) actions.append(button('变更场次', () => edit(row, true)));
    if (pending) actions.append(button('审核', () => review(row)));
    if (isPublic) actions.append(button('下线', () => {
      if (confirm('下线这条公告？审核记录会继续保留。')) act(row, 'withdraw');
    }));
    card.append(title, info, actions);
    return card;
  }

  async function load(number = page) {
    const sequence = ++loading;
    try {
      const result = await api(path + '?page=' + number);
      if (sequence !== loading) return;
      page = result.page;
      list.replaceChildren(...result.rows.map(render));
      if (!result.rows.length) list.textContent = '暂无公告。';
      el('notice-prev').hidden = page <= 1;
      el('notice-next').hidden = !result.more;
    } catch (error) {
      if (sequence === loading) feedback.textContent = errorText(error);
    }
  }

  form.elements.state.addEventListener('change', updateFields);
  el('notice-add').addEventListener('click', () => edit());
  el('notice-cancel').addEventListener('click', () => { form.hidden = true; el('notice-add').focus(); });
  el('notice-prev').addEventListener('click', () => load(page - 1));
  el('notice-next').addEventListener('click', () => load(page + 1));
  publish.addEventListener('click', () => act(reviewing, 'publish'));
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;
    const save = form.querySelector('[type="submit"]');
    busy = save.disabled = true;
    try {
      const draft = Object.fromEntries(new FormData(form));
      draft.sessions = readSchedule(draft.sessions);
      draft.previous_sessions = draft.state === 'rescheduled' ? readSchedule(draft.previous_sessions) : [];
      if (draft.state === 'scheduled') draft.change_note = '';
      await post(editing ? path + '/' + editing.id : path, { ...draft, id: pendingId, revision: editing?.revision });
      form.hidden = true;
      await load(1);
      feedback.textContent = '草稿已保存，可以审核发布。';
      el('notice-add').focus();
    } catch (error) {
      feedback.textContent = errorText(error);
    } finally {
      busy = save.disabled = false;
    }
  });
  return load;
})(api, el)`;
