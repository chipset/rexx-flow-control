const { buildWebviewCsp, createNonce } = require("./shared");

function serializeForScript(value) {
  return JSON.stringify(value || {}).replace(/</g, "\\u003c");
}

function renderTaskDashboardHtml(state = {}, scriptNonce = createNonce()) {
  const persistedJson = serializeForScript(state);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="${buildWebviewCsp(scriptNonce)}" />
  <title>Task Dashboard</title>
  <style>
    :root {
      --bg: #f4efe4;
      --ink: #1f2430;
      --muted: rgba(31, 36, 48, 0.62);
      --line: rgba(31, 36, 48, 0.12);
      --panel: rgba(255, 252, 246, 0.88);
      --panel-strong: rgba(255, 250, 240, 0.98);
      --accent: #c85c37;
      --accent-2: #236a5f;
      --accent-3: #295f98;
      --shadow: 0 20px 60px rgba(86, 63, 32, 0.12);
      --radius: 18px;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; min-height: 100%; }
    body {
      font: 14px/1.5 Georgia, "Iowan Old Style", "Palatino Linotype", serif;
      color: var(--ink);
      background:
        radial-gradient(circle at top left, rgba(200, 92, 55, 0.16), transparent 28%),
        radial-gradient(circle at right 10%, rgba(41, 95, 152, 0.13), transparent 22%),
        linear-gradient(180deg, #f7f1e6 0%, #efe7d7 100%);
    }
    button, input, textarea, select { font: inherit; color: inherit; }
    .shell {
      min-height: 100vh;
      padding: 24px;
      display: grid;
      gap: 20px;
      grid-template-columns: minmax(320px, 420px) minmax(0, 1fr);
    }
    .panel {
      background: var(--panel);
      border: 1px solid rgba(255,255,255,0.55);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
      backdrop-filter: blur(12px);
    }
    .left-rail {
      display: grid;
      gap: 18px;
      align-content: start;
    }
    .hero, .composer, .creator, .board {
      padding: 20px;
    }
    .eyebrow {
      margin: 0 0 8px;
      color: var(--accent);
      text-transform: uppercase;
      letter-spacing: 0.14em;
      font: 700 11px/1.2 ui-monospace, "SFMono-Regular", monospace;
    }
    .hero h1 {
      margin: 0;
      font-size: clamp(28px, 4vw, 42px);
      line-height: 0.96;
      letter-spacing: -0.03em;
    }
    .hero p, .help, .meta {
      margin: 10px 0 0;
      color: var(--muted);
    }
    .stats {
      margin-top: 18px;
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
    }
    .stat {
      padding: 14px;
      border-radius: 14px;
      background: rgba(255,255,255,0.52);
      border: 1px solid rgba(255,255,255,0.55);
    }
    .stat-label {
      color: var(--muted);
      font: 700 10px/1.2 ui-monospace, "SFMono-Regular", monospace;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .stat-value {
      margin-top: 8px;
      font-size: 26px;
      line-height: 1;
    }
    .field-grid {
      display: grid;
      gap: 12px;
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .field-grid .full { grid-column: 1 / -1; }
    label {
      display: grid;
      gap: 6px;
      font: 700 11px/1.2 ui-monospace, "SFMono-Regular", monospace;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    input, textarea, select {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 11px 12px;
      background: rgba(255,255,255,0.72);
      outline: none;
    }
    textarea { min-height: 90px; resize: vertical; }
    .row {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      align-items: center;
    }
    .btn {
      border: 0;
      border-radius: 999px;
      padding: 10px 14px;
      cursor: pointer;
      background: var(--ink);
      color: #f8f3eb;
      box-shadow: 0 10px 24px rgba(31, 36, 48, 0.16);
    }
    .btn.secondary {
      background: rgba(255,255,255,0.72);
      color: var(--ink);
      border: 1px solid var(--line);
      box-shadow: none;
    }
    .board {
      display: grid;
      gap: 16px;
      align-content: start;
    }
    .board-head {
      display: flex;
      gap: 14px;
      justify-content: space-between;
      align-items: end;
      flex-wrap: wrap;
    }
    .board-head h2 {
      margin: 0;
      font-size: 24px;
      line-height: 1;
    }
    .filters {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }
    .filters input, .filters select { width: auto; min-width: 160px; }
    .task-list {
      display: grid;
      gap: 12px;
    }
    .task-card {
      padding: 16px;
      border-radius: 16px;
      background: var(--panel-strong);
      border: 1px solid rgba(31, 36, 48, 0.1);
      display: grid;
      gap: 10px;
    }
    .task-top, .task-bottom {
      display: flex;
      gap: 10px;
      justify-content: space-between;
      align-items: start;
      flex-wrap: wrap;
    }
    .task-main {
      display: flex;
      gap: 10px;
      align-items: start;
      min-width: 0;
      flex: 1;
    }
    .task-main input[type="checkbox"] {
      width: 18px;
      height: 18px;
      margin-top: 4px;
      accent-color: var(--accent);
    }
    .task-title {
      margin: 0;
      font-size: 20px;
      line-height: 1.05;
      word-break: break-word;
    }
    .pill-row {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      border-radius: 999px;
      font: 700 10px/1 ui-monospace, "SFMono-Regular", monospace;
      letter-spacing: 0.07em;
      text-transform: uppercase;
      background: rgba(31, 36, 48, 0.08);
    }
    .pill.todo { background: rgba(41, 95, 152, 0.12); color: var(--accent-3); }
    .pill.in-progress { background: rgba(200, 92, 55, 0.12); color: var(--accent); }
    .pill.blocked { background: rgba(133, 50, 60, 0.12); color: #8b2530; }
    .pill.done { background: rgba(35, 106, 95, 0.12); color: var(--accent-2); }
    .notes {
      color: rgba(31, 36, 48, 0.8);
      white-space: pre-wrap;
    }
    .empty {
      padding: 30px;
      border: 1px dashed var(--line);
      border-radius: 16px;
      text-align: center;
      color: var(--muted);
      background: rgba(255,255,255,0.45);
    }
    .composer textarea[readonly] {
      min-height: 220px;
      background: rgba(247, 243, 234, 0.92);
    }
    .copy-status {
      min-height: 20px;
      color: var(--accent-2);
      font: 700 11px/1.2 ui-monospace, "SFMono-Regular", monospace;
      letter-spacing: 0.05em;
      text-transform: uppercase;
    }
    @media (max-width: 980px) {
      .shell { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div id="app"></div>
  <script nonce="${scriptNonce}">
    const vscode = acquireVsCodeApi();
    const persisted = ${persistedJson};
    const STATUS_OPTIONS = ['todo', 'in-progress', 'blocked', 'done'];
    const PRIORITY_OPTIONS = ['low', 'medium', 'high'];
    const STATUS_LABELS = {
      todo: 'To do',
      'in-progress': 'In progress',
      blocked: 'Blocked',
      done: 'Done'
    };
    const state = {
      tasks: Array.isArray(persisted.tasks) ? persisted.tasks : [],
      selectedTaskIds: new Set(Array.isArray(persisted.selectedTaskIds) ? persisted.selectedTaskIds : []),
      instruction: typeof persisted.instruction === 'string' ? persisted.instruction : '',
      query: typeof persisted.query === 'string' ? persisted.query : '',
      statusFilter: typeof persisted.statusFilter === 'string' ? persisted.statusFilter : 'all',
      form: { title: '', notes: '', status: 'todo', priority: 'medium', tags: '' },
      copyStatus: ''
    };

    function slugify(value) {
      return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40);
    }

    function persistState() {
      vscode.postMessage({
        type: 'persistTaskDashboardState',
        state: {
          tasks: state.tasks,
          selectedTaskIds: Array.from(state.selectedTaskIds),
          instruction: state.instruction,
          query: state.query,
          statusFilter: state.statusFilter
        }
      });
    }

    function buildRequest() {
      const selectedTasks = state.tasks.filter((task) => state.selectedTaskIds.has(task.id));
      const taskSource = selectedTasks.length ? selectedTasks : state.tasks;
      const lines = taskSource.map((task, index) => {
        const tags = task.tags && task.tags.length ? ' Tags: ' + task.tags.join(', ') + '.' : '';
        const notes = task.notes ? ' Notes: ' + task.notes.replace(/\\s+/g, ' ').trim() : '';
        return (index + 1) + '. [' + STATUS_LABELS[task.status] + ' | ' + task.priority + '] ' + task.title + notes + tags;
      });
      const instruction = state.instruction.trim() || 'Review these tasks and tell me the best next action.';
      return [
        'Use my dashboard tasks as context for the following request.',
        '',
        'Instruction:',
        instruction,
        '',
        'Tasks:',
        lines.length ? lines.join('\\n') : '- No tasks added yet.'
      ].join('\\n');
    }

    function metrics() {
      return {
        total: state.tasks.length,
        active: state.tasks.filter((task) => task.status !== 'done').length,
        selected: state.selectedTaskIds.size
      };
    }

    function filteredTasks() {
      const query = state.query.trim().toLowerCase();
      return state.tasks.filter((task) => {
        if (state.statusFilter !== 'all' && task.status !== state.statusFilter) {
          return false;
        }
        if (!query) {
          return true;
        }
        const haystack = [task.title, task.notes, ...(task.tags || [])].join(' ').toLowerCase();
        return haystack.includes(query);
      });
    }

    function upsertTaskFromForm(event) {
      event.preventDefault();
      const title = state.form.title.trim();
      if (!title) {
        return;
      }
      const timestamp = new Date().toISOString();
      const task = {
        id: 'task-' + slugify(title) + '-' + Date.now().toString(36),
        title,
        notes: state.form.notes.trim(),
        status: state.form.status,
        priority: state.form.priority,
        tags: state.form.tags
          .split(',')
          .map((tag) => tag.trim().toLowerCase())
          .filter(Boolean)
          .slice(0, 8),
        createdAt: timestamp,
        updatedAt: timestamp
      };
      state.tasks = [task, ...state.tasks];
      state.selectedTaskIds.add(task.id);
      state.form = { title: '', notes: '', status: 'todo', priority: 'medium', tags: '' };
      persistState();
      render();
    }

    function updateTask(taskId, patch) {
      state.tasks = state.tasks.map((task) =>
        task.id === taskId ? { ...task, ...patch, updatedAt: new Date().toISOString() } : task
      );
      persistState();
      render();
    }

    function deleteTask(taskId) {
      state.tasks = state.tasks.filter((task) => task.id !== taskId);
      state.selectedTaskIds.delete(taskId);
      persistState();
      render();
    }

    function toggleSelection(taskId) {
      if (state.selectedTaskIds.has(taskId)) {
        state.selectedTaskIds.delete(taskId);
      } else {
        state.selectedTaskIds.add(taskId);
      }
      persistState();
      render();
    }

    function el(tag, props = {}, children = []) {
      const node = document.createElement(tag);
      for (const [key, value] of Object.entries(props)) {
        if (key === 'className') {
          node.className = value;
        } else if (key === 'text') {
          node.textContent = value;
        } else if (key === 'html') {
          node.innerHTML = value;
        } else if (key.startsWith('on') && typeof value === 'function') {
          node.addEventListener(key.slice(2).toLowerCase(), value);
        } else if (value !== undefined && value !== null) {
          node[key] = value;
        }
      }
      const childList = Array.isArray(children) ? children : [children];
      for (const child of childList) {
        if (child === null || child === undefined || child === false) {
          continue;
        }
        node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
      }
      return node;
    }

    function renderTaskCard(task) {
      const statusSelect = el('select', {
        value: task.status,
        onchange: (event) => updateTask(task.id, { status: event.target.value })
      }, STATUS_OPTIONS.map((status) => el('option', { value: status, text: STATUS_LABELS[status] })));

      const prioritySelect = el('select', {
        value: task.priority,
        onchange: (event) => updateTask(task.id, { priority: event.target.value })
      }, PRIORITY_OPTIONS.map((priority) => el('option', { value: priority, text: priority })));

      return el('article', { className: 'task-card', 'data-task-id': task.id }, [
        el('div', { className: 'task-top' }, [
          el('div', { className: 'task-main' }, [
            el('input', {
              type: 'checkbox',
              checked: state.selectedTaskIds.has(task.id),
              onchange: () => toggleSelection(task.id)
            }),
            el('div', {}, [
              el('h3', { className: 'task-title', text: task.title }),
              el('div', { className: 'pill-row' }, [
                el('span', { className: 'pill ' + task.status, text: STATUS_LABELS[task.status] }),
                el('span', { className: 'pill', text: task.priority }),
                ...(task.tags || []).map((tag) => el('span', { className: 'pill', text: '#' + tag }))
              ])
            ])
          ]),
          el('button', {
            className: 'btn secondary',
            text: 'Delete',
            onclick: () => deleteTask(task.id)
          })
        ]),
        task.notes ? el('div', { className: 'notes', text: task.notes }) : null,
        el('div', { className: 'task-bottom' }, [
          el('div', { className: 'row' }, [statusSelect, prioritySelect]),
          el('div', { className: 'meta', text: task.updatedAt ? 'Updated ' + new Date(task.updatedAt).toLocaleString() : '' })
        ])
      ]);
    }

    function render() {
      const root = document.getElementById('app');
      const summary = metrics();
      const visibleTasks = filteredTasks();
      const requestDraft = buildRequest();

      root.replaceChildren(
        el('div', { className: 'shell' }, [
          el('div', { className: 'left-rail' }, [
            el('section', { className: 'panel hero' }, [
              el('p', { className: 'eyebrow', text: 'Task Radar' }),
              el('h1', { text: 'Shape the work before you ask for the work.' }),
              el('p', {
                text: 'Capture tasks, select the ones that matter, then draft a crisp Codex request grounded in the backlog.'
              }),
              el('div', { className: 'stats' }, [
                el('div', { className: 'stat' }, [
                  el('div', { className: 'stat-label', text: 'Total tasks' }),
                  el('div', { className: 'stat-value', text: String(summary.total) })
                ]),
                el('div', { className: 'stat' }, [
                  el('div', { className: 'stat-label', text: 'Active' }),
                  el('div', { className: 'stat-value', text: String(summary.active) })
                ]),
                el('div', { className: 'stat' }, [
                  el('div', { className: 'stat-label', text: 'Selected' }),
                  el('div', { className: 'stat-value', text: String(summary.selected) })
                ])
              ])
            ]),
            el('form', { className: 'panel creator', onsubmit: upsertTaskFromForm }, [
              el('p', { className: 'eyebrow', text: 'Add task' }),
              el('div', { className: 'field-grid' }, [
                el('label', { className: 'full' }, [
                  'Title',
                  el('input', {
                    value: state.form.title,
                    placeholder: 'Audit test coverage for export commands',
                    oninput: (event) => { state.form.title = event.target.value; }
                  })
                ]),
                el('label', {}, [
                  'Status',
                  el('select', {
                    value: state.form.status,
                    onchange: (event) => { state.form.status = event.target.value; }
                  }, STATUS_OPTIONS.map((status) => el('option', { value: status, text: STATUS_LABELS[status] })))
                ]),
                el('label', {}, [
                  'Priority',
                  el('select', {
                    value: state.form.priority,
                    onchange: (event) => { state.form.priority = event.target.value; }
                  }, PRIORITY_OPTIONS.map((priority) => el('option', { value: priority, text: priority })))
                ]),
                el('label', { className: 'full' }, [
                  'Tags',
                  el('input', {
                    value: state.form.tags,
                    placeholder: 'qa, parser, release',
                    oninput: (event) => { state.form.tags = event.target.value; }
                  })
                ]),
                el('label', { className: 'full' }, [
                  'Notes',
                  el('textarea', {
                    value: state.form.notes,
                    placeholder: 'Anything you want Codex to know before acting on this task.',
                    oninput: (event) => { state.form.notes = event.target.value; }
                  })
                ])
              ]),
              el('div', { className: 'row' }, [
                el('button', { className: 'btn', type: 'submit', text: 'Add to dashboard' }),
                el('span', { className: 'help', text: 'New tasks are selected automatically for the request draft.' })
              ])
            ]),
            el('section', { className: 'panel composer' }, [
              el('p', { className: 'eyebrow', text: 'Codex request draft' }),
              el('label', {}, [
                'Instruction',
                el('textarea', {
                  value: state.instruction,
                  placeholder: 'Example: implement the highest priority selected task and add tests.',
                  oninput: (event) => {
                    state.instruction = event.target.value;
                    persistState();
                    render();
                  }
                })
              ]),
              el('label', {}, [
                'Generated request',
                el('textarea', { readOnly: true, value: requestDraft })
              ]),
              el('div', { className: 'row' }, [
                el('button', {
                  className: 'btn',
                  type: 'button',
                  text: 'Copy request',
                  onclick: () => {
                    vscode.postMessage({ type: 'copyTaskRequest', text: requestDraft });
                    state.copyStatus = 'Copied to clipboard';
                    render();
                  }
                }),
                el('div', { className: 'copy-status', text: state.copyStatus || 'Select tasks to narrow the draft.' })
              ])
            ])
          ]),
          el('section', { className: 'panel board' }, [
            el('div', { className: 'board-head' }, [
              el('div', {}, [
                el('p', { className: 'eyebrow', text: 'Backlog' }),
                el('h2', { text: 'Everything currently in play' })
              ]),
              el('div', { className: 'filters' }, [
                el('input', {
                  value: state.query,
                  placeholder: 'Search title, notes, or tags',
                  oninput: (event) => {
                    state.query = event.target.value;
                    persistState();
                    render();
                  }
                }),
                el('select', {
                  value: state.statusFilter,
                  onchange: (event) => {
                    state.statusFilter = event.target.value;
                    persistState();
                    render();
                  }
                }, ['all', ...STATUS_OPTIONS].map((status) =>
                  el('option', { value: status, text: status === 'all' ? 'All statuses' : STATUS_LABELS[status] })
                ))
              ])
            ]),
            el('div', { className: 'task-list' },
              visibleTasks.length
                ? visibleTasks.map((task) => renderTaskCard(task))
                : [el('div', {
                    className: 'empty',
                    text: state.tasks.length
                      ? 'No tasks match the current filter.'
                      : 'No tasks yet. Start with one concrete task and build from there.'
                  })]
            )
          ])
        ])
      );
    }

    render();
  </script>
</body>
</html>`;
}

module.exports = {
  renderTaskDashboardHtml
};
