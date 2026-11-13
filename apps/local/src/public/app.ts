import type { AiStatus, Project } from '../types.js';

type View = {
  projects: Array<{
    id: string;
    name: string;
    root: string;
    scannedAt: string;
    savedPath: string | null;
    isSaved: boolean;
  }>;
  project: Project | null;
  destination: string;
  markdown: string;
  reviewHash: string | null;
  isSaved: boolean;
};
type Reply = {
  view: View;
  result?: { path?: string; unchanged?: boolean; changed?: boolean };
  path?: string | null;
  text?: string;
  error?: string;
};
const get = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;
const escape = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );
const fragment = location.hash.slice(1);
if (fragment) {
  sessionStorage.setItem('hub-token', fragment);
  history.replaceState(null, '', '/');
}
const token = sessionStorage.getItem('hub-token') ?? '';
let view: View;
let busy = true;
let adding = false;
let visibleProjects = 5;
let visibleNotes = 5;
let displayedProject = '';
let ai: AiStatus | null = null;
let analysisAbort: AbortController | null = null;
let aiShare: (ReturnType<typeof references> & { runnerId: string; promptHash: string }) | null =
  null;

async function api<T>(route: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/${route}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    ...(signal ? { signal } : {}),
  });
  const result = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(result.error ?? 'This action did not finish. Try again.');
  return result;
}

function setBusy(value: boolean, status = ''): void {
  busy = value;
  get('workspace').setAttribute('aria-busy', String(value));
  for (const control of document.querySelectorAll<
    HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
  >('button, input, textarea, select')) {
    control.disabled = value;
    if (control.id === 'cancel-analysis') control.disabled = !analysisAbort;
  }
  if (!value) {
    const copy = document.getElementById('copy-prompt') as HTMLButtonElement | null;
    if (copy) copy.disabled = !get<HTMLInputElement>('share-consent').checked;
    const save = document.getElementById('save') as HTMLButtonElement | null;
    if (save) save.disabled = !view?.project?.selected.length;
    get<HTMLButtonElement>('update-all').disabled = !view?.projects.length;
    const connect = document.getElementById('connect-ai') as HTMLButtonElement | null;
    if (connect)
      connect.disabled =
        !ai?.available || !ai.detected?.loggedIn || !get<HTMLSelectElement>('ai-model').value;
  }
  if (status) get('status').textContent = status;
}

function showError(error: unknown): void {
  const area = get('error');
  area.textContent =
    error instanceof TypeError
      ? 'The local app is not responding. Reopen Memory Hub. Your saved notes remain on disk.'
      : error instanceof Error
        ? error.message
        : 'This action did not finish. Try again.';
  area.hidden = false;
  get('status').textContent = '';
  area.scrollIntoView({ block: 'nearest' });
}

async function action(label: string, work: () => Promise<void>): Promise<void> {
  if (busy) return;
  const focusId = document.activeElement?.id;
  get('error').hidden = true;
  setBusy(true, label);
  try {
    await work();
  } catch (error) {
    showError(error);
  } finally {
    setBusy(false);
    if (focusId) document.getElementById(focusId)?.focus({ preventScroll: true });
  }
}

function references(): { projectId: string; scanId: string } {
  if (!view.project) throw new Error('Choose a project first.');
  return { projectId: view.project.id, scanId: view.project.scan.id };
}

async function mutate(route: string, body: unknown, status: string): Promise<Reply> {
  const reply = await api<Reply>(route, body);
  view = reply.view;
  render();
  get('status').textContent = status;
  return reply;
}

function render(): void {
  const project = adding ? null : view.project;
  get('ai-panel').hidden = !project;
  if (displayedProject !== project?.id) {
    visibleNotes = 5;
    displayedProject = project?.id ?? '';
  }
  renderNavigation(project);
  if (!project) {
    get('content').innerHTML =
      `<section class="intro"><div class="folder-illustration" aria-hidden="true"></div><h1>Start with one project.</h1><p>Turn project files into notes your AI can use.<br />Review each note before saving it.</p><button class="primary" id="choose-project">Choose a project folder</button><p><small>Reads documentation and manifests. Does not run code or change your project.</small></p><hr /><details><summary>Use a folder path</summary><label class="field-label" for="project-path">Project folder</label><div class="inline-form"><input id="project-path" class="field" placeholder="C:\\Projects\\my-project" autocomplete="off" spellcheck="false" /><button id="scan-path" class="secondary">Scan this folder</button></div></details>${view.project ? '<button id="cancel-add" class="text-button">Back to current project</button>' : ''}</section>`;
    return;
  }
  const sources = new Map(project.scan.sources.map((source) => [source.id, source]));
  const rows = [
    ...project.notes.filter((note) => note.kind === 'ai'),
    ...project.notes.filter((note) => note.kind === 'source'),
  ]
    .map((note, index) => {
      const source = sources.get(note.sourceId)!;
      return `<article class="note-row" ${index >= visibleNotes ? 'hidden' : ''}><label class="note-label" for="note-${escape(note.id)}"><input type="checkbox" id="note-${escape(note.id)}" data-note="${escape(note.id)}" ${project.selected.includes(note.id) ? 'checked' : ''} /><span class="note-text">${note.kind === 'ai' ? '<span class="tag">AI draft</span>' : ''}${escape(note.text)}</span></label><details class="source-details"><summary>${escape(source.path)}</summary><p>${note.kind === 'ai' ? 'The quote matches the source. Check that it supports the draft.' : 'This text comes from the source file. Check that it is still useful.'}</p><pre>${escape(note.quote)}</pre></details></article>`;
    })
    .join('');
  get('content').innerHTML =
    `<div class="project-header"><div><h1>${escape(project.name)}</h1><p>${escape(project.root)}</p></div><button id="rescan" class="secondary">Scan again</button></div>
    ${project.scan.partial ? '<div class="notice">The scan reached a limit or could not read a folder. These notes cover only the sources listed below.</div>' : ''}
    ${project.scan.sensitive ? `<div class="notice">${project.scan.sensitive} file(s) may contain secrets. Their content was excluded.</div>` : ''}
    <div class="workspace-grid"><section class="paper" aria-labelledby="review-title"><div class="paper-header"><h2 id="review-title">Choose what to remember.</h2><p>Select the notes you want to save.</p>${project.notes.length > 1 ? `<button id="select-all-notes" class="text-button">Select all ${project.notes.length} notes</button>` : ''}</div>${rows || '<p class="empty-notes">No basic notes were found. Open scan details below. You can use your AI if source excerpts are available.</p>'}${project.notes.length > visibleNotes ? `<div id="more-note-controls" class="note-row"><p class="muted">Showing <span id="visible-note-count">${visibleNotes}</span> of ${project.notes.length} notes.</p><button id="more-notes" class="secondary">Show the next 5 notes</button></div>` : ''}</section>
    <section class="save-panel" aria-labelledby="save-title"><h2 id="save-title">Save your notes.</h2><p class="muted"><span id="selection-count">${project.selected.length}</span> selected. Your project stays unchanged.</p><p class="path">Memory folder<br /><strong>${escape(view.destination)}</strong></p><details><summary>Change memory folder</summary><p><small>Choose an Obsidian vault or a plain folder.</small></p><button id="choose-destination" class="secondary">Choose a folder</button><label class="field-label" for="destination-path">Or enter a folder path</label><input class="field" id="destination-path" value="${escape(view.destination)}" spellcheck="false" /><button id="set-destination" class="text-button">Use this folder</button></details><details><summary>Preview the Markdown</summary><pre id="preview" class="preview">${escape(view.markdown)}</pre></details><div class="save-actions"><button id="save" class="primary" ${project.selected.length ? '' : 'disabled'}>Save selected notes</button></div><p class="path">Creates a snapshot in the Memory Hub subfolder. Existing notes stay unchanged.</p>${project.savedPath ? `<div class="save-result"><strong>Last saved note</strong><p>${escape(project.savedPath)}</p><button id="copy-path" class="text-button">Copy saved path</button></div>` : ''}</section>
    <details class="optional"><summary>Use another AI manually</summary><div class="optional-body"><p>Use this fallback with your own chat account.</p><ol><li>Review the evidence prompt.</li><li>Paste it into your AI chat.</li><li>Paste the reply below.</li></ol><label><input id="share-consent" type="checkbox" />I will choose where to share these project excerpts.</label><button id="prepare-prompt" class="secondary">Review the prompt</button><div id="prompt-area" hidden><pre id="prompt-preview" class="preview"></pre><button id="copy-prompt" class="secondary" disabled>Copy prompt</button></div><label for="ai-reply">AI reply</label><textarea id="ai-reply" class="field" placeholder="Paste the JSON reply here." spellcheck="false"></textarea><button id="import-reply" class="secondary">Review AI suggestions</button><p>Suggestions need a matching source quote. You decide whether the claim is correct.</p></div></details>
    <details class="optional"><summary>Scan details</summary><p>Scanned ${escape(new Date(project.scan.at).toLocaleString())}. ${project.scan.sources.length} source files. ${project.scan.skipped} items skipped.</p><p>Reads local working files. Does not inspect Git history. Large files, links, and private configuration files are skipped.</p>${project.scan.sources.map((source) => `<details><summary>${escape(source.path)}</summary><pre>${escape(source.text)}</pre></details>`).join('')}<p>Secret detection is limited. Review the text before sharing it.</p></details></div>`;
  renderAiAction();
}

function renderAiAction(): void {
  document.getElementById('analyze-ai')?.remove();
  if (ai?.connection && ai.available && view?.project && !adding) {
    const header = document.querySelector('.project-header');
    const button = document.createElement('button');
    button.id = 'analyze-ai';
    button.className = 'secondary';
    button.textContent = 'Draft notes with Codex';
    header?.append(button);
  }
}

function renderAi(): void {
  const panel = get('ai-panel');
  panel.hidden = !view?.project;
  if (!ai) {
    panel.innerHTML =
      '<h2 id="ai-title">Use your AI (optional)</h2><p>You can scan and save without AI.</p><button id="refresh-ai" class="text-button">Check for Codex</button>';
    return;
  }
  if (ai.connection && ai.available) {
    panel.innerHTML = `<div class="ai-heading"><div><h2 id="ai-title">Your AI is connected</h2><p>Codex uses ${escape(ai.connection.model)} with your existing account. Review excerpts before you send them.</p></div><span class="local-badge">Ready</span></div><details><summary>Connection settings</summary><p>Usage comes from your Codex account.</p><p class="path">${escape(ai.connection.binaryPath)}</p><button id="disconnect-ai" class="secondary">Disconnect</button></details>`;
    return;
  }
  if (ai.connection) {
    panel.innerHTML = `<h2 id="ai-title">Codex is not ready</h2><p>${escape(ai.problem ?? 'Check your Codex install.')}</p><button id="refresh-ai" class="text-button">Check again</button><button id="disconnect-ai" class="secondary">Disconnect</button>`;
    return;
  }
  const suggested = ai.detected?.suggestedModel ?? '';
  const models = ai.detected?.models ?? [];
  panel.innerHTML = `<h2 id="ai-title">Let your AI draft the notes.</h2><p>${escape(ai.problem ?? 'Codex is installed. Connect the account you already use.')}</p>${ai.available && ai.detected?.loggedIn && models.length ? `<label class="field-label" for="ai-model">Choose your model</label><select id="ai-model" class="field"><option value="">Choose a model</option>${models.map((model) => `<option value="${escape(model.id)}" ${model.id === suggested ? 'selected' : ''}>${escape(model.label)}</option>`).join('')}</select><p class="muted">Uses your existing Codex login. Usage comes from that account.</p><button id="connect-ai" class="secondary" ${suggested ? '' : 'disabled'}>Use this AI</button>` : '<p>Open Codex and sign in if needed. Then check the connection again.</p>'}<button id="refresh-ai" class="text-button">Check again</button>`;
}

async function refreshAi(): Promise<void> {
  try {
    ai = await api<AiStatus>('ai');
  } catch {
    ai = {
      available: false,
      problem: 'The AI connection could not be checked. Try again.',
      detected: null,
      connection: null,
    };
  }
  renderAi();
  renderAiAction();
}

function syncReview(previous: View): void {
  if (adding) {
    renderNavigation(null);
    return;
  }
  const before = previous.project;
  const after = view.project;
  if (
    !before ||
    !after ||
    previous.destination !== view.destination ||
    before.id !== after.id ||
    before.scan.id !== after.scan.id ||
    before.savedPath !== after.savedPath ||
    before.savedHash !== after.savedHash ||
    before.notes.length !== after.notes.length ||
    before.notes.some((note, index) => note.id !== after.notes[index]?.id)
  ) {
    render();
    return;
  }
  for (const checkbox of document.querySelectorAll<HTMLInputElement>('[data-note]'))
    checkbox.checked = after.selected.includes(checkbox.dataset.note!);
  get('preview').textContent = view.markdown;
  get('selection-count').textContent = String(after.selected.length);
  renderNavigation(after);
}

async function updateAll(): Promise<void> {
  await action('Checking your projects.', async () => {
    const projects = view.projects.map(({ id, name }) => ({ id, name }));
    const previous = view;
    let changed = 0;
    let unchanged = 0;
    const failures: Array<{ name: string; message: string }> = [];
    get('batch-result').hidden = true;
    for (const [index, project] of projects.entries()) {
      get('status').textContent =
        `Checked ${index} of ${projects.length}. Checking ${project.name}.`;
      try {
        const reply = await api<Reply>('scan', { projectId: project.id });
        view = reply.view;
        if (reply.result?.changed) changed++;
        else unchanged++;
      } catch (error) {
        failures.push({
          name: project.name,
          message: error instanceof Error ? error.message : 'Could not check this project.',
        });
      }
    }
    syncReview(previous);
    const summary = `Checked ${projects.length} projects. ${changed} changed. ${unchanged} unchanged. ${failures.length} could not be checked.`;
    get('status').textContent = summary;
    const result = get('batch-result');
    result.innerHTML = `<strong>${escape(summary)}</strong><p>${changed ? 'Open the changed projects to review their new notes.' : 'Your saved notes are unchanged.'}</p>${
      failures.length
        ? `<ul>${failures
            .slice(0, 5)
            .map((failure) => `<li>${escape(failure.name)}: ${escape(failure.message)}</li>`)
            .join(
              '',
            )}</ul>${failures.length > 5 ? `<p>${failures.length - 5} more projects could not be checked. Check them individually for details.</p>` : ''}`
        : ''
    }`;
    result.hidden = false;
  });
}

async function reviewAiShare(): Promise<void> {
  if (!ai?.connection) return;
  const { id: runnerId, model } = ai.connection;
  await action('Preparing the excerpts for your review.', async () => {
    const ref = references();
    const reply = await api<{ text: string; promptHash: string }>('prompt', {
      ...ref,
      approved: true,
    });
    aiShare = { ...ref, runnerId, promptHash: reply.promptHash };
    get('ai-share-account').textContent = `This uses your Codex account and the ${model} model.`;
    get('ai-share-preview').textContent = reply.text;
    get('status').textContent = 'Review the excerpts. Nothing has been sent.';
  });
  if (aiShare) get<HTMLDialogElement>('ai-share-dialog').showModal();
}

async function analyzeProject(): Promise<void> {
  const approvedShare = aiShare;
  if (!approvedShare) return;
  get<HTMLDialogElement>('ai-share-dialog').close();
  await action('Drafting notes with your Codex account.', async () => {
    analysisAbort = new AbortController();
    get('analysis-progress').hidden = false;
    get<HTMLButtonElement>('cancel-analysis').disabled = false;
    const started = Date.now();
    const elapsed = () => {
      get('analysis-elapsed').textContent =
        `${Math.floor((Date.now() - started) / 1000)} seconds elapsed`;
    };
    elapsed();
    const timer = setInterval(elapsed, 1000);
    try {
      const reply = await api<Reply>(
        'ai/analyze',
        { ...approvedShare, approved: true },
        analysisAbort.signal,
      );
      view = reply.view;
      render();
      get('status').textContent =
        'Your AI drafted the notes. Review the suggestions before saving.';
    } catch (error) {
      if (analysisAbort.signal.aborted)
        get('status').textContent = 'Analysis canceled. No note files were saved.';
      else throw error;
    } finally {
      clearInterval(timer);
      analysisAbort = null;
      get('analysis-progress').hidden = true;
    }
  });
}

function renderNavigation(project: Project | null): void {
  get('project-count').textContent = String(view.projects.length);
  get('projects').innerHTML =
    view.projects
      .slice(0, visibleProjects)
      .map(
        (item) =>
          `<button data-project="${escape(item.id)}" ${project?.id === item.id ? 'aria-current="page"' : ''}>${escape(item.name)}<small>${item.isSaved ? 'Note saved' : 'Ready to review'}</small></button>`,
      )
      .join('') +
    (view.projects.length > visibleProjects
      ? '<button id="more-projects" class="text-button">Show more projects</button>'
      : '');
  for (const [index, step] of ['choose', 'review', 'save'].entries()) {
    const element = get(`step-${step}`);
    const current = project ? (view.isSaved ? 2 : 1) : 0;
    element.classList.toggle(
      'complete',
      index < current || (index === 2 && Boolean(project) && view.isSaved),
    );
    if (index === current) element.setAttribute('aria-current', 'step');
    else element.removeAttribute('aria-current');
  }
}

async function pickProject(): Promise<void> {
  await action('Choose a project in the folder window.', async () => {
    const result = await api<{ path: string | null }>('pick', {});
    if (!result.path) {
      get('status').textContent = 'No folder selected. Your current project is unchanged.';
      return;
    }
    get('status').textContent = 'Reading project files. No code is running.';
    const reply = await api<Reply>('projects', { path: result.path });
    view = reply.view;
    adding = false;
    render();
    get('status').textContent = 'Scan complete. Review the notes below.';
    get('workspace').focus();
  });
}

document.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
  if (button?.id === 'retry-start') {
    void initialize();
    return;
  }
  if (button?.id === 'cancel-analysis') {
    analysisAbort?.abort();
    return;
  }
  if (!button || busy) return;
  if (button.dataset.project) {
    void action('Opening project.', async () => {
      adding = false;
      await mutate(
        'select',
        { projectId: button.dataset.project },
        'Project opened. Your review is saved.',
      );
    });
    return;
  }
  switch (button.id) {
    case 'select-all-notes':
      void action('Selecting these notes for review.', async () => {
        const previous = view;
        const reply = await api<Reply>('review', {
          ...references(),
          selected: view.project!.notes.map((note) => note.id),
        });
        view = reply.view;
        syncReview(previous);
        get('status').textContent = 'All notes selected. Review them before saving.';
      });
      break;
    case 'update-all':
      void updateAll();
      break;
    case 'analyze-ai':
      void reviewAiShare();
      break;
    case 'cancel-ai-share':
      get<HTMLDialogElement>('ai-share-dialog').close();
      break;
    case 'send-ai-share':
      void analyzeProject();
      break;
    case 'refresh-ai':
      void action('Checking your AI connection.', refreshAi);
      break;
    case 'connect-ai':
      void action('Connecting your AI account.', async () => {
        if (!ai?.detected) return;
        ai = await api<AiStatus>('ai/connect', {
          binaryHash: ai.detected.binaryHash,
          model: get<HTMLSelectElement>('ai-model').value,
          approved: true,
        });
        renderAi();
        renderAiAction();
        get('status').textContent =
          'AI connected. Choose Draft notes with Codex when you are ready.';
      });
      break;
    case 'disconnect-ai':
      void action('Disconnecting your AI.', async () => {
        ai = await api<AiStatus>('ai/disconnect', {});
        renderAi();
        renderAiAction();
        get('status').textContent = 'AI disconnected. Your saved notes are kept.';
      });
      break;
    case 'add-project':
      adding = true;
      render();
      get('choose-project').focus();
      break;
    case 'cancel-add':
      adding = false;
      render();
      break;
    case 'more-projects':
      visibleProjects += 5;
      renderNavigation(adding ? null : view.project);
      break;
    case 'more-notes':
      visibleNotes += 5;
      {
        const nextRows = [...document.querySelectorAll<HTMLElement>('.note-row[hidden]')].slice(
          0,
          5,
        );
        for (const row of nextRows) row.hidden = false;
        if (visibleNotes >= view.project!.notes.length) get('more-note-controls').remove();
        else get('visible-note-count').textContent = String(visibleNotes);
        nextRows[0]?.querySelector<HTMLInputElement>('input')?.focus();
      }
      break;
    case 'choose-project':
      void pickProject();
      break;
    case 'scan-path':
      void action('Reading project files. No code is running.', async () => {
        const reply = await api<Reply>('projects', {
          path: get<HTMLInputElement>('project-path').value,
        });
        view = reply.view;
        adding = false;
        render();
        get('status').textContent = 'Scan complete. Review the notes below.';
      });
      break;
    case 'rescan':
      void action('Checking for changed files.', async () => {
        await mutate('scan', references(), 'Scan complete. Review the current notes.');
      });
      break;
    case 'choose-destination':
      void action('Choose a memory folder in the folder window.', async () => {
        const result = await api<{ path: string | null }>('pick', {});
        if (result.path)
          await mutate(
            'destination',
            { path: result.path },
            'Memory folder changed. No notes were written.',
          );
        else get('status').textContent = 'Memory folder unchanged.';
      });
      break;
    case 'set-destination':
      void action('Checking the memory folder.', async () => {
        await mutate(
          'destination',
          { path: get<HTMLInputElement>('destination-path').value },
          'Memory folder changed. No notes were written.',
        );
      });
      break;
    case 'save':
      void action('Checking sources and saving selected notes.', async () => {
        const reply = await mutate('save', { ...references(), reviewHash: view.reviewHash }, '');
        get('status').textContent = reply.result?.unchanged
          ? 'Already saved. No duplicate file was created.'
          : 'Note saved. You can open it in Obsidian or your text editor.';
      });
      break;
    case 'copy-path':
      void action('Copying the saved path.', async () => {
        await navigator.clipboard.writeText(view.project!.savedPath!);
        get('status').textContent = 'Saved path copied.';
      });
      break;
    case 'prepare-prompt':
      void action('Preparing the evidence prompt.', async () => {
        const reply = await api<{ text: string }>('prompt', {
          ...references(),
          approved: get<HTMLInputElement>('share-consent').checked,
        });
        get('prompt-preview').textContent = reply.text;
        get('prompt-area').hidden = false;
        get('status').textContent = 'Prompt ready to review. Nothing was sent to an AI service.';
      });
      break;
    case 'copy-prompt':
      void action('Copying the prompt.', async () => {
        await navigator.clipboard.writeText(get('prompt-preview').textContent ?? '');
        get('status').textContent = 'Prompt copied. Paste it into your own AI chat.';
      });
      break;
    case 'import-reply':
      void action('Checking the reply and its source quotes.', async () => {
        await mutate(
          'import',
          { ...references(), text: get<HTMLTextAreaElement>('ai-reply').value },
          'AI suggestions added. Review each claim before saving.',
        );
      });
      break;
  }
});

document.addEventListener('change', (event) => {
  const input = event.target as HTMLInputElement;
  if (input.id === 'ai-model') {
    get<HTMLButtonElement>('connect-ai').disabled = busy || !input.value;
    return;
  }
  if (input.id === 'share-consent') {
    const button = document.getElementById('copy-prompt') as HTMLButtonElement | null;
    if (button) button.disabled = !input.checked;
  }
  if (!input.dataset.note || busy) return;
  const selected = view.project!.selected.filter((id) => id !== input.dataset.note);
  if (input.checked) selected.push(input.dataset.note);
  void action('Saving your selection.', async () => {
    try {
      const previous = view;
      const reply = await api<Reply>('review', { ...references(), selected });
      view = reply.view;
      syncReview(previous);
      get('status').textContent = 'Selection saved. No note files changed.';
    } catch (error) {
      input.checked = !input.checked;
      throw error;
    }
  });
});

async function initialize(): Promise<void> {
  setBusy(true, 'Opening your saved project list.');
  get('error').hidden = true;
  try {
    view = await api<View>('state');
    render();
    renderAi();
    setBusy(false);
    get('status').textContent = '';
  } catch (error) {
    showError(error);
    get('content').innerHTML =
      '<h1>The app is not ready.</h1><p>Your saved notes were not changed. Try again or reopen Memory Hub from its launcher.</p><button id="retry-start" class="secondary">Try again</button>';
  }
}

get<HTMLDialogElement>('ai-share-dialog').addEventListener('close', () => {
  aiShare = null;
  get('ai-share-preview').textContent = '';
});

void initialize();
