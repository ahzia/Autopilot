// SPDX-License-Identifier: MIT
// Autopilot Inbox: phone-first decision cards for the founder.
//
// Vanilla JS, no build step, no external resources. Everything the server
// sends is rendered with createElement/textContent (never parsed as HTML),
// links are limited to http(s) and same-origin paths, and every write carries
// the session's CSRF token.

const POLL_MS = 15000;
const DEFER_HOURS = 4;
const SWIPE_THRESHOLD = 100;
const DRAG_SLOP = 12;
const TOAST_MS = 4000;
const STALE_HEARTBEAT_MS = 3 * 60 * 1000;
const RETRY_MS = 10000;
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

const KIND_LABELS = { choice: 'Decision', review: 'Review', authorization: 'Authorize', diagnostic: 'Problem', info: 'FYI' };
const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 };

// Board order: work in motion first, then queued, then finished.
const STATE_ORDER = [
  'building', 'checking', 'reviewing', 'merging', 'waiting_decision', 'review_ready', 'merge_ready',
  'ready', 'proposed', 'exhausted', 'integrated', 'cancelled',
];
const STATE_LABELS = {
  building: 'Building', checking: 'Checking', reviewing: 'In review', merging: 'Merging',
  waiting_decision: 'Waiting on you', review_ready: 'Ready for review', merge_ready: 'Ready to merge',
  ready: 'Queued', proposed: 'Proposed', exhausted: 'Stuck', integrated: 'Integrated', cancelled: 'Cancelled',
};
const COLLAPSED_STATES = new Set(['proposed', 'integrated', 'cancelled']);
const FINAL_STATES = new Set(['integrated', 'cancelled']);
const VERDICT_LABELS = {
  approve: 'Approved', request_changes: 'Changes requested', needs_human: 'Needs you',
  human_approve: 'You approved', human_request_changes: 'You requested changes',
};
const PROFILE_LABELS = {
  supervised: 'Supervised', balanced_autopilot: 'Balanced autopilot', integration_only: 'Integration only', pause: 'Paused by profile',
};

// ------------------------------------------------------------------ state

const state = {
  authenticated: false,
  authSeq: 0, // bumped by every session check or pairing attempt; only the latest one acts
  csrf: '',
  tab: 'inbox',
  project: readSetting('ap.project', ''),
  overview: null,
  clockSkew: 0, // server clock minus phone clock
  offline: false,
  pollTimer: 0,
  retryTimer: 0, // the single pending "Can't reach Autopilot" retry
  filterSignature: '',

  decisions: [], // pending cards in inbox order
  decisionsLoaded: false,
  decisionsSeq: 0, // bumped on every load and local change; stale responses are dropped
  currentId: null,
  focusDecisionId: null, // from a "#decision=D-7" link
  showSnoozed: false,
  drafts: new Map(), // decision id -> { revision, optionId, comment }
  submission: null, // { id, revision, optionId, comment, key, status: saving|failed|invalid, error }
  deferringId: null,
  notice: null, // { id, text } shown on a card (e.g. "This card changed")
  card: null, // element refs of the rendered card
  renderedKey: '',
  focusNextCard: false,

  tasks: [],
  tasksLoaded: false,
  tasksSeq: 0, // like decisionsSeq: an answer for an older load or another project is dropped
  boardOpen: new Map(),
  digest: null,
  digestSeq: 0,
  detailTaskId: null,
};

const $ = (id) => document.getElementById(id);
const els = {
  topControls: $('topbar-controls'),
  filter: $('project-filter'),
  badge: $('pending-badge'),
  pendingCount: $('pending-count'),
  offline: $('offline-banner'),
  tabbar: $('tabbar'),
  tabs: [...document.querySelectorAll('#tabbar [data-tab]')],
  tabBadge: $('tab-badge'),
  screens: {
    loading: $('screen-loading'),
    pair: $('screen-pair'),
    inbox: $('screen-inbox'),
    digest: $('screen-digest'),
    board: $('screen-board'),
    status: $('screen-status'),
  },
  pairForm: $('pair-form'),
  pairCode: $('pair-code'),
  pairError: $('pair-error'),
  inboxBody: $('inbox-body'),
  digestBody: $('digest-body'),
  boardBody: $('board-body'),
  statusBody: $('status-body'),
  addTask: $('add-task'),
  addTaskForm: $('add-task-form'),
  taskProject: $('task-project'),
  taskTitle: $('task-title'),
  taskObjective: $('task-objective'),
  taskCriteria: $('task-criteria'),
  taskFormError: $('task-form-error'),
  toast: $('toast'),
  sheet: $('sheet'),
  sheetTitle: $('sheet-title'),
  sheetBody: $('sheet-body'),
  sheetClose: $('sheet-close'),
};

// ----------------------------------------------------------- DOM helpers

/** Build an element. Props: class, dataset, on<event> handlers, other attributes. Children are nodes or text. */
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  append(el, children);
  return el;
}

function append(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false || child === '') continue;
    parent.append(child instanceof Node ? child : String(child));
  }
}

function replace(parent, ...children) {
  parent.replaceChildren();
  append(parent, children);
}

/** Re-render a container, keeping keyboard focus on the element with the same data-key. */
function preserveFocus(container, render) {
  const active = document.activeElement;
  const key = active && container.contains(active) && active.dataset ? active.dataset.key : undefined;
  render();
  if (!key) return;
  const again = [...container.querySelectorAll('[data-key]')].find((el) => el.dataset.key === key);
  if (again) again.focus();
}

const chip = (text, tone = '') => h('span', { class: tone ? `chip ${tone}` : 'chip' }, text);

function section(title, ...content) {
  return h('section', { class: 'detail-section' }, h('h3', {}, title), content);
}

function readSetting(key, fallback) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeSetting(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage can be unavailable (private mode); the filter simply won't persist
  }
}

// ------------------------------------------------------------- formatting

const serverNow = () => Date.now() + state.clockSkew;
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

function ago(ts) {
  if (!ts) return '';
  const s = Math.max(0, Math.round((serverNow() - ts) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const hours = Math.round(m / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function duration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${total % 60}s`;
  return `${total % 60}s`;
}

function clockTime(ts) {
  return new Date(ts).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

function tone(status) {
  if (['passed', 'succeeded', 'approve', 'human_approve', 'answered', 'integrated'].includes(status)) return 'ok';
  if (['failed', 'error', 'timeout', 'lost', 'killed', 'blocker', 'exhausted', 'request_changes', 'human_request_changes'].includes(status)) return 'bad';
  if (['major', 'usage_limited', 'needs_human', 'yielded', 'skipped', 'waiting_decision', 'pending'].includes(status)) return 'warn';
  if (['running', 'building', 'checking', 'reviewing', 'merging'].includes(status)) return 'info';
  return '';
}

/** Only http(s) URLs and same-origin relative paths become links. */
function safeHref(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text) return null;
  let url;
  try {
    url = new URL(text, location.origin);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  // "//host/x" or "/\host" resolve to another origin: they are not relative links.
  if (!/^https?:\/\//i.test(text) && url.origin !== location.origin) return null;
  return url.href;
}

function externalLink(text, href) {
  const safe = safeHref(href);
  return safe ? h('a', { href: safe, target: '_blank', rel: 'noopener noreferrer' }, text) : h('span', {}, text);
}

function projectName(id) {
  const p = state.overview && state.overview.projects ? state.overview.projects.find((x) => x.id === id) : null;
  return p ? p.name : id;
}

// ------------------------------------------------------------------ toast

let toastTimer = 0;
let toastClearTimer = 0;

function toast(message) {
  clearTimeout(toastTimer);
  clearTimeout(toastClearTimer);
  els.toast.textContent = message;
  els.toast.classList.add('show');
  toastTimer = setTimeout(() => {
    els.toast.classList.remove('show');
    // Clear afterwards so the same message is announced again next time.
    toastClearTimer = setTimeout(() => {
      els.toast.textContent = '';
    }, 300);
  }, TOAST_MS);
}

// -------------------------------------------------------------------- api

class NetworkError extends Error {}

/** JSON request; resolves { status, data } for any HTTP answer, throws NetworkError when unreachable. */
async function api(method, path, body, retried = false) {
  const headers = { Accept: 'application/json' };
  const init = { method, headers, credentials: 'same-origin', cache: 'no-store' };
  if (method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    if (state.csrf) headers['X-CSRF-Token'] = state.csrf;
    init.body = JSON.stringify(body ?? {});
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    setOffline(true);
    throw new NetworkError('network');
  }
  // Behind Tailscale Serve (or any proxy) a stopped Autopilot answers 502/503/504:
  // that is offline too, so the banner flags the cards on screen as stale.
  setOffline(isGatewayError(res.status));
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  // The CSRF token can change if this phone paired again in another tab: refresh it once.
  if (res.status === 403 && data && data.error === 'csrf' && !retried && (await refreshCsrf())) {
    return api(method, path, body, true);
  }
  if (res.status === 401 && state.authenticated && path !== '/api/pair') signedOut();
  return { status: res.status, data };
}

async function refreshCsrf() {
  try {
    const res = await fetch('/api/me', { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } });
    const data = await res.json();
    if (data && data.authenticated && data.csrf) {
      state.csrf = data.csrf;
      return true;
    }
  } catch {
    // fall through
  }
  return false;
}

function setOffline(offline) {
  if (state.offline === offline) return;
  state.offline = offline;
  els.offline.hidden = !offline;
}

/** The answer came from a proxy in front of Autopilot, not from Autopilot. */
const isGatewayError = (status) => status >= 502 && status <= 504;

const projectParam = () => (state.project ? `&project=${encodeURIComponent(state.project)}` : '');

/** Generated once per submission and reused for its retries (crypto.randomUUID needs https). */
function newIdempotencyKey() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ------------------------------------------------------------ boot & auth

async function boot() {
  wireControls();
  registerServiceWorker();
  if (consumeHash()) return;
  await checkSession();
}

/** Handle "#code=..." (pairing link) and "#decision=D-7" (notification link). True when pairing started. */
function consumeHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  const code = params.get('code');
  const decision = params.get('decision');
  const task = params.get('task');
  if (!code && !decision && !task) return false;
  history.replaceState(null, '', location.pathname + location.search);
  if (decision) state.focusDecisionId = decision;
  if (code) {
    pairWith(code);
    return true;
  }
  if (task && /^T-\d{1,9}$/.test(task)) state.openTaskId = task;
  if (state.authenticated) {
    if (state.openTaskId) {
      showTab('board');
      openTask(state.openTaskId);
      state.openTaskId = null;
    } else {
      showTab('inbox');
      loadDecisions();
    }
  }
  return false;
}

// ------------------------------------------------------------- notifications

const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && window.isSecureContext;
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isAppleMobile = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function base64UrlToBytes(s) {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

/** 'on' | 'off' | 'install' (iPhone: add to Home Screen first) | 'denied' | 'unsupported' */
async function computePushState() {
  if (!pushSupported()) return isAppleMobile() && !isStandalone() ? 'install' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  try {
    const reg = await navigator.serviceWorker.getRegistration('/');
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    return sub ? 'on' : 'off';
  } catch {
    return 'off';
  }
}

async function refreshPushState() {
  state.pushState = await computePushState();
  renderStatus();
}

async function enableNotifications() {
  try {
    // Must run from a tap: iOS only grants permission in response to a user gesture.
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      toast('Notifications were not allowed.');
      return refreshPushState();
    }
    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    const key = await api('GET', '/api/push/key');
    if (key.status !== 200 || !key.data || !key.data.publicKey) throw new Error('the server did not provide a key');
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(key.data.publicKey) });
    const json = sub.toJSON();
    const saved = await api('POST', '/api/push/subscribe', { endpoint: json.endpoint, keys: json.keys });
    if (saved.status !== 200) throw new Error((saved.data && saved.data.error) || `HTTP ${saved.status}`);
    toast('Notifications are on for this device.');
  } catch (err) {
    toast(`Could not turn on notifications: ${err && err.message ? err.message : err}`);
  }
  return refreshPushState();
}

async function disableNotifications() {
  try {
    const reg = await navigator.serviceWorker.getRegistration('/');
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    if (sub) {
      await api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint });
      await sub.unsubscribe();
    }
    toast('Notifications are off for this device.');
  } catch {
    toast('Could not turn notifications off.');
  }
  return refreshPushState();
}

async function testNotification() {
  const r = await api('POST', '/api/push/test', {});
  toast(r.status === 200 ? 'Test sent. It should arrive in a few seconds.' : (r.data && r.data.error) || 'Could not send a test.');
}

function notificationsPanel() {
  const s = state.pushState;
  if (s === undefined) {
    refreshPushState();
    return h('p', { class: 'muted' }, 'Checking notifications…');
  }
  if (s === 'on') {
    return h('div', {},
      h('p', {}, 'Notifications are on: you get one when a decision needs you (counts only, never card text).'),
      h('div', { class: 'detail-actions' },
        h('button', { type: 'button', class: 'btn btn-secondary', onclick: testNotification }, 'Send a test'),
        h('button', { type: 'button', class: 'btn btn-secondary', onclick: disableNotifications }, 'Turn off'),
      ));
  }
  if (s === 'off') {
    return h('div', {},
      h('p', { class: 'muted' }, 'Get a notification when a decision needs you.'),
      h('button', { type: 'button', class: 'btn btn-primary', onclick: enableNotifications }, 'Enable notifications'));
  }
  if (s === 'install') {
    return h('p', { class: 'muted' }, 'On iPhone, first add this page to your Home Screen (Share → Add to Home Screen), open it from there, then enable notifications here.');
  }
  if (s === 'denied') return h('p', { class: 'warn' }, 'Notifications are blocked for this site. Allow them in Settings, then come back.');
  return h('p', { class: 'muted' }, 'This browser cannot receive notifications here. It needs HTTPS (for example through Tailscale Serve) and a browser with Web Push.');
}

// ------------------------------------------------------------- code changes

async function loadDiff(id, container) {
  replace(container, h('p', { class: 'muted' }, 'Loading the changes…'));
  let r;
  try {
    r = await api('GET', `/api/tasks/${encodeURIComponent(id)}/diff`);
  } catch {
    replace(container, h('p', { class: 'form-error' }, 'Could not reach Autopilot.'));
    return;
  }
  if (r.status !== 200 || !r.data) {
    replace(container, h('p', { class: 'muted' }, r.status === 404 ? 'No changes to show yet.' : 'Could not load the changes.'));
    return;
  }
  const MAX_LINES = 3000;
  const lines = String(r.data.patch || '').split('\n');
  const kind = (l) => (l.startsWith('+++') || l.startsWith('---') ? 'meta' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : l.startsWith('@@') ? 'hunk' : l.startsWith('diff ') ? 'meta' : '');
  replace(container,
    h('ul', { class: 'detail-list' }, (r.data.files || []).map((f) =>
      h('li', {}, h('span', { class: 'mono' }, `${f.status} ${f.path}`), ' ', h('span', { class: 'muted small' }, `+${f.added} −${f.deleted}`)))),
    h('pre', { class: 'diff', tabindex: '0', 'aria-label': 'Code changes' }, lines.slice(0, MAX_LINES).map((l) => h('span', { class: kind(l) }, l || ' '))),
    r.data.truncated || lines.length > MAX_LINES ? h('p', { class: 'muted small' }, 'A long change: only the beginning is shown here.') : null,
  );
}

/**
 * Ask Autopilot whether this phone is paired. Only an explicit "not
 * authenticated" answer shows the Pair screen: a proxy answering for a stopped
 * Autopilot (502/503/504) or a server error says nothing about the session.
 */
async function checkSession() {
  clearRetry();
  const seq = ++state.authSeq;
  let r;
  try {
    r = await api('GET', '/api/me');
  } catch {
    if (seq === state.authSeq) showUnreachable();
    return;
  }
  if (seq !== state.authSeq) return; // a newer check or a pairing attempt took over
  if (r.status === 200 && r.data && typeof r.data.authenticated === 'boolean') {
    if (r.data.authenticated) {
      state.csrf = r.data.csrf || '';
      enterApp();
    } else {
      showPair();
    }
  } else {
    showUnreachable(r.status);
  }
}

function clearRetry() {
  clearTimeout(state.retryTimer);
  state.retryTimer = 0;
}

/** "Can't reach Autopilot", with a Try again button and a single automatic retry pending. */
function showUnreachable(status) {
  clearRetry();
  const detail = status
    ? `Autopilot is not answering (HTTP ${status}). Check that it is running on your computer.`
    : 'Check that it is running on your computer and that this phone can reach it.';
  const retry = h('button', {
    type: 'button',
    class: 'btn btn-primary',
    onclick: () => {
      retry.disabled = true;
      retry.textContent = 'Trying…';
      checkSession();
    },
  }, 'Try again');
  showScreen('loading');
  replace(
    els.screens.loading,
    h('div', { class: 'empty-state' },
      h('p', { class: 'empty-title' }, 'Can’t reach Autopilot'),
      h('p', { class: 'muted' }, detail),
      retry,
    ),
  );
  state.retryTimer = setTimeout(() => {
    state.retryTimer = 0;
    if (!state.authenticated && !els.screens.loading.hidden) checkSession();
  }, RETRY_MS);
}

function showLoading(text) {
  replace(els.screens.loading, h('p', { class: 'muted center' }, text));
  showScreen('loading');
}

async function pairWith(code) {
  clearRetry(); // a pending session check must not show the Pair screen mid-pairing
  const seq = ++state.authSeq;
  showLoading('Connecting…');
  let r;
  try {
    r = await api('POST', '/api/pair', { code });
  } catch {
    if (seq === state.authSeq) showPair('Could not reach Autopilot. Check that it is running, then open the link again.');
    return;
  }
  if (seq !== state.authSeq) return;
  if (r.status === 200 && r.data && r.data.csrf) {
    state.csrf = r.data.csrf;
    enterApp();
    toast('This phone is connected');
    return;
  }
  let message = 'That link has expired or was already used. Run autopilot pair again for a new one.';
  if (r.status === 429) message = 'Too many attempts. Wait a minute, then try again.';
  // Autopilot (or the proxy in front of it) failed: the link was most likely not used up.
  else if (r.status >= 500) message = 'Could not reach Autopilot. Check that it is running, then open the link again.';
  // An old link opened on a phone that is already paired: keep the existing session.
  const paired = await refreshCsrf();
  if (seq !== state.authSeq) return;
  if (paired) {
    enterApp();
    toast('This phone is already connected');
    return;
  }
  showPair(message);
}

function extractCode(text) {
  const value = text.trim();
  const m = /[#&?]code=([^&\s]+)/.exec(value);
  if (!m) return value;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

function showPair(message = '') {
  state.authenticated = false;
  clearRetry();
  stopPolling();
  els.topControls.hidden = true;
  els.tabbar.hidden = true;
  els.pairError.textContent = message;
  els.pairError.hidden = !message;
  document.title = 'Autopilot';
  showScreen('pair');
}

function signedOut() {
  state.csrf = '';
  if (els.sheet.open) els.sheet.close();
  showPair('Your session ended. Run autopilot pair to connect this phone again.');
}

async function logout() {
  if (!confirm('Sign out this phone? You will need a new pairing link to connect again.')) return;
  try {
    await api('POST', '/api/logout', {});
  } catch {
    // sign out locally anyway; the cookie expires on its own
  }
  state.csrf = '';
  showPair('Signed out.');
}

function enterApp() {
  state.authenticated = true;
  clearRetry();
  els.topControls.hidden = false;
  els.tabbar.hidden = false;
  // A "#task=T-12" link (e.g. from a review card) is read before the session is known.
  const pendingTask = state.openTaskId;
  state.openTaskId = null;
  showTab(pendingTask ? 'board' : state.tab);
  refresh();
  startPolling();
  if (pendingTask) openTask(pendingTask);
}

// ------------------------------------------------------------- navigation

function showScreen(name) {
  for (const [key, el] of Object.entries(els.screens)) el.hidden = key !== name;
}

function showTab(tab) {
  state.tab = tab;
  for (const button of els.tabs) {
    if (button.dataset.tab === tab) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  showScreen(tab);
  if (tab === 'inbox') renderInbox(true);
  else if (tab === 'digest') {
    renderDigest();
    loadDigest();
  } else if (tab === 'board') {
    renderBoard();
    loadTasks();
  } else if (tab === 'status') {
    renderStatus();
    loadOverview();
  }
}

function wireControls() {
  for (const button of els.tabs) {
    button.addEventListener('click', () => {
      if (state.tab !== button.dataset.tab) showTab(button.dataset.tab);
    });
  }
  els.filter.addEventListener('change', () => {
    state.project = els.filter.value;
    writeSetting('ap.project', state.project);
    onProjectChanged();
  });
  els.pairForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const code = extractCode(els.pairCode.value);
    if (code) pairWith(code);
    else showPair('Paste the link or code that autopilot pair printed.');
  });
  $('digest-refresh').addEventListener('click', () => loadDigest());
  $('board-refresh').addEventListener('click', () => loadTasks());
  els.addTaskForm.addEventListener('submit', onAddTask);
  els.addTask.addEventListener('toggle', () => {
    if (els.addTask.open) syncTaskProjectSelect();
  });
  els.sheetClose.addEventListener('click', () => els.sheet.close());
  els.sheet.addEventListener('click', (event) => {
    if (event.target === els.sheet) els.sheet.close(); // tap on the backdrop
  });
  els.sheet.addEventListener('close', () => {
    state.detailTaskId = null;
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.authenticated) refresh();
  });
  window.addEventListener('online', () => {
    if (state.authenticated) refresh();
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted && state.authenticated) refresh();
  });
  window.addEventListener('hashchange', () => consumeHash());
}

function onProjectChanged() {
  state.decisions = [];
  state.decisionsLoaded = false;
  state.currentId = null;
  state.showSnoozed = false;
  state.notice = null;
  // Answers still in flight are for the previous filter: drop them.
  state.decisionsSeq++;
  state.tasksSeq++;
  state.digestSeq++;
  state.tasksLoaded = false;
  state.digest = null;
  updateBadge();
  if (state.tab === 'inbox') renderInbox(true);
  if (state.tab === 'board') renderBoard();
  if (state.tab === 'digest') {
    renderDigest();
    loadDigest();
  }
  if (state.tab === 'status') renderStatus();
  refresh();
}

// ---------------------------------------------------------------- polling

function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(() => {
    if (document.visibilityState === 'visible') refresh();
  }, POLL_MS);
}

function stopPolling() {
  clearInterval(state.pollTimer);
  state.pollTimer = 0;
}

async function refresh() {
  if (!state.authenticated) return;
  const jobs = [loadOverview(), loadDecisions()];
  if (state.tab === 'board' && !els.sheet.open) jobs.push(loadTasks());
  await Promise.all(jobs);
}

// Live clocks: elapsed times, countdowns and "x ago" labels tick every second.
setInterval(() => {
  if (document.visibilityState !== 'visible' || !state.authenticated) return;
  const now = serverNow();
  for (const el of document.querySelectorAll('[data-since]')) el.textContent = duration(now - Number(el.dataset.since));
  for (const el of document.querySelectorAll('[data-until]')) {
    const left = Number(el.dataset.until) - now;
    el.textContent = left > 0 ? duration(left) : 'a moment';
  }
  for (const el of document.querySelectorAll('[data-ago]')) el.textContent = ago(Number(el.dataset.ago));
  for (const el of document.querySelectorAll('[data-age]')) el.textContent = `${duration(now - Number(el.dataset.age))} ago`;
}, 1000);

// ---------------------------------------------------------------- loading

async function loadOverview() {
  let r;
  try {
    r = await api('GET', '/api/overview');
  } catch {
    return;
  }
  if (r.status !== 200 || !r.data) return;
  state.overview = r.data;
  if (typeof r.data.now === 'number') state.clockSkew = r.data.now - Date.now();
  syncProjectFilter();
  if (state.tab === 'status') renderStatus();
  if (state.tab === 'inbox' && !state.card) renderInbox();
}

async function loadDecisions() {
  const seq = ++state.decisionsSeq;
  let r = null;
  try {
    r = await api('GET', `/api/decisions?status=pending${projectParam()}`);
  } catch {
    // unreachable: handled with the failed answers below
  }
  // Drop answers that raced with a local change (answer, snooze, filter switch).
  if (seq !== state.decisionsSeq) return;
  if (!r || r.status !== 200 || !r.data) {
    if (!state.decisionsLoaded && state.tab === 'inbox') renderInbox(true); // shows the offline state
    return;
  }
  if (state.submission && state.submission.status === 'saving') return;
  applyDecisions(Array.isArray(r.data.decisions) ? r.data.decisions : []);
}

function applyDecisions(list) {
  const previous = currentDecision();
  state.decisions = list;
  state.decisionsLoaded = true;
  if (state.focusDecisionId) {
    if (list.some((d) => d.id === state.focusDecisionId)) {
      state.currentId = state.focusDecisionId;
      if (state.tab !== 'inbox') showTab('inbox');
    }
    state.focusDecisionId = null;
  }
  if (previous) {
    const fresh = list.find((d) => d.id === previous.id);
    if (!fresh) {
      if (state.currentId === previous.id) state.currentId = null;
      const draft = state.drafts.get(previous.id);
      if (draft && (draft.optionId || draft.comment.trim())) toast('That card was answered or closed elsewhere.');
    } else if (fresh.revision !== previous.revision) {
      state.notice = { id: fresh.id, text: 'This card changed. Check the new version before answering.' };
    }
  }
  for (const id of [...state.drafts.keys()]) {
    if (!list.some((d) => d.id === id)) state.drafts.delete(id);
  }
  updateBadge();
  renderInbox();
}

async function loadTasks() {
  const seq = ++state.tasksSeq;
  let r = null;
  try {
    r = await api('GET', `/api/tasks?${projectParam().slice(1)}`);
  } catch {
    // unreachable: handled with the failed answers below
  }
  // A newer load or a project switch happened meanwhile: this answer is stale.
  if (seq !== state.tasksSeq) return;
  if (!r || r.status !== 200 || !r.data) {
    if (!state.tasksLoaded) renderBoard(); // shows the offline state
    return;
  }
  state.tasks = Array.isArray(r.data.tasks) ? r.data.tasks : [];
  state.tasksLoaded = true;
  renderBoard();
}

async function loadDigest() {
  const seq = ++state.digestSeq;
  let r = null;
  try {
    r = await api('GET', `/api/digest?hours=24${projectParam()}`);
  } catch {
    // unreachable: handled with the failed answers below
  }
  // The digest is not polled, so a stale answer (e.g. for the previous project) would stick.
  if (seq !== state.digestSeq) return;
  if (!r || r.status !== 200 || !r.data) {
    if (!state.digest) renderDigest(); // shows the offline state
    return;
  }
  state.digest = r.data;
  renderDigest();
}

// ----------------------------------------------------------------- header

function syncProjectFilter() {
  const projects = (state.overview && state.overview.projects) || [];
  const signature = projects.map((p) => `${p.id}\u0001${p.name}`).join('\u0002');
  if (signature !== state.filterSignature) {
    state.filterSignature = signature;
    replace(els.filter, h('option', { value: '' }, 'All projects'), projects.map((p) => h('option', { value: p.id }, p.name)));
  }
  if (state.project && !projects.some((p) => p.id === state.project)) {
    state.project = '';
    writeSetting('ap.project', '');
  }
  els.filter.value = state.project;
  els.filter.hidden = projects.length < 2 && !state.project;
}

function updateBadge() {
  const n = state.decisions.length;
  els.pendingCount.textContent = String(n);
  els.badge.classList.toggle('zero', n === 0);
  els.tabBadge.textContent = String(n);
  els.tabBadge.hidden = n === 0;
  document.title = n ? `(${n}) Autopilot` : 'Autopilot';
}

// ------------------------------------------------------------------ inbox

const isDeferred = (d) => d.deferredUntil !== null && d.deferredUntil !== undefined && d.deferredUntil > serverNow();

function sortPending(list) {
  return [...list].sort(
    (a, b) =>
      Number(isDeferred(a)) - Number(isDeferred(b)) ||
      (PRIORITY_RANK[a.priority] ?? 2) - (PRIORITY_RANK[b.priority] ?? 2) ||
      a.createdAt - b.createdAt,
  );
}

function currentDecision() {
  return state.decisions.find((d) => d.id === state.currentId) || null;
}

/** Keep the card the founder is looking at; otherwise take the first card that is not snoozed. */
function pickCurrent() {
  let current = currentDecision();
  if (!current) {
    current = state.decisions.find((d) => !isDeferred(d)) || (state.showSnoozed ? state.decisions[0] : null) || null;
    state.currentId = current ? current.id : null;
  }
  return current;
}

function draftFor(d) {
  let draft = state.drafts.get(d.id);
  if (!draft) {
    draft = { revision: d.revision, optionId: null, comment: '' };
    state.drafts.set(d.id, draft);
  }
  if (draft.revision !== d.revision) {
    // A new revision may have different options: keep the typed comment, drop the choice.
    draft.revision = d.revision;
    draft.optionId = null;
  }
  return draft;
}

const normalizeComment = (text) => (text && text.trim() ? text.trim() : null);

function commentRequired(d, draft) {
  const option = draft.optionId ? d.options.find((o) => o.id === draft.optionId) : null;
  if (option) return !!option.requiresComment;
  return d.options.length === 0;
}

/** Mirrors the server's rules so "Send" is only enabled for answers it will accept. */
function canSend(d, draft) {
  const comment = normalizeComment(draft.comment);
  if (draft.optionId) {
    const option = d.options.find((o) => o.id === draft.optionId);
    return !!option && (!option.requiresComment || !!comment);
  }
  if (!d.allowComment || !comment) return false;
  return !(d.kind === 'authorization' && d.options.length);
}

/** The option a right swipe may accept, or null when the card needs an explicit tap. */
function swipeAcceptOption(d) {
  if (d.kind === 'authorization' || !d.recommendation) return null;
  const option = d.options.find((o) => o.id === d.recommendation);
  if (!option || option.consequential || option.requiresComment) return null;
  return option;
}

const isBusy = (d) => (state.submission && state.submission.id === d.id && state.submission.status === 'saving') || state.deferringId === d.id;

function runningCount() {
  const runs = (state.overview && state.overview.activeRuns) || [];
  return runs.filter((r) => !state.project || r.projectId === state.project).length;
}

function renderInbox(force = false) {
  if (state.tab !== 'inbox' || !state.authenticated) return;
  if (!state.decisionsLoaded) {
    state.card = null;
    state.renderedKey = 'loading';
    replace(els.inboxBody, h('p', { class: 'muted center' }, state.offline ? 'Offline. Cards load when Autopilot is reachable.' : 'Loading cards…'));
    return;
  }
  const current = pickCurrent();
  if (!current) {
    const key = `empty:${state.decisions.length}:${runningCount()}`;
    if (force || key !== state.renderedKey || state.card) {
      state.card = null;
      state.renderedKey = key;
      replace(els.inboxBody, emptyInbox());
    }
    return;
  }
  const key = `card:${current.id}:${current.revision}:${isDeferred(current)}`;
  if (!force && key === state.renderedKey && state.card) {
    updateCardControls();
    return;
  }
  const hadFocus = els.inboxBody.contains(document.activeElement);
  state.renderedKey = key;
  state.card = buildCard(current);
  replace(els.inboxBody, state.card.counter, state.card.root);
  updateCardControls();
  if (state.focusNextCard) window.scrollTo(0, 0); // the next card starts at its question
  if (state.focusNextCard || hadFocus) state.card.question.focus({ preventScroll: true });
  state.focusNextCard = false;
}

function emptyInbox() {
  const snoozed = state.decisions.filter(isDeferred).length;
  const running = runningCount();
  return h('div', { class: 'empty-state' },
    h('p', { class: 'empty-title' }, 'All clear'),
    h('p', {}, 'Nothing needs you right now.'),
    running ? h('p', { class: 'muted' }, `${plural(running, 'worker')} running.`) : null,
    snoozed
      ? h('button', {
          type: 'button',
          class: 'btn btn-secondary',
          onclick: () => {
            state.showSnoozed = true;
            state.currentId = null;
            renderInbox(true);
          },
        }, `Show ${plural(snoozed, 'snoozed card')}`)
      : null,
  );
}

function buildCard(d) {
  const draft = draftFor(d);
  const refs = { id: d.id, optionButtons: [], textarea: null, commentLabel: null };

  refs.prev = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Previous card', onclick: () => step(-1) }, '‹');
  refs.next = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Next card', onclick: () => step(1) }, '›');
  refs.position = h('span', { class: 'counter-text', 'aria-live': 'polite' });
  refs.counter = h('div', { class: 'counter' }, refs.prev, refs.position, refs.next);

  refs.overlay = h('div', { class: 'swipe-overlay', 'aria-hidden': 'true' });
  refs.time = h('span', { class: 'card-time', dataset: { ago: String(d.createdAt) } }, ago(d.createdAt));
  const context = [d.projectName || projectName(d.projectId), d.taskId ? (d.taskTitle ? `${d.taskId} · ${d.taskTitle}` : d.taskId) : null]
    .filter(Boolean)
    .join(' · ');
  refs.question = h('h2', { class: 'card-question', id: `q-${d.id}`, tabindex: '-1' }, d.question);

  const recommended = d.recommendation ? d.options.find((o) => o.id === d.recommendation) : null;

  if (d.options.length) {
    for (const option of d.options) {
      const button = h('button', {
        type: 'button',
        class: option.consequential ? 'option consequential' : 'option',
        'aria-pressed': 'false',
        dataset: { option: option.id },
        onclick: () => chooseOption(d, option.id),
      },
        h('span', { class: 'option-head' },
          h('span', { class: 'option-label' }, option.label),
          option.id === d.recommendation ? h('span', { class: 'option-tag' }, 'Recommended') : null,
        ),
        option.tradeoff ? h('span', { class: 'option-tradeoff' }, option.tradeoff) : null,
        option.consequential ? h('span', { class: 'option-note' }, 'Consequential: needs an explicit tap') : null,
        option.requiresComment ? h('span', { class: 'option-note' }, 'Needs a comment') : null,
      );
      refs.optionButtons.push(button);
    }
  }

  if (d.allowComment) {
    const id = `c-${d.id}`;
    refs.commentLabel = h('label', { for: id }, 'Comment (optional)');
    refs.textarea = h('textarea', { id, rows: '3', maxlength: '4000', placeholder: 'Add context for the worker' });
    refs.textarea.value = draft.comment;
    refs.textarea.addEventListener('input', () => {
      draft.comment = refs.textarea.value;
      updateCardControls();
    });
  }

  const links = (d.links || []).map((l) => ({ label: l.label || l.url, href: safeHref(l.url) })).filter((l) => l.href);
  refs.status = h('p', { class: 'card-status', role: 'status' });
  refs.later = h('button', { type: 'button', class: 'btn btn-secondary', onclick: () => deferDecision(d) }, 'Later');
  refs.send = h('button', { type: 'button', class: 'btn btn-primary', onclick: () => onSend(d) }, 'Send');

  const swipeOption = swipeAcceptOption(d);
  refs.root = h('article', { class: 'card', 'aria-labelledby': `q-${d.id}` },
    refs.overlay,
    h('div', { class: 'card-meta' },
      chip(KIND_LABELS[d.kind] || 'Decision', `kind-${d.kind}`),
      d.priority === 'urgent' ? chip('Urgent', 'bad') : d.priority === 'high' ? chip('High priority', 'warn') : null,
      refs.time,
    ),
    context ? h('p', { class: 'card-context' }, context) : null,
    state.notice && state.notice.id === d.id ? h('p', { class: 'card-notice', role: 'alert' }, state.notice.text) : null,
    isDeferred(d) ? h('p', { class: 'card-snoozed' }, `Snoozed until ${clockTime(d.deferredUntil)}`) : null,
    refs.question,
    d.why ? h('div', { class: 'card-why' }, h('h3', {}, 'Why it matters'), h('p', {}, d.why)) : null,
    recommended
      ? h('div', { class: 'card-rec' },
          h('p', {}, 'Recommended: ', h('strong', {}, recommended.label)),
          d.recommendationReason ? h('p', { class: 'rec-reason' }, d.recommendationReason) : null,
        )
      : null,
    refs.optionButtons.length ? h('div', { class: 'options', role: 'group', 'aria-label': 'Options' }, refs.optionButtons) : null,
    refs.textarea ? h('div', { class: 'comment' }, refs.commentLabel, refs.textarea) : null,
    links.length
      ? h('div', { class: 'links' }, links.map((l) => h('a', { href: l.href, target: '_blank', rel: 'noopener noreferrer' }, l.label)))
      : null,
    d.blockedSummary ? h('p', { class: 'card-line' }, h('span', { class: 'line-label' }, 'Waiting: '), d.blockedSummary) : null,
    d.continuesSummary ? h('p', { class: 'card-line' }, h('span', { class: 'line-label' }, 'Meanwhile: '), d.continuesSummary) : null,
    refs.status,
    h('div', { class: 'card-actions' }, refs.later, refs.send),
    h('p', { class: 'swipe-hint' }, swipeOption ? 'Swipe right to accept the recommendation, left for later.' : 'Swipe left for later.'),
  );
  attachSwipe(refs, d, swipeOption);
  return refs;
}

/** Sync the rendered card with the draft/submission state without rebuilding it (keeps focus and typing). */
function updateCardControls() {
  const refs = state.card;
  const d = currentDecision();
  if (!refs || !d || refs.id !== d.id) return;
  const draft = draftFor(d);
  const sub = state.submission && state.submission.id === d.id ? state.submission : null;
  const saving = isBusy(d);
  for (const button of refs.optionButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.option === draft.optionId));
    button.disabled = saving;
  }
  if (refs.textarea) {
    const required = commentRequired(d, draft);
    refs.commentLabel.textContent = required ? 'Comment (required)' : 'Comment (optional)';
    refs.textarea.setAttribute('aria-required', String(required));
    // Highlight only once a chosen option demands a comment; option-less cards just say "required".
    refs.textarea.classList.toggle('needs-comment', required && !!draft.optionId && !normalizeComment(draft.comment));
    refs.textarea.readOnly = saving;
  }
  const retry = !!sub && sub.status === 'failed' && sub.revision === d.revision && sub.optionId === draft.optionId && sub.comment === normalizeComment(draft.comment);
  refs.send.textContent = saving && state.deferringId !== d.id ? 'Saving…' : retry ? 'Retry' : 'Send';
  refs.send.disabled = saving || !canSend(d, draft);
  refs.later.disabled = saving;

  const index = state.decisions.findIndex((x) => x.id === d.id);
  refs.position.textContent = `${index + 1} of ${state.decisions.length}`;
  refs.prev.disabled = saving || index <= 0;
  refs.next.disabled = saving || index < 0 || index >= state.decisions.length - 1;
  refs.time.textContent = ago(d.createdAt);

  let message = '';
  let isError = false;
  if (saving) message = state.deferringId === d.id ? 'Snoozing…' : 'Saving…';
  else if (sub && sub.error) {
    message = sub.error;
    isError = true;
  } else if (draft.optionId && commentRequired(d, draft) && !normalizeComment(draft.comment)) {
    const option = d.options.find((o) => o.id === draft.optionId);
    message = `Add a comment for “${option ? option.label : draft.optionId}”.`;
  }
  refs.status.textContent = message;
  refs.status.classList.toggle('error', isError);
}

function chooseOption(d, optionId) {
  const draft = draftFor(d);
  draft.optionId = draft.optionId === optionId ? null : optionId; // tap again to clear
  updateCardControls();
  if (draft.optionId && commentRequired(d, draft) && state.card && state.card.textarea) state.card.textarea.focus();
}

function step(delta) {
  const index = state.decisions.findIndex((x) => x.id === state.currentId);
  const next = state.decisions[index + delta];
  if (!next) return;
  state.currentId = next.id;
  if (isDeferred(next)) state.showSnoozed = true;
  state.notice = null;
  renderInbox(true);
}

function onSend(d) {
  const draft = draftFor(d);
  if (!canSend(d, draft)) return;
  submit(d, draft.optionId, normalizeComment(draft.comment), false);
}

/** Reuse the pending submission (and its idempotency key) when the answer is unchanged. */
function submissionFor(d, optionId, comment) {
  const s = state.submission;
  if (s && s.id === d.id && s.revision === d.revision && s.optionId === optionId && s.comment === comment) return s;
  state.submission = { id: d.id, revision: d.revision, optionId, comment, key: newIdempotencyKey(), status: 'new', error: '' };
  return state.submission;
}

async function submit(d, optionId, comment, viaSwipe) {
  const sub = submissionFor(d, optionId, comment);
  if (sub.status === 'saving') return;
  sub.status = 'saving';
  sub.error = '';
  draftFor(d).optionId = optionId; // a swipe shows its choice if the card comes back for a retry
  state.decisionsSeq++; // ignore polls already in flight
  if (viaSwipe) {
    state.card = null;
    state.renderedKey = 'saving';
    replace(els.inboxBody, h('p', { class: 'muted center', role: 'status' }, 'Saving…'));
  } else {
    updateCardControls();
  }

  let r;
  try {
    r = await api('POST', `/api/decisions/${encodeURIComponent(d.id)}/respond`, {
      revision: sub.revision,
      optionId: sub.optionId,
      comment: sub.comment,
      idempotencyKey: sub.key,
    });
  } catch {
    sub.status = 'failed';
    sub.error = 'Could not reach Autopilot. Your answer is not saved yet.';
    renderInbox(true);
    return;
  }
  const data = r.data || {};
  if (r.status === 200) {
    onAnswered(d, data.status);
  } else if (r.status === 409 && data.status === 'stale_revision' && data.decision) {
    state.submission = null;
    replaceDecision(data.decision);
    state.notice = { id: d.id, text: 'This card changed. Check the new version before answering.' };
    toast('This card changed');
    renderInbox(true);
  } else if (r.status === 409 || r.status === 404) {
    state.submission = null;
    removeDecision(d.id);
    state.focusNextCard = true;
    toast(r.status === 404 ? 'That card no longer exists.' : 'That card was already answered.');
    renderInbox(true);
  } else if (r.status === 400) {
    sub.status = 'invalid';
    sub.error = data.reason || data.error || 'Autopilot could not accept this answer.';
    renderInbox(true);
  } else if (r.status === 401) {
    state.submission = null; // signedOut() already showed the pairing screen
  } else {
    sub.status = 'failed';
    sub.error = `Autopilot had a problem (HTTP ${r.status}). Your answer is not saved yet.`;
    renderInbox(true);
  }
}

function savedMessage(d) {
  const blocked = d.blockedTaskIds || [];
  if (!d.blocking || !blocked.length) return 'Saved';
  if (blocked.length > 1) return `Saved — ${blocked.length} tasks will resume`;
  const name = blocked[0] === d.taskId && d.taskTitle ? d.taskTitle : blocked[0];
  return `Saved — ${name} will resume`;
}

function onAnswered(d, outcome) {
  state.submission = null;
  state.notice = null;
  state.drafts.delete(d.id);
  removeDecision(d.id);
  state.focusNextCard = true;
  renderInbox(true);
  toast(outcome === 'duplicate' ? 'Already saved' : savedMessage(d));
  loadDecisions();
  loadOverview();
}

function replaceDecision(fresh) {
  if (fresh.status && fresh.status !== 'pending') {
    removeDecision(fresh.id);
    return;
  }
  state.decisions = state.decisions.map((d) => (d.id === fresh.id ? fresh : d));
  state.decisionsSeq++;
}

function removeDecision(id) {
  state.decisions = state.decisions.filter((d) => d.id !== id);
  if (state.currentId === id) state.currentId = null;
  state.decisionsSeq++;
  updateBadge();
}

async function deferDecision(d) {
  if (isBusy(d)) return;
  state.deferringId = d.id;
  updateCardControls();
  let r;
  try {
    r = await api('POST', `/api/decisions/${encodeURIComponent(d.id)}/defer`, { hours: DEFER_HOURS });
  } catch {
    state.deferringId = null;
    renderInbox(true);
    toast('Could not reach Autopilot. The card is still here.');
    return;
  }
  state.deferringId = null;
  const data = r.data || {};
  if (r.status === 200 && data.decision) {
    replaceDecision(data.decision);
    state.decisions = sortPending(state.decisions);
    state.currentId = null;
    state.showSnoozed = false;
    state.notice = null;
    state.focusNextCard = true;
    renderInbox(true);
    toast(`Snoozed for ${DEFER_HOURS} hours`);
  } else if (r.status === 409 || r.status === 404) {
    removeDecision(d.id);
    renderInbox(true);
    toast('That card was already answered or closed.');
  } else if (r.status !== 401) {
    renderInbox(true);
    toast(data.error ? `Could not snooze: ${data.error}` : 'Could not snooze this card.');
  }
}

// ------------------------------------------------------------------ swipe

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Horizontal drag with Pointer Events. Right past the threshold accepts the
 * recommendation when that is allowed; left snoozes. Vertical movement is left
 * to the browser (touch-action: pan-y) so the page still scrolls.
 */
function attachSwipe(refs, d, acceptOption) {
  const card = refs.root;
  let tracking = false;
  let dragging = false;
  let pointerId = null;
  let startX = 0;
  let startY = 0;
  let dx = 0;
  let swallowClick = false;

  card.addEventListener('pointerdown', (event) => {
    swallowClick = false;
    if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
    if (event.target.closest('textarea, input, select, a, label')) return;
    if (isBusy(d)) return;
    tracking = true;
    dragging = false;
    pointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    dx = 0;
  });

  card.addEventListener('pointermove', (event) => {
    if (!tracking || event.pointerId !== pointerId) return;
    const mx = event.clientX - startX;
    const my = event.clientY - startY;
    if (!dragging) {
      if (Math.abs(my) > DRAG_SLOP && Math.abs(my) > Math.abs(mx)) {
        tracking = false; // a vertical scroll, not a swipe
        return;
      }
      if (Math.abs(mx) < DRAG_SLOP) return;
      dragging = true;
      try {
        card.setPointerCapture(pointerId);
      } catch {
        // capture is an optimisation only
      }
      card.classList.add('dragging');
    }
    dx = mx;
    card.style.transform = `translateX(${dx}px) rotate(${dx / 40}deg)`;
    showOverlay(refs.overlay, dx, acceptOption);
  });

  const finish = (event, cancelled) => {
    if (!tracking || event.pointerId !== pointerId) return;
    tracking = false;
    if (!dragging) return;
    dragging = false;
    swallowClick = true; // the click that follows a drag must not press a button
    card.classList.remove('dragging');
    if (!cancelled && dx > SWIPE_THRESHOLD) {
      if (acceptOption) {
        flyOut(card, 1).then(() => submit(d, acceptOption.id, normalizeComment(draftFor(d).comment), true));
      } else {
        snapBack(refs);
        toast('Tap to choose');
      }
    } else if (!cancelled && dx < -SWIPE_THRESHOLD) {
      flyOut(card, -1).then(() => deferDecision(d));
    } else {
      snapBack(refs);
    }
  };
  card.addEventListener('pointerup', (event) => finish(event, false));
  card.addEventListener('pointercancel', (event) => finish(event, true));
  card.addEventListener('click', (event) => {
    if (!swallowClick) return;
    swallowClick = false;
    event.preventDefault();
    event.stopPropagation();
  }, true);
}

function showOverlay(overlay, dx, acceptOption) {
  if (dx > 0) {
    overlay.textContent = acceptOption ? `Accept: ${acceptOption.label}` : 'Tap to choose';
    overlay.className = `swipe-overlay ${acceptOption ? 'accept' : 'blocked'}`;
  } else {
    overlay.textContent = `Later (${DEFER_HOURS}h)`;
    overlay.className = 'swipe-overlay later';
  }
  overlay.style.opacity = String(Math.min(1, Math.abs(dx) / SWIPE_THRESHOLD));
}

function snapBack(refs) {
  refs.root.classList.remove('dragging');
  refs.root.style.transform = '';
  refs.overlay.style.opacity = '0';
}

function flyOut(card, direction) {
  if (reducedMotion()) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    card.classList.add('flying');
    card.style.transform = `translateX(${direction * (window.innerWidth + 120)}px) rotate(${direction * 14}deg)`;
    card.addEventListener('transitionend', finish, { once: true });
    setTimeout(finish, 450);
  });
}

// ----------------------------------------------------------------- digest

function renderDigest() {
  if (state.tab !== 'digest') return;
  const d = state.digest;
  if (!d) {
    replace(els.digestBody, h('p', { class: 'muted center' }, state.offline ? 'Offline. The digest loads when Autopilot is reachable.' : 'Loading…'));
    return;
  }
  const counts = d.counts || {};
  const blocks = [
    h('p', { class: 'digest-summary' },
      [
        `${counts.integrated || 0} integrated`,
        plural(counts.failures || 0, 'problem'),
        plural(counts.answered || 0, 'answer'),
        `${plural(counts.pendingDecisions || 0, 'card')} waiting`,
      ].join(' · '),
    ),
    d.truncated ? h('p', { class: 'muted small' }, 'A busy day: only the most recent activity is listed and counted.') : null,
  ];
  const eventItem = (e) =>
    h('li', { class: 'digest-item' }, h('span', {}, e.message), h('span', { class: 'muted small', dataset: { ago: String(e.at) } }, ago(e.at)));
  const list = (title, items) => h('section', { class: 'panel' }, h('h3', { class: 'panel-title' }, title), h('ul', { class: 'digest-list' }, items));

  if (d.integrated.length) {
    blocks.push(list('Integrated', d.integrated.map((item) =>
      h('li', { class: 'digest-item' },
        externalLink(item.title, item.prUrl),
        h('span', { class: 'muted small' }, `${item.taskId} · `, h('span', { dataset: { ago: String(item.at) } }, ago(item.at))),
      ))));
  }
  if (d.failures.length) blocks.push(list('Problems', d.failures.map(eventItem)));
  if (d.answered.length) blocks.push(list('Your answers', d.answered.map(eventItem)));
  if (d.usage.length) blocks.push(list('Usage limits', d.usage.map(eventItem)));
  if (!d.integrated.length && !d.failures.length && !d.answered.length && !d.usage.length) {
    blocks.push(h('div', { class: 'empty-state' },
      h('p', { class: 'empty-title' }, 'A quiet day'),
      h('p', { class: 'muted' }, 'Nothing was integrated, failed, answered or paused in the last 24 hours.'),
    ));
  }
  replace(els.digestBody, blocks);
}

// ------------------------------------------------------------------ board

function renderBoard() {
  if (state.tab !== 'board') return;
  if (!state.tasksLoaded) {
    replace(els.boardBody, h('p', { class: 'muted center' }, state.offline ? 'Offline. Tasks load when Autopilot is reachable.' : 'Loading tasks…'));
    return;
  }
  if (!state.tasks.length) {
    replace(els.boardBody, h('div', { class: 'empty-state' },
      h('p', { class: 'empty-title' }, 'No tasks yet'),
      h('p', { class: 'muted' }, 'The planner adds tasks from your documents, or you can add one above.'),
    ));
    return;
  }
  const groups = new Map();
  for (const t of state.tasks) {
    if (!groups.has(t.state)) groups.set(t.state, []);
    groups.get(t.state).push(t);
  }
  const order = [...STATE_ORDER, ...[...groups.keys()].filter((s) => !STATE_ORDER.includes(s))];
  const sections = order.filter((s) => groups.has(s)).map((s) => {
    const open = state.boardOpen.has(s) ? state.boardOpen.get(s) : !COLLAPSED_STATES.has(s);
    const details = h('details', { class: 'group', open },
      h('summary', { dataset: { key: `group-${s}` } }, h('span', {}, STATE_LABELS[s] || s), h('span', { class: 'count' }, String(groups.get(s).length))),
      h('ul', { class: 'task-list' }, groups.get(s).map(taskRow)),
    );
    details.addEventListener('toggle', () => state.boardOpen.set(s, details.open));
    return details;
  });
  preserveFocus(els.boardBody, () => replace(els.boardBody, sections));
}

function taskRow(t) {
  const meta = [`P${t.priority}`, t.kind];
  if (t.risk && t.risk !== 'unknown') meta.push(`${t.risk} risk`);
  if (t.attempts) meta.push(plural(t.attempts, 'attempt'));
  if (!state.project) meta.push(projectName(t.projectId));
  return h('li', {},
    h('button', { type: 'button', class: 'task-row', dataset: { key: `task-${t.id}` }, onclick: () => openTask(t.id) },
      h('span', { class: 'task-top' }, h('span', { class: 'task-id' }, t.id), h('span', { class: 'task-title' }, t.title)),
      t.stateReason ? h('span', { class: 'task-reason' }, t.stateReason) : null,
      h('span', { class: 'task-meta' }, meta.join(' · ')),
    ),
  );
}

function syncTaskProjectSelect() {
  const projects = (state.overview && state.overview.projects) || [];
  const wanted = els.taskProject.value || state.project;
  replace(els.taskProject, projects.map((p) => h('option', { value: p.id }, p.name)));
  if (projects.some((p) => p.id === wanted)) els.taskProject.value = wanted;
}

function taskFormError(message) {
  els.taskFormError.textContent = message;
  els.taskFormError.hidden = !message;
}

async function onAddTask(event) {
  event.preventDefault();
  const projectId = els.taskProject.value;
  const title = els.taskTitle.value.trim();
  const objective = els.taskObjective.value.trim();
  const acceptanceCriteria = els.taskCriteria.value.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!projectId || !title || !objective) {
    taskFormError('Project, title and objective are required.');
    return;
  }
  const button = els.addTaskForm.querySelector('button[type="submit"]');
  button.disabled = true;
  let r;
  try {
    r = await api('POST', '/api/tasks', { projectId, title, objective, acceptanceCriteria });
  } catch {
    taskFormError('Could not reach Autopilot.');
    button.disabled = false;
    return;
  }
  button.disabled = false;
  if (r.status === 200 && r.data && r.data.task) {
    els.addTaskForm.reset();
    taskFormError('');
    els.addTask.open = false;
    toast(`Added ${r.data.task.id}`);
    loadTasks();
    loadOverview();
  } else if (r.status !== 401) {
    taskFormError((r.data && r.data.error) || 'Could not add the task.');
  }
}

// ------------------------------------------------------------ task detail

async function openTask(id) {
  state.detailTaskId = id;
  els.sheetTitle.textContent = id;
  replace(els.sheetBody, h('p', { class: 'muted' }, 'Loading…'));
  if (!els.sheet.open) {
    if (typeof els.sheet.showModal === 'function') els.sheet.showModal();
    else els.sheet.setAttribute('open', '');
  }
  let r;
  try {
    r = await api('GET', `/api/tasks/${encodeURIComponent(id)}`);
  } catch {
    if (state.detailTaskId === id) replace(els.sheetBody, h('p', { class: 'form-error' }, 'Could not reach Autopilot.'));
    return;
  }
  if (state.detailTaskId !== id) return;
  if (r.status !== 200 || !r.data) {
    replace(els.sheetBody, h('p', { class: 'form-error' }, r.status === 404 ? 'This task no longer exists.' : 'Could not load this task.'));
    return;
  }
  renderTaskDetail(r.data);
}

function renderTaskDetail(data) {
  const t = data.task;
  els.sheetTitle.textContent = `${t.id} · ${t.title}`;
  const meta = [`Priority ${t.priority}`, t.kind, `${t.risk} risk`, plural(t.attempts, 'attempt'), plural(t.repairCycles, 'repair cycle')];
  if (t.branch) meta.push(t.branch);
  const actions = [];
  if (t.state === 'exhausted') actions.push(h('button', { type: 'button', class: 'btn btn-primary', onclick: () => taskAction(t.id, 'retry') }, 'Retry'));
  if (!FINAL_STATES.has(t.state)) actions.push(h('button', { type: 'button', class: 'btn btn-danger', onclick: () => taskAction(t.id, 'cancel') }, 'Cancel task'));

  replace(els.sheetBody,
    h('p', { class: 'detail-state' }, chip(STATE_LABELS[t.state] || t.state, tone(t.state)), t.stateReason ? h('span', {}, t.stateReason) : null),
    h('p', { class: 'muted small' }, meta.join(' · ')),
    t.prUrl && safeHref(t.prUrl) ? h('p', {}, externalLink(t.prNumber ? `Pull request #${t.prNumber}` : 'Pull request', t.prUrl)) : null,
    actions.length ? h('div', { class: 'detail-actions' }, actions) : null,
    section('Objective', h('p', { class: 'prewrap' }, t.objective)),
    t.headCommit
      ? section('Changes', h('div', {},
          h('button', { type: 'button', class: 'btn btn-secondary', onclick: (ev) => loadDiff(t.id, ev.currentTarget.parentElement) }, 'Show the code changes')))
      : null,
    t.acceptanceCriteria && t.acceptanceCriteria.length
      ? section('Acceptance criteria', h('ul', { class: 'bullets' }, t.acceptanceCriteria.map((c) => h('li', {}, c))))
      : null,
    t.hypothesis ? section('Hypothesis', h('p', {}, t.hypothesis)) : null,
    section('Runs', data.runs.length ? h('ul', { class: 'detail-list' }, data.runs.map(runItem)) : h('p', { class: 'muted' }, 'No runs yet.')),
    section('Checks', checksBlock(data.checks, t.headCommit)),
    section('Review', data.review ? reviewBlock(data.review, t.headCommit) : h('p', { class: 'muted' }, 'Not reviewed yet.')),
    data.decisions.length
      ? section('Decisions', h('ul', { class: 'detail-list' }, data.decisions.map((d) =>
          h('li', {}, chip(d.status, tone(d.status)), ' ', d.question))))
      : null,
    section('Recent activity', data.events.length
      ? h('ul', { class: 'detail-list events' }, data.events.map((e) =>
          h('li', {}, h('span', { class: 'muted small' }, ago(e.at)), ' ', e.message)))
      : h('p', { class: 'muted' }, 'Nothing yet.')),
  );
}

function resumeCommand(sessionId) {
  return typeof sessionId === 'string' && SESSION_ID_RE.test(sessionId) ? `claude --resume ${sessionId}` : null;
}

function resumeLine(sessionId, cwd) {
  const command = resumeCommand(sessionId);
  if (!command) return null;
  return h('div', { class: 'resume' },
    h('code', {}, command),
    h('button', { type: 'button', class: 'btn btn-small btn-secondary', onclick: () => copyText(command) }, 'Copy'),
    cwd ? h('p', { class: 'muted small resume-cwd' }, `Run it in ${cwd}`) : null,
  );
}

function runItem(run) {
  return h('li', { class: 'run' },
    h('div', { class: 'run-head' },
      h('strong', {}, `${run.id} ${run.role}`),
      chip(run.status, tone(run.status)),
      h('span', { class: 'muted small' }, ago(run.startedAt)),
    ),
    run.resultSummary ? h('p', { class: 'small prewrap' }, run.resultSummary) : null,
    run.error ? h('p', { class: 'small error-text prewrap' }, run.error) : null,
    resumeLine(run.sessionId, run.cwd),
  );
}

function checksBlock(checks, head) {
  const rows = [];
  for (const [scope, list] of [['branch', checks.branch], ['integration', checks.integration]]) {
    for (const c of list || []) {
      rows.push(h('li', { class: 'check' },
        h('div', { class: 'run-head' }, chip(c.status, tone(c.status)), h('strong', {}, c.name), h('span', { class: 'muted small' }, `${scope} · ${duration(c.durationMs)}`)),
        c.status !== 'passed' && c.outputTail ? h('details', {}, h('summary', {}, 'Output'), h('pre', { class: 'output' }, c.outputTail)) : null,
      ));
    }
  }
  if (!rows.length) return h('p', { class: 'muted' }, head ? 'No checks recorded for the latest commit.' : 'No commit yet.');
  return h('ul', { class: 'detail-list' }, rows);
}

function reviewBlock(review, head) {
  const meta = [`${review.risk} risk`, ago(review.at)];
  if (head && review.headCommit !== head) meta.push('for an earlier commit');
  return h('div', { class: 'review' },
    h('p', { class: 'run-head' }, chip(VERDICT_LABELS[review.verdict] || review.verdict, tone(review.verdict)), h('span', { class: 'muted small' }, meta.join(' · '))),
    review.summary ? h('p', { class: 'prewrap' }, review.summary) : null,
    review.findings && review.findings.length
      ? h('ul', { class: 'detail-list' }, review.findings.map((f) =>
          h('li', {},
            chip(f.severity, tone(f.severity)), ' ',
            f.file ? h('code', {}, f.line ? `${f.file}:${f.line}` : f.file) : null, ' ',
            f.issue,
            f.suggestion ? h('p', { class: 'muted small' }, f.suggestion) : null,
          )))
      : null,
  );
}

async function taskAction(id, action) {
  if (action === 'cancel' && !confirm(`Cancel ${id}? Any running work on it stops and it will not be retried.`)) return;
  let r;
  try {
    r = await api('POST', `/api/tasks/${encodeURIComponent(id)}/${action}`, {});
  } catch {
    toast('Could not reach Autopilot.');
    return;
  }
  if (r.status === 200) {
    toast(action === 'retry' ? `${id} is queued again` : `${id} cancelled`);
    openTask(id);
    loadTasks();
    loadOverview();
  } else if (r.status !== 401) {
    toast((r.data && r.data.error) || `Could not ${action} ${id}.`);
  }
}

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      toast('Copied');
      return;
    }
  } catch {
    // fall back below
  }
  const buffer = h('textarea', { class: 'copy-buffer', readonly: true, 'aria-hidden': 'true' });
  buffer.value = text;
  (els.sheet.open ? els.sheet : document.body).append(buffer);
  buffer.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  buffer.remove();
  toast(copied ? 'Copied' : 'Copy failed: select the command and copy it by hand');
}

// ----------------------------------------------------------------- status

function renderStatus() {
  if (state.tab !== 'status') return;
  const o = state.overview;
  if (!o) {
    replace(els.statusBody, h('p', { class: 'muted center' }, state.offline ? 'Offline. Status loads when Autopilot is reachable.' : 'Loading…'));
    return;
  }
  const now = serverNow();
  const projects = (o.projects || []).filter((p) => !state.project || p.id === state.project);
  const runs = (o.activeRuns || []).filter((r) => !state.project || r.projectId === state.project);
  const blocks = [
    h('section', { class: 'panel' },
      h('div', { class: 'row' },
        h('div', {},
          h('h3', { class: 'panel-title' }, 'Autopilot'),
          h('p', { class: o.pausedAll ? 'warn' : 'muted' }, o.pausedAll ? 'Everything is paused. Nothing new starts.' : 'Running.'),
        ),
        h('button', {
          type: 'button',
          class: o.pausedAll ? 'btn btn-primary' : 'btn btn-danger',
          dataset: { key: 'pause-all' },
          onclick: () => setPause('all', !o.pausedAll),
        }, o.pausedAll ? 'Resume' : 'Pause all'),
      ),
    ),
  ];
  if (o.usagePausedUntil && o.usagePausedUntil > now) {
    blocks.push(h('section', { class: 'panel warn-panel' },
      h('h3', { class: 'panel-title' }, 'Usage limit reached'),
      h('p', {}, 'New runs start again in ', h('strong', { dataset: { until: String(o.usagePausedUntil) } }, duration(o.usagePausedUntil - now)),
        ` (${clockTime(o.usagePausedUntil)}).`),
    ));
  }
  blocks.push(h('section', { class: 'panel' },
    h('h3', { class: 'panel-title' }, 'Projects'),
    projects.length ? h('ul', { class: 'project-list' }, projects.map(projectRow)) : h('p', { class: 'muted' }, 'No projects yet.'),
  ));
  blocks.push(h('section', { class: 'panel' },
    h('h3', { class: 'panel-title' }, `Active runs (${runs.length})`),
    runs.length ? h('ul', { class: 'detail-list' }, runs.map(activeRunRow)) : h('p', { class: 'muted' }, 'No workers running.'),
  ));
  blocks.push(h('section', { class: 'panel' },
    h('h3', { class: 'panel-title' }, 'Notifications'),
    notificationsPanel(),
  ));
  blocks.push(h('section', { class: 'panel' },
    h('h3', { class: 'panel-title' }, 'This phone'),
    h('button', { type: 'button', class: 'btn btn-secondary', dataset: { key: 'logout' }, onclick: logout }, 'Sign out'),
  ));
  preserveFocus(els.statusBody, () => replace(els.statusBody, blocks));
}

function projectRow(p) {
  const counts = p.counts || {};
  const open = STATE_ORDER.filter((s) => counts[s] && !FINAL_STATES.has(s)).map((s) => `${counts[s]} ${(STATE_LABELS[s] || s).toLowerCase()}`);
  return h('li', { class: 'project-row' },
    h('div', { class: 'project-info' },
      h('span', { class: 'project-name' }, p.name),
      h('span', { class: 'muted small' }, `${PROFILE_LABELS[p.profile] || p.profile || 'Unknown profile'} · ${plural(p.pendingDecisions || 0, 'card')} waiting`),
      h('span', { class: 'small' }, open.length ? open.join(' · ') : 'No open tasks'),
      p.paused ? h('span', { class: 'warn small' }, p.pauseReason ? `Paused: ${p.pauseReason}` : 'Paused') : null,
    ),
    h('button', {
      type: 'button',
      role: 'switch',
      class: 'switch',
      'aria-checked': String(!p.paused),
      'aria-label': `${p.name} running`,
      dataset: { key: `pause-${p.id}` },
      onclick: () => setPause(p.id, !p.paused),
    }, h('span', { class: 'switch-text', 'aria-hidden': 'true' }, p.paused ? 'Paused' : 'On')),
  );
}

function activeRunRow(r) {
  const now = serverNow();
  const stale = now - r.heartbeatAt > STALE_HEARTBEAT_MS;
  return h('li', { class: 'run' },
    h('div', { class: 'run-head' },
      chip(r.role, 'info'),
      h('strong', {}, r.taskId ? `${r.taskId}${r.taskTitle ? ` · ${r.taskTitle}` : ''}` : projectName(r.projectId)),
    ),
    h('p', { class: 'small muted' },
      'Running for ', h('span', { dataset: { since: String(r.startedAt) } }, duration(now - r.startedAt)),
      ' · heartbeat ', h('span', { class: stale ? 'warn' : '', dataset: { age: String(r.heartbeatAt) } }, `${duration(now - r.heartbeatAt)} ago`),
    ),
    resumeLine(r.sessionId, null),
  );
}

async function setPause(scope, paused) {
  if (scope === 'all' && !confirm(paused ? 'Pause all projects? No new work starts until you resume.' : 'Resume all projects?')) return;
  let r;
  try {
    r = await api('POST', '/api/pause', { scope, paused });
  } catch {
    toast('Could not reach Autopilot.');
    return;
  }
  if (r.status === 200) {
    toast(paused ? 'Paused' : 'Resumed');
    await loadOverview();
  } else if (r.status !== 401) {
    toast((r.data && r.data.error) || 'Could not change the pause setting.');
  }
}

// --------------------------------------------------------- service worker

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  navigator.serviceWorker.register('/sw.js').catch(() => {
    // the offline shell is a convenience; the inbox works without it
  });
}

boot();
