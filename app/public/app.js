const state = {
  accessToken: null,
  refreshToken: null,
  user: null,
  org: null,
  charts: {},
  view: null,
  openExpenseId: null,
  poll: null
};
const AUTH_KEY = 'ems_auth';

// ---------- Auth persistence ----------
function persistAuth() {
  localStorage.setItem(
    AUTH_KEY,
    JSON.stringify({
      accessToken: state.accessToken,
      refreshToken: state.refreshToken,
      user: state.user,
      org: state.org
    })
  );
}
function loadAuth() {
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    if (!raw) return false;
    const a = JSON.parse(raw);
    if (!a.accessToken || !a.user) return false;
    state.accessToken = a.accessToken;
    state.refreshToken = a.refreshToken;
    state.user = a.user;
    state.org = a.org || null;
    return true;
  } catch {
    return false;
  }
}
function clearAuth() {
  state.accessToken = state.refreshToken = state.user = state.org = null;
  localStorage.removeItem(AUTH_KEY);
}

// ---------- API (with silent refresh-token retry) ----------
let refreshPromise = null;
function tryRefresh() {
  // Single in-flight refresh so concurrent 401s don't trip reuse-detection.
  if (!refreshPromise) {
    refreshPromise = (async () => {
      try {
        if (!state.refreshToken) return false;
        const res = await fetch('/auth/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: state.refreshToken })
        });
        if (!res.ok) return false;
        const d = await res.json();
        state.accessToken = d.accessToken;
        state.refreshToken = d.refreshToken;
        if (d.user) state.user = d.user;
        if (d.organization) state.org = d.organization;
        persistAuth();
        return true;
      } catch {
        return false;
      } finally {
        setTimeout(() => (refreshPromise = null), 0);
      }
    })();
  }
  return refreshPromise;
}

async function api(path, opts = {}, _retried = false) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const isAuthRoute = path.startsWith('/auth/');
  if (state.accessToken && !isAuthRoute) headers.Authorization = `Bearer ${state.accessToken}`;
  const res = await fetch(path, { ...opts, headers });

  if (res.status === 401 && !isAuthRoute && !_retried && state.refreshToken) {
    const ok = await tryRefresh();
    if (ok) return api(path, opts, true);
    sessionExpired();
    throw new Error('Session expired');
  }

  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(errMessage(data, res.status));
  return data;
}

// Build a readable message, surfacing zod field errors (e.g. invalid email).
function errMessage(data, status) {
  const e = data?.error;
  if (!e) return `HTTP ${status}`;
  const fe = e.details?.fieldErrors;
  if (fe && typeof fe === 'object') {
    const parts = Object.entries(fe)
      .filter(([, v]) => Array.isArray(v) && v.length)
      .map(([k, v]) => `${k}: ${v[0]}`);
    if (parts.length) return parts.join(' · ');
  }
  return e.message || `HTTP ${status}`;
}

function sessionExpired() {
  clearAuth();
  stopPolling();
  document.getElementById('app').classList.add('hidden');
  document.getElementById('login').classList.remove('hidden');
  document.getElementById('loginErr').textContent = 'Session expired — please sign in again.';
}

let toastTimer = null;
function toast(msg, type = 'info') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  t.classList.toggle('error', type === 'error');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), type === 'error' ? 5000 : 2800);
}
const toastErr = (msg) => toast(msg, 'error');

// Supported currencies (must match the backend FX table in currency.ts).
const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD'];
const curOptions = (sel) =>
  CURRENCIES.map((c) => `<option ${c === sel ? 'selected' : ''}>${c}</option>`).join('');
// The org's base/reporting currency (every expense's base_amount is in it).
const orgCur = () => (state.org && state.org.base_currency) || 'INR';
function fmt(n, cur) {
  const currency = cur || orgCur();
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: 2
    }).format(Number(n || 0));
  } catch {
    return `${currency} ${Number(n || 0).toLocaleString()}`;
  }
}
const pill = (s) => `<span class="pill ${s}">${s.replace('_', ' ')}</span>`;
const isValidEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
function fmtBytes(n) {
  const b = Number(n || 0);
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}
// Fetch a protected binary (bill) with the auth header and return an object URL.
async function authBlobUrl(path) {
  const res = await fetch(path, {
    headers: state.accessToken ? { Authorization: `Bearer ${state.accessToken}` } : {}
  });
  if (!res.ok) throw new Error('Could not load file');
  return URL.createObjectURL(await res.blob());
}

// ---------- Auth flows ----------
function enterApp() {
  document.getElementById('login').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  document.getElementById('whoami').textContent = `${state.user.name} · ${state.user.role}`;
  buildNav();
  startPolling();
}

async function login(email, password) {
  const data = await api('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password })
  });
  state.accessToken = data.accessToken;
  state.refreshToken = data.refreshToken;
  state.user = data.user;
  state.org = data.organization || null;
  persistAuth();
  enterApp();
  go('expenses');
  refreshNotifs();
}

async function signup() {
  const data = await api('/auth/signup', {
    method: 'POST',
    body: JSON.stringify({
      orgName: document.getElementById('suOrg').value,
      adminName: document.getElementById('suName').value,
      email: document.getElementById('suEmail').value,
      password: document.getElementById('suPass').value,
      baseCurrency: document.getElementById('suCur').value
    })
  });
  state.accessToken = data.accessToken;
  state.refreshToken = data.refreshToken;
  state.user = data.user;
  state.org = data.organization || null;
  persistAuth();
  enterApp();
  go('users');
  refreshNotifs();
  toast(`Organization "${data.organization.name}" created`);
}

async function logout() {
  try {
    if (state.refreshToken) {
      await fetch('/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: state.refreshToken })
      });
    }
  } catch {
    /* ignore */
  }
  clearAuth();
  stopPolling();
  document.getElementById('app').classList.add('hidden');
  document.getElementById('login').classList.remove('hidden');
}

// ---------- Nav ----------
const can = (perms) => perms.includes(state.user.role);
function buildNav() {
  const items = [
    { id: 'expenses', label: 'My Expenses', roles: ['employee', 'manager', 'finance', 'admin'] },
    { id: 'approvals', label: 'Approvals', roles: ['manager', 'finance', 'admin'] },
    { id: 'dashboard', label: 'Dashboard', roles: ['manager', 'finance', 'admin'] },
    { id: 'policies', label: 'Policies', roles: ['finance', 'admin'] },
    { id: 'budgets', label: 'Budgets', roles: ['admin'] },
    { id: 'users', label: 'Users', roles: ['admin'] }
  ];
  const nav = document.getElementById('nav');
  nav.innerHTML = '';
  items.filter((i) => can(i.roles)).forEach((i) => {
    const b = document.createElement('button');
    b.textContent = i.label;
    b.dataset.view = i.id;
    b.onclick = () => go(i.id);
    nav.appendChild(b);
  });
}

function go(view) {
  if (view !== 'expenses') state.openExpenseId = null;
  state.view = view;
  document.querySelectorAll('#nav button').forEach((b) =>
    b.classList.toggle('active', b.dataset.view === view)
  );
  ({
    expenses: viewExpenses,
    approvals: viewApprovals,
    dashboard: viewDashboard,
    policies: viewPolicies,
    budgets: viewBudgets,
    users: viewUsers
  }[view])();
}

// ---------- Categories ----------
async function loadCategories() {
  try {
    state.categories = await api('/categories');
  } catch {
    state.categories = state.categories || [];
  }
  return state.categories || [];
}

function categoryOptions(selected) {
  const cats = state.categories || [];
  let opts = cats.map((c) => `<option ${c.name === selected ? 'selected' : ''}>${c.name}</option>`).join('');
  // Keep legacy/foreign values selectable so existing drafts still display.
  if (selected && !cats.some((c) => c.name === selected)) {
    opts = `<option selected>${selected}</option>` + opts;
  }
  return opts || '<option value="">No categories yet — add one under Policies</option>';
}

// ---------- Expenses ----------
async function viewExpenses() {
  await loadCategories();
  const v = document.getElementById('view');
  v.innerHTML = `
    <div class="panel">
      <h3>Create expense</h3>
      <p class="muted small">Create a draft, then submit it to start the approval flow.</p>
      <div class="form-grid">
        <div class="field">
          <label for="ftype">Expense type</label>
          <select id="ftype">
            <option value="reimbursement">Reimbursement — you paid, company pays you back</option>
            <option value="company_paid">Company paid — billed directly to the company</option>
          </select>
        </div>
        <div class="field">
          <label for="fcat">Category</label>
          <select id="fcat">${categoryOptions()}</select>
        </div>
        <div class="field">
          <label for="famount">Amount</label>
          <input id="famount" type="number" min="0" step="0.01" placeholder="e.g. 2500" />
        </div>
        <div class="field">
          <label for="fcur">Currency</label>
          <select id="fcur">${curOptions(orgCur())}</select>
        </div>
      </div>
      <div class="field">
        <label for="fdesc">Description</label>
        <input id="fdesc" placeholder="What was this expense for? (e.g. Client dinner, Mumbai)" />
      </div>
      <div class="field">
        <label for="fbill">Bill / receipt <span class="muted small">(optional — image or PDF, max 5MB)</span></label>
        <input id="fbill" type="file" accept="image/png,image/jpeg,image/webp,image/gif,application/pdf" />
      </div>
      <p id="expErr" class="form-err"></p>
      <button class="primary" id="createBtn">Create draft</button>
    </div>
    <div class="panel">
      <div class="row between"><h3>My expenses</h3><button id="refreshExp" class="ghost small">↻ Refresh</button></div>
      <div class="filter-bar">
        <select id="expFilter">
          <option value="all">All statuses</option>
          <option value="draft">Draft</option>
          <option value="in_review">In review</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
          <option value="withdrawn">Withdrawn</option>
        </select>
        <input id="expSearch" placeholder="Search category or description…" />
        <span id="expCount" class="muted small"></span>
      </div>
      <div class="table-scroll">
        <table><thead><tr><th>Type</th><th>Category</th><th>Amount</th><th>Status</th><th></th></tr></thead>
        <tbody id="expBody"></tbody></table>
      </div>
    </div>
    <div id="detail"></div>`;
  document.getElementById('createBtn').onclick = createExpense;
  document.getElementById('refreshExp').onclick = () => {
    loadExpenseList();
    if (state.openExpenseId) showDetail(state.openExpenseId);
  };
  const filterEl = document.getElementById('expFilter');
  filterEl.value = state.expFilter || 'all';
  filterEl.onchange = (e) => {
    state.expFilter = e.target.value;
    renderExpenseRows();
  };
  const searchEl = document.getElementById('expSearch');
  searchEl.value = state.expSearch || '';
  searchEl.oninput = (e) => {
    state.expSearch = e.target.value;
    renderExpenseRows();
  };
  await loadExpenseList();
  if (state.openExpenseId) await showDetail(state.openExpenseId);
}

async function loadExpenseList() {
  const body = document.getElementById('expBody');
  if (!body) return;
  state.expAll = await api('/expenses?scope=mine&limit=200');
  renderExpenseRows();
}

function renderExpenseRows() {
  const body = document.getElementById('expBody');
  if (!body) return;
  const all = state.expAll || [];
  const f = state.expFilter || 'all';
  const q = (state.expSearch || '').trim().toLowerCase();
  let list = all;
  if (f !== 'all') list = list.filter((e) => e.status === f);
  if (q)
    list = list.filter(
      (e) =>
        (e.category || '').toLowerCase().includes(q) ||
        (e.description || '').toLowerCase().includes(q)
    );
  body.innerHTML = list.map(rowExpense).join('') || emptyRow(5);
  body.querySelectorAll('[data-exp]').forEach((b) => (b.onclick = () => showDetail(b.dataset.exp)));
  const count = document.getElementById('expCount');
  if (count) {
    count.textContent =
      list.length === all.length ? `${all.length} total` : `${list.length} of ${all.length}`;
  }
}

function rowExpense(e) {
  return `<tr${e.id === state.openExpenseId ? ' class="sel"' : ''}>
    <td>${e.type.replace('_', ' ')}</td><td>${e.category}</td>
    <td>${fmt(e.base_amount)} ${e.currency !== orgCur() ? `<span class="muted small">(${e.amount} ${e.currency})</span>` : ''}</td>
    <td>${pill(e.status)}</td>
    <td><button data-exp="${e.id}">View</button></td></tr>`;
}
const emptyRow = (n) => `<tr><td colspan="${n}" class="muted">No records</td></tr>`;

async function createExpense() {
  const err = document.getElementById('expErr');
  err.textContent = '';
  const category = document.getElementById('fcat').value;
  const amount = Number(document.getElementById('famount').value);
  if (!category) {
    err.textContent = 'Pick a category. An admin can add categories under Policies.';
    return;
  }
  if (!(amount > 0)) {
    err.textContent = 'Amount must be greater than 0.';
    return;
  }
  try {
    const fileInput = document.getElementById('fbill');
    const file = fileInput && fileInput.files && fileInput.files[0];
    const created = await api('/expenses', {
      method: 'POST',
      body: JSON.stringify({
        type: document.getElementById('ftype').value,
        category,
        amount,
        currency: document.getElementById('fcur').value,
        description: document.getElementById('fdesc').value
      })
    });
    // Attach the bill straight away (at creation, not buried in the detail view).
    if (file) {
      try {
        await postBill(created.id, file);
      } catch (be) {
        toastErr(`Draft created, but bill upload failed: ${be.message}`);
      }
    }
    toast(file ? 'Draft created with bill attached' : 'Draft created');
    document.getElementById('famount').value = '';
    document.getElementById('fdesc').value = '';
    if (fileInput) fileInput.value = '';
    loadExpenseList();
  } catch (e) {
    err.textContent = e.message;
  }
}

// Upload a bill (multipart) to an expense; shared by the create form and the
// detail "Bills" tab so both go through the same validation/error handling.
async function postBill(expenseId, file) {
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch(`/expenses/${expenseId}/attachments`, {
    method: 'POST',
    headers: state.accessToken ? { Authorization: `Bearer ${state.accessToken}` } : {},
    body: fd
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(errMessage(data, res.status));
  return data;
}

async function showDetail(id) {
  state.openExpenseId = id;
  const e = await api(`/expenses/${id}`);
  const hist = await api(`/expenses/${id}/history`);
  const bills = await api(`/expenses/${id}/attachments`).catch(() => []);
  const d = document.getElementById('detail');
  if (!d) return;
  const tab = state.detailTab || 'chain';
  const editable = ['draft', 'submitted', 'in_review'].includes(e.status);
  const isOwner = !!(state.user && e.requester_id === state.user.id);
  const canUpload = isOwner && editable;
  const actions = [];
  if (e.status === 'draft') actions.push(`<button class="green" onclick="doSubmit('${id}')">Submit</button>`);
  if (editable) actions.push(`<button onclick="toggleEdit('${id}')">Edit</button>`);
  if (editable) actions.push(`<button class="red" onclick="act('${id}','withdraw')">Withdraw</button>`);

  // Approval chain with the current stage clearly marked (only one stage is
  // active at a time; later stages are "upcoming").
  const chainHtml =
    e.steps
      .map((s) => {
        let label = s.status;
        let cls = s.status;
        if (e.status === 'in_review') {
          if (s.level === e.current_level) {
            label = 'awaiting approval';
            cls = 'current';
          } else if (s.level > e.current_level && s.status === 'pending') {
            label = 'upcoming';
            cls = 'upcoming';
          }
        }
        const pillCls = cls === 'current' || cls === 'upcoming' ? cls : s.status;
        return `<div class="step ${cls}"><span class="dot"></span>
          L${s.level} · ${s.required_role} · <span class="pill ${pillCls}">${label}</span> ${
            s.reason ? `<span class="muted small">— ${s.reason}</span>` : ''
          }</div>`;
      })
      .join('') || '<p class="muted">Not submitted yet — submit to start the approval flow.</p>';

  const histHtml =
    hist
      .map(
        (h) =>
          `<div class="step"><span class="dot"></span>${h.action} <span class="muted small">${new Date(
            h.created_at
          ).toLocaleString()}</span></div>`
      )
      .join('') || '<p class="muted">No history yet.</p>';

  const billRows =
    bills
      .map((b) => {
        const isImg = (b.content_type || '').startsWith('image/');
        return `<div class="bill-row">
          <div class="bill-thumb" data-att="${b.id}">${isImg ? '' : '📄'}</div>
          <div class="bill-meta">
            <div class="bill-name">${esc(b.filename)}</div>
            <div class="muted small">${esc(b.content_type)} · ${fmtBytes(b.size)}</div>
          </div>
          <button class="ghost small" onclick="openBill('${b.id}')">View</button>
        </div>`;
      })
      .join('') || '<p class="muted">No bills uploaded yet.</p>';

  const uploadHtml = canUpload
    ? `<div class="bill-upload">
        <div class="field">
          <label for="billFile">Attach a bill — receipt or invoice (image or PDF, max 5MB)</label>
          <input id="billFile" type="file" accept="image/png,image/jpeg,image/webp,image/gif,application/pdf" />
        </div>
        <button class="primary" onclick="uploadBill('${id}')">Upload bill</button>
        <p id="billErr" class="form-err"></p>
      </div>`
    : '';

  const billsHtml = uploadHtml + `<div class="bill-list">${billRows}</div>`;

  d.innerHTML = `
    <div class="modal-overlay" id="detailOverlay" onclick="if(event.target===this)closeDetail()">
      <div class="modal">
        <div class="row between">
          <h3>Expense detail</h3>
          <button class="ghost small" onclick="closeDetail()">✕ Close</button>
        </div>
        <div class="detail-grid">
          <div class="k">Status</div><div>${pill(e.status)}</div>
          <div class="k">Type</div><div>${e.type.replace('_', ' ')}</div>
          <div class="k">Amount</div><div>${fmt(e.base_amount)} ${
            e.currency !== orgCur() ? `<span class="muted small">(${e.amount} ${e.currency})</span>` : ''
          }</div>
          <div class="k">Category</div><div>${e.category}</div>
          <div class="k">Description</div><div>${e.description || '<span class="muted">—</span>'}</div>
        </div>
        ${actions.length ? `<div class="row" style="margin-top:14px">${actions.join('')}</div>` : ''}
        ${
          editable
            ? `<div id="editForm" class="edit-form hidden">
          <h3>Edit expense</h3>
          <div class="form-grid">
            <div class="field">
              <label for="eAmount">Amount</label>
              <input id="eAmount" type="number" min="0" step="0.01" value="${e.amount}" />
            </div>
            <div class="field">
              <label for="eCur">Currency</label>
              <select id="eCur">${curOptions(e.currency)}</select>
            </div>
            <div class="field">
              <label for="eCat">Category</label>
              <select id="eCat">${categoryOptions(e.category)}</select>
            </div>
          </div>
          <div class="field">
            <label for="eDesc">Description</label>
            <input id="eDesc" value="${e.description || ''}" placeholder="What was this expense for?" />
          </div>
          <p id="editErr" class="form-err"></p>
          <div class="row">
            <button class="primary" onclick="saveEdit('${id}')">Save changes</button>
            <button class="ghost" onclick="toggleEdit('${id}')">Cancel</button>
          </div>
        </div>`
            : ''
        }
        <div class="tabs">
          <button class="tab ${tab === 'chain' ? 'active' : ''}" data-tab="chain" onclick="switchDetailTab('chain')">Approval chain</button>
          <button class="tab ${tab === 'history' ? 'active' : ''}" data-tab="history" onclick="switchDetailTab('history')">History</button>
          <button class="tab ${tab === 'bills' ? 'active' : ''}" data-tab="bills" onclick="switchDetailTab('bills')">Bills${
            bills.length ? ` (${bills.length})` : ''
          }</button>
        </div>
        <div data-tab="chain" class="tab-pane steps ${tab === 'chain' ? '' : 'hidden'}">${chainHtml}</div>
        <div data-tab="history" class="tab-pane steps ${tab === 'history' ? '' : 'hidden'}">${histHtml}</div>
        <div data-tab="bills" class="tab-pane ${tab === 'bills' ? '' : 'hidden'}">${billsHtml}</div>
      </div>
    </div>`;
  loadBillThumbs(bills);
}

function closeDetail() {
  state.openExpenseId = null;
  const d = document.getElementById('detail');
  if (d) d.innerHTML = '';
}

function switchDetailTab(tab) {
  state.detailTab = tab;
  document
    .querySelectorAll('#detailOverlay .tab')
    .forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document
    .querySelectorAll('#detailOverlay .tab-pane')
    .forEach((p) => p.classList.toggle('hidden', p.dataset.tab !== tab));
}

function toggleEdit(id) {
  const f = document.getElementById('editForm');
  if (f) f.classList.toggle('hidden');
}

async function uploadBill(id) {
  const err = document.getElementById('billErr');
  if (err) err.textContent = '';
  const input = document.getElementById('billFile');
  const file = input && input.files && input.files[0];
  if (!file) {
    if (err) err.textContent = 'Choose an image or PDF first.';
    return;
  }
  try {
    await postBill(id, file);
    toast('Bill uploaded');
    state.detailTab = 'bills';
    await showDetail(id);
  } catch (e) {
    if (err) err.textContent = e.message;
    else toastErr(e.message);
  }
}

async function openBill(attId) {
  try {
    const url = await authBlobUrl(`/attachments/${attId}`);
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) {
    toastErr(e.message);
  }
}

// Lazily load image bills as thumbnails (each fetch carries the auth header).
async function loadBillThumbs(bills) {
  for (const b of bills) {
    if (!(b.content_type || '').startsWith('image/')) continue;
    const el = document.querySelector(`.bill-thumb[data-att="${b.id}"]`);
    if (!el) continue;
    try {
      const url = await authBlobUrl(`/attachments/${b.id}`);
      el.style.backgroundImage = `url(${url})`;
      el.classList.add('has-img');
    } catch {
      /* leave the placeholder */
    }
  }
}

async function saveEdit(id) {
  const err = document.getElementById('editErr');
  err.textContent = '';
  const amount = Number(document.getElementById('eAmount').value);
  if (!(amount > 0)) {
    err.textContent = 'Amount must be greater than 0.';
    return;
  }
  try {
    await api(`/expenses/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        amount,
        currency: document.getElementById('eCur').value,
        category: document.getElementById('eCat').value,
        description: document.getElementById('eDesc').value
      })
    });
    toast('Saved');
    await loadExpenseList();
    await showDetail(id);
  } catch (e) {
    err.textContent = e.message;
  }
}

async function doSubmit(id) {
  try {
    await api(`/expenses/${id}/submit`, { method: 'POST', body: '{}' });
    toast('Submitted for approval');
    await loadExpenseList();
    await showDetail(id);
    refreshNotifs();
  } catch (e) {
    toastErr(e.message);
    if (/budget/i.test(e.message)) {
      toastErr('Over budget — please edit the amount instead of withdrawing.');
      await showDetail(id);
      const f = document.getElementById('editForm');
      if (f) f.classList.remove('hidden');
      const ee = document.getElementById('editErr');
      if (ee) ee.textContent = e.message;
    }
  }
}

async function act(id, action) {
  try {
    await api(`/expenses/${id}/${action}`, { method: 'POST', body: '{}' });
    toast(action + ' done');
    if (action === 'withdraw') state.openExpenseId = id;
    await loadExpenseList();
    if (state.openExpenseId) await showDetail(state.openExpenseId);
  } catch (e) {
    toastErr(e.message);
  }
}

// ---------- Approvals ----------
async function viewApprovals() {
  const v = document.getElementById('view');
  v.innerHTML = `<div class="panel">
    <div class="row between"><h3>Pending approvals (your queue)</h3><button id="refreshAppr" class="ghost small">↻ Refresh</button></div>
    <table><thead><tr><th>Requester</th><th>Category</th><th>Amount</th><th>Level</th><th>Bill</th><th>Actions</th></tr></thead>
    <tbody id="apprBody"></tbody></table></div>
    <div id="detail"></div>`;
  document.getElementById('refreshAppr').onclick = loadApprovals;
  await loadApprovals();
}

// Renders the bill cell for an approval row: a thumbnail for a single image,
// or a link that opens the bill / the expense's Bills tab.
function apprBillCell(p) {
  const n = p.attachment_count || 0;
  if (!n) return '<td><span class="muted">—</span></td>';
  const isImg = (p.first_attachment_type || '').startsWith('image/');
  if (isImg && n === 1) {
    return `<td><div class="bill-thumb sm" data-att="${p.first_attachment_id}" title="View bill"
      onclick="openBill('${p.first_attachment_id}')"></div></td>`;
  }
  const onClick =
    n === 1 ? `openBill('${p.first_attachment_id}')` : `openExpenseBills('${p.expense_id}')`;
  return `<td><button class="ghost small" onclick="${onClick}">📎 View${
    n > 1 ? ` (${n})` : ''
  }</button></td>`;
}

// Open an expense's detail straight on the Bills tab (read-only review view).
async function openExpenseBills(id) {
  state.detailTab = 'bills';
  await showDetail(id);
}

async function loadApprovals() {
  const body = document.getElementById('apprBody');
  if (!body) return;
  const pending = await api('/approvals/pending');
  body.innerHTML =
    pending
      .map(
        (p) => `<tr>
      <td>${esc(p.requester_name) || '—'}<div class="muted small">${esc(p.requester_email)}</div></td>
      <td>${esc(p.category)}<div class="muted small">${esc(p.description)}</div></td>
      <td>${fmt(p.base_amount)}</td><td>L${p.level}</td>
      ${apprBillCell(p)}
      <td class="row">
        <button class="green" onclick="decide('${p.expense_id}','approve')">Approve</button>
        <button class="red" onclick="decide('${p.expense_id}','reject')">Reject</button>
      </td></tr>`
      )
      .join('') || emptyRow(6);
  // Load image thumbnails for rows that have a single image bill.
  loadBillThumbs(
    pending
      .filter((p) => p.attachment_count && (p.first_attachment_type || '').startsWith('image/'))
      .map((p) => ({ id: p.first_attachment_id, content_type: p.first_attachment_type }))
  );
}

async function decide(id, action) {
  let reason = 'Approved';
  if (action === 'reject') {
    reason = prompt('Reason for rejection:');
    if (!reason) return;
  }
  try {
    await api(`/expenses/${id}/${action}`, {
      method: 'POST',
      headers: { 'Idempotency-Key': `${id}-${action}-${Date.now()}` },
      body: JSON.stringify({ reason })
    });
    toast(action + 'd');
    loadApprovals();
    refreshNotifs();
  } catch (e) {
    toastErr(e.message);
  }
}

// ---------- Budgets (per-user monthly limits) ----------
async function viewBudgets() {
  const v = document.getElementById('view');
  v.innerHTML = `<div class="panel"><div class="row between">
      <h3>Monthly budgets</h3><button id="refreshBud" class="ghost small">↻ Refresh</button></div>
    <p class="muted small">Budgets are enforced <b>per person</b>: each user's own
      approved + in-review spend this month must stay within their limit. A user
      with no personal limit falls back to the org default below. Amounts are in
      the org currency (${orgCur()}).</p>
    <div id="budBody">Loading…</div></div>`;
  document.getElementById('refreshBud').onclick = loadBudgets;
  await loadBudgets();
}

async function loadBudgets() {
  const body = document.getElementById('budBody');
  if (!body) return;
  let users, budgets, spend;
  try {
    [users, budgets, spend] = await Promise.all([
      api('/users'),
      api('/budgets'),
      api('/budgets/spend')
    ]);
  } catch (e) {
    body.innerHTML = `<p style="color:#ef4d5a"><b>Couldn't load budgets:</b> ${esc(e.message)}</p>
      <p class="muted small">If this says the route was not found, the server is
      running older code — restart it (<code>npm run dev</code>) and refresh.</p>`;
    return;
  }
  const orgDefault = budgets.find((b) => b.scope === 'org' && b.period === 'monthly');
  const userMonthly = {};
  budgets
    .filter((b) => b.scope === 'user' && b.period === 'monthly' && b.user_id)
    .forEach((b) => (userMonthly[b.user_id] = Number(b.limit_amount)));

  const rows = users
    .filter((u) => u.is_active)
    .map((u) => {
      const limit = userMonthly[u.id];
      const effective = limit ?? (orgDefault ? Number(orgDefault.limit_amount) : null);
      const spent = Number(spend[u.id] || 0);
      const pct = effective ? Math.round((spent / effective) * 100) : 0;
      const warn = effective && spent > effective ? ' style="color:#ef4d5a"' : '';
      return `<tr>
        <td>${esc(u.name)}<div class="muted small">${esc(u.email)} · ${u.role}</div></td>
        <td${warn}>${fmt(spent)}</td>
        <td>${effective != null ? fmt(effective) : '<span class="muted">none</span>'}
            ${limit == null && effective != null ? '<span class="muted small"> (org default)</span>' : ''}</td>
        <td>${effective ? `<span class="muted small">${pct}%</span>` : ''}</td>
        <td class="row">
          <input id="bud_${u.id}" type="number" min="0" step="0.01"
                 placeholder="${limit ?? ''}" style="width:120px" />
          <button class="ghost small" onclick="setUserBudget('${u.id}')">Set</button>
        </td></tr>`;
    })
    .join('');

  body.innerHTML = `
    <div class="muted small" style="margin-bottom:8px">
      Org default monthly budget:
      <b>${orgDefault ? fmt(Number(orgDefault.limit_amount)) : 'not set'}</b>
    </div>
    <table>
      <thead><tr><th>Employee</th><th>Spent (this month)</th><th>Monthly limit</th>
        <th>Used</th><th>Set personal limit</th></tr></thead>
      <tbody>${rows || emptyRow(5)}</tbody>
    </table>`;
}

async function setUserBudget(userId) {
  const input = document.getElementById(`bud_${userId}`);
  const val = Number(input && input.value);
  if (!val || val <= 0) {
    toastErr('Enter a positive monthly limit.');
    return;
  }
  try {
    await api('/budgets', {
      method: 'POST',
      body: JSON.stringify({
        userId,
        scope: 'user',
        period: 'monthly',
        limitAmount: val,
        currency: orgCur()
      })
    });
    toast('Budget set');
    loadBudgets();
  } catch (e) {
    toastErr(e.message);
  }
}
window.setUserBudget = setUserBudget;

// ---------- Dashboard ----------
async function viewDashboard() {
  const [summary, byStatus, byCat, spend, audit] = await Promise.all([
    api('/analytics/summary'),
    api('/analytics/by-status'),
    api('/analytics/by-category'),
    api('/analytics/spend'),
    api('/analytics/audit-volume')
  ]);
  const v = document.getElementById('view');
  v.innerHTML = `
    <div class="cards">
      <div class="card"><div class="label">Approved spend</div><div class="value">${fmt(summary.approvedSpend)}</div></div>
      <div class="card"><div class="label">Pending approvals</div><div class="value">${summary.pendingApprovals}</div></div>
      <div class="card"><div class="label">SLA breached</div><div class="value">${summary.slaBreached}</div></div>
      <div class="card"><div class="label">Approved count</div><div class="value">${summary.approvedCount}</div></div>
      <div class="card"><div class="label">Audit events</div><div class="value">${summary.auditEvents}</div></div>
    </div>
    <div class="grid2">
      <div class="panel"><h3>Spend over time</h3><canvas id="cSpend"></canvas></div>
      <div class="panel"><h3>Expenses by status</h3><canvas id="cStatus"></canvas></div>
      <div class="panel"><h3>Spend by category</h3><canvas id="cCat"></canvas></div>
      <div class="panel"><h3>Audit volume</h3><canvas id="cAudit"></canvas></div>
    </div>`;
  Object.values(state.charts).forEach((c) => c.destroy());
  state.charts = {};
  const C = '#4f8cff', G = '#2fbf71', A = '#f0a826', R = '#ef4d5a', P = '#9b5de5';
  state.charts.spend = line('cSpend', spend.map((d) => d.day), spend.map((d) => d.total), C);
  state.charts.status = donut('cStatus', byStatus.map((d) => d.status), byStatus.map((d) => d.count), [C, A, G, R, P, '#888']);
  state.charts.cat = bar('cCat', byCat.map((d) => d.category), byCat.map((d) => d.total), G);
  state.charts.audit = line('cAudit', audit.map((d) => d.day), audit.map((d) => d.count), P);
}

function line(id, labels, data, color) {
  return new Chart(document.getElementById(id), {
    type: 'line',
    data: { labels, datasets: [{ data, borderColor: color, backgroundColor: color + '33', fill: true, tension: 0.3 }] },
    options: chartOpts()
  });
}
function bar(id, labels, data, color) {
  return new Chart(document.getElementById(id), {
    type: 'bar',
    data: { labels, datasets: [{ data, backgroundColor: color }] },
    options: chartOpts()
  });
}
function donut(id, labels, data, colors) {
  return new Chart(document.getElementById(id), {
    type: 'doughnut',
    data: { labels, datasets: [{ data, backgroundColor: colors }] },
    options: { plugins: { legend: { labels: { color: '#e6eaf0' } } } }
  });
}
function chartOpts() {
  return {
    plugins: { legend: { display: false } },
    scales: {
      x: { ticks: { color: '#8b98a9' }, grid: { color: '#2a3240' } },
      y: { ticks: { color: '#8b98a9' }, grid: { color: '#2a3240' } }
    }
  };
}

// ---------- Policies (visual builder, no JSON) ----------
const APPROVER_ROLES = ['manager', 'finance', 'admin'];
const STANDARD_BANDS = [
  { min: 0, max: 5000, levels: ['manager'] },
  { min: 5001, max: 50000, levels: ['manager', 'finance'] },
  { min: 50001, max: null, levels: ['manager', 'finance', 'admin'] }
];
let ruleRowSeq = 0;

function ruleRowHtml(rule) {
  const rid = `rr${ruleRowSeq++}`;
  const levels = (rule && rule.levels) || [];
  const checks = APPROVER_ROLES.map(
    (r) =>
      `<label class="chk"><input type="checkbox" data-role="${r}" ${
        levels.includes(r) ? 'checked' : ''
      }/> ${r}</label>`
  ).join('');
  return `<div class="rule-row" data-rid="${rid}">
    <div class="field"><label>From (₹)</label><input class="rMin" type="number" min="0" value="${
      rule ? rule.min : 0
    }" /></div>
    <div class="field"><label>To (₹, blank = no limit)</label><input class="rMax" type="number" min="0" placeholder="∞" value="${
      rule && rule.max != null ? rule.max : ''
    }" /></div>
    <div class="field grow"><label>Must be approved by (in this order)</label><div class="chk-row">${checks}</div></div>
    <button class="ghost small rDel" title="Remove this band">✕</button>
  </div>`;
}

function addRuleRow(rule) {
  const c = document.getElementById('ruleRows');
  if (!c) return;
  c.insertAdjacentHTML('beforeend', ruleRowHtml(rule));
  const row = c.lastElementChild;
  row.querySelector('.rDel').onclick = () => row.remove();
}

function collectRules() {
  return [...document.querySelectorAll('#ruleRows .rule-row')].map((row) => {
    const min = Number(row.querySelector('.rMin').value);
    const maxRaw = row.querySelector('.rMax').value.trim();
    const max = maxRaw === '' ? null : Number(maxRaw);
    const levels = [...row.querySelectorAll('input[data-role]:checked')].map(
      (c) => c.dataset.role
    );
    return { min, max, levels };
  });
}

async function viewPolicies() {
  const [policies, cats] = await Promise.all([api('/policies'), loadCategories()]);
  const v = document.getElementById('view');
  const canManage = ['finance', 'admin'].includes(state.user.role);
  v.innerHTML = `
    ${
      canManage
        ? `<div class="panel">
      <h3>Create approval policy</h3>
      <p class="muted small">Only one policy is active at a time — the active policy decides who approves each expense based on its amount. Creating a policy makes it the active one.</p>
      <div class="form-grid">
        <div class="field">
          <label for="pName">Policy name</label>
          <input id="pName" placeholder="e.g. Standard approval policy" />
        </div>
        <div class="field">
          <label for="pTol">Tolerance % <span class="muted">(allowed variance for company-paid amounts)</span></label>
          <input id="pTol" type="number" min="0" max="100" placeholder="0" />
        </div>
      </div>
      <label class="lbl">Approval bands — for each amount range, tick who must approve</label>
      <div id="ruleRows"></div>
      <div class="row" style="margin:8px 0">
        <button class="ghost small" id="addBandBtn">+ Add band</button>
        <button class="ghost small" id="stdBtn">Use standard template</button>
      </div>
      <p id="polErr" class="form-err"></p>
      <button class="primary" id="createPolicyBtn">Create policy</button>
    </div>`
        : ''
    }
    <div class="panel"><h3>Approval policies</h3>
    <p class="muted small">The <strong>active</strong> policy is used for all new approvals.</p>
    <table><thead><tr><th>Name</th><th>Bands (amount → approvers)</th><th>Tolerance</th><th>Status</th>${
      canManage ? '<th></th>' : ''
    }</tr></thead>
    <tbody>${policies
      .map(
        (p) => `<tr class="${p.active ? 'active-row' : ''}"><td>${p.name}</td>
      <td>${p.rules_json.rules
        .map((r) => `₹${r.min}–${r.max ?? '∞'}: ${r.levels.join(' → ')}`)
        .join('<br/>')}</td>
      <td>${p.tolerance_percent}%</td>
      <td>${
        p.active
          ? '<span class="pill approved">active</span>'
          : '<span class="pill draft">inactive</span>'
      }</td>
      ${
        canManage
          ? `<td class="row">
        <button class="ghost small" onclick="togglePolicy('${p.id}', ${!p.active})">${
          p.active ? 'Deactivate' : 'Activate'
        }</button>
        ${
          p.active
            ? '<span class="muted small" title="Activate another policy first">In use</span>'
            : `<button class="ghost small danger" onclick="deletePolicyUI('${p.id}','${p.name.replace(/'/g, '')}')">Delete</button>`
        }
      </td>`
          : ''
      }</tr>`
      )
      .join('')}</tbody></table></div>
    ${
      canManage
        ? `<div class="panel">
      <h3>Expense categories</h3>
      <p class="muted small">Employees choose from these when creating an expense.</p>
      <div class="chip-list">${
        cats
          .map(
            (c) =>
              `<span class="chip">${c.name} <button title="Remove" onclick="removeCategory('${c.id}')">✕</button></span>`
          )
          .join('') || '<span class="muted small">No categories yet.</span>'
      }</div>
      <div class="row" style="margin-top:10px">
        <input id="newCat" placeholder="New category name (e.g. Marketing)" />
        <button class="primary" id="addCatBtn">Add category</button>
      </div>
      <p id="catErr" class="form-err"></p>
    </div>`
        : ''
    }`;
  if (canManage) {
    STANDARD_BANDS.forEach((b) => addRuleRow(b));
    document.getElementById('addBandBtn').onclick = () => addRuleRow({ min: 0, max: null, levels: [] });
    document.getElementById('stdBtn').onclick = () => {
      document.getElementById('ruleRows').innerHTML = '';
      STANDARD_BANDS.forEach((b) => addRuleRow(b));
    };
    document.getElementById('createPolicyBtn').onclick = createPolicy;
    document.getElementById('addCatBtn').onclick = addCategory;
  }
}

async function createPolicy() {
  const err = document.getElementById('polErr');
  err.textContent = '';
  const name = document.getElementById('pName').value.trim();
  if (!name) return (err.textContent = 'Give the policy a name.');
  const rules = collectRules();
  if (!rules.length) return (err.textContent = 'Add at least one approval band.');
  for (const r of rules) {
    if (!(r.min >= 0)) return (err.textContent = 'Each band needs a valid "From" amount.');
    if (r.max !== null && r.max < r.min)
      return (err.textContent = `A band has "To" (${r.max}) below "From" (${r.min}).`);
    if (!r.levels.length)
      return (err.textContent = 'Every band must have at least one approver ticked.');
  }
  try {
    await api('/policies', {
      method: 'POST',
      body: JSON.stringify({
        name,
        tolerancePercent: Number(document.getElementById('pTol').value) || 0,
        rulesJson: { rules }
      })
    });
    toast('Policy created and activated');
    viewPolicies();
  } catch (e) {
    err.textContent = e.message;
  }
}

async function deletePolicyUI(id, name) {
  if (!confirm(`Delete policy "${name}"? This can't be undone. Past expenses keep their own policy snapshot, so history is unaffected.`)) {
    return;
  }
  try {
    await api(`/policies/${id}`, { method: 'DELETE' });
    toast('Policy deleted');
    viewPolicies();
  } catch (e) {
    toastErr(e.message);
  }
}

async function togglePolicy(id, active) {
  try {
    await api(`/policies/${id}`, { method: 'PATCH', body: JSON.stringify({ active }) });
    toast(active ? 'Policy activated' : 'Policy deactivated');
    viewPolicies();
  } catch (e) {
    toastErr(e.message);
  }
}

async function addCategory() {
  const err = document.getElementById('catErr');
  err.textContent = '';
  const name = document.getElementById('newCat').value.trim();
  if (!name) return (err.textContent = 'Enter a category name.');
  try {
    await api('/categories', { method: 'POST', body: JSON.stringify({ name }) });
    state.categories = null;
    await loadCategories();
    viewPolicies();
  } catch (e) {
    err.textContent = e.message;
  }
}

async function removeCategory(id) {
  try {
    await api(`/categories/${id}`, { method: 'DELETE' });
    state.categories = null;
    await loadCategories();
    viewPolicies();
  } catch (e) {
    toastErr(e.message);
  }
}

// ---------- Users ----------
async function viewUsers() {
  const users = await api('/users');
  const managers = users.filter(
    (u) => (u.role === 'manager' || u.role === 'admin') && u.is_active !== false
  );
  const hasManager = users.some((u) => u.role === 'manager');
  const needsSetup = users.length <= 1 || !hasManager;
  const v = document.getElementById('view');
  v.innerHTML = `
    ${
      needsSetup
        ? `<div class="banner">
      <strong>Finish setting up your organisation</strong>
      <p>Expenses can't be approved until there's someone to approve them. Before you (or anyone) submits an expense:</p>
      <ol>
        <li>Add at least one <strong>manager</strong>${hasManager ? ' ✓' : ''}.</li>
        <li>Add your <strong>employees</strong> and assign them to a manager.</li>
        <li>Review the active approval policy under <strong>Policies</strong>.</li>
      </ol>
    </div>`
        : ''
    }
    <div class="panel">
      <h3>Add employee / user</h3>
      <div class="form-grid">
        <div class="field">
          <label for="uName">Full name</label>
          <input id="uName" placeholder="e.g. Priya Nair" />
        </div>
        <div class="field">
          <label for="uEmail">Email (used to log in)</label>
          <input id="uEmail" type="email" placeholder="name@company.com" />
        </div>
        <div class="field">
          <label for="uPass">Temporary password</label>
          <input id="uPass" type="password" placeholder="at least 6 characters" />
        </div>
        <div class="field">
          <label for="uRole">Role</label>
          <select id="uRole">
            <option value="employee">Employee — submits expenses</option>
            <option value="manager">Manager — approves their team's expenses</option>
            <option value="finance">Finance — approves & manages policies</option>
            <option value="admin">Admin — full access</option>
          </select>
        </div>
        <div class="field">
          <label for="uMgr">Reports to (manager)</label>
          <select id="uMgr">
            <option value="">— none —</option>
            ${managers.map((m) => `<option value="${m.id}">${m.name} (${m.role})</option>`).join('')}
          </select>
        </div>
      </div>
      <p id="userErr" class="form-err"></p>
      <button class="primary" id="addUserBtn">Create user</button>
    </div>
    <div class="panel"><h3>Users in your organization</h3>
    <p class="muted small">Change a user's role or who they report to inline — useful if you added an employee before their manager existed.</p>
    <table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Reports to</th><th>Status</th><th></th></tr></thead>
    <tbody>${users
      .map((u) => {
        const inactive = u.is_active === false;
        const isSelf = u.id === state.user.id;
        const statusPill = inactive
          ? '<span class="pill draft">inactive</span>'
          : '<span class="pill approved">active</span>';
        const action = isSelf
          ? '<span class="muted small">you</span>'
          : `<button class="ghost small ${inactive ? '' : 'danger'}" onclick="toggleUser('${u.id}', ${inactive})">${
              inactive ? 'Reactivate' : 'Deactivate'
            }</button>`;
        const roleSel = `<select class="row-edit" ${
          inactive || isSelf ? 'disabled' : ''
        } title="${isSelf ? "You can't change your own role" : 'Change role'}"
          onchange="updateUserField('${u.id}',{role:this.value})">
          ${['employee', 'manager', 'finance', 'admin']
            .map((r) => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${r}</option>`)
            .join('')}
        </select>`;
        const mgrSel = `<select class="row-edit" ${inactive ? 'disabled' : ''} title="Reports to"
          onchange="updateUserField('${u.id}',{managerId:this.value||null})">
          <option value="">— none —</option>
          ${managers
            .filter((m) => m.id !== u.id)
            .map(
              (m) =>
                `<option value="${m.id}" ${u.manager_id === m.id ? 'selected' : ''}>${esc(
                  m.name
                )} (${m.role})</option>`
            )
            .join('')}
        </select>`;
        return `<tr class="${inactive ? 'inactive-user' : ''}">
        <td>${esc(u.name)}</td><td>${esc(u.email)}</td>
        <td>${roleSel}</td>
        <td>${mgrSel}</td>
        <td>${statusPill}</td>
        <td>${action}</td></tr>`;
      })
      .join('')}</tbody></table></div>`;
  document.getElementById('addUserBtn').onclick = createUser;
}

async function updateUserField(id, patch) {
  try {
    await api(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
    toast('User updated');
    viewUsers();
  } catch (e) {
    toastErr(e.message);
  }
}

async function toggleUser(id, activate) {
  if (
    !activate &&
    !confirm('Deactivate this user? They will no longer be able to log in, but their past expenses and approvals are kept.')
  ) {
    return;
  }
  try {
    await api(`/users/${id}`, { method: 'PATCH', body: JSON.stringify({ isActive: activate }) });
    toast(activate ? 'User reactivated' : 'User deactivated');
    viewUsers();
  } catch (e) {
    toastErr(e.message);
  }
}

async function createUser() {
  const err = document.getElementById('userErr');
  err.textContent = '';
  const name = document.getElementById('uName').value.trim();
  const email = document.getElementById('uEmail').value.trim();
  const password = document.getElementById('uPass').value;
  if (!name) return (err.textContent = 'Name is required.');
  if (!isValidEmail(email)) return (err.textContent = 'Enter a valid email address (e.g. name@company.com).');
  if (password.length < 6) return (err.textContent = 'Password must be at least 6 characters.');
  try {
    const managerId = document.getElementById('uMgr').value;
    await api('/users', {
      method: 'POST',
      body: JSON.stringify({
        name,
        email,
        password,
        role: document.getElementById('uRole').value,
        managerId: managerId || null
      })
    });
    toast('User created');
    viewUsers();
  } catch (e) {
    err.textContent = e.message;
  }
}

// ---------- Notifications ----------
function notifText(n) {
  const lvl = n.payload_json?.level ? ` · L${n.payload_json.level}` : '';
  return (
    {
      approval_requested: `Approval requested${lvl}`,
      expense_approved: 'Your expense was approved',
      expense_rejected: 'Your expense was rejected'
    }[n.type] || n.type
  );
}

async function refreshNotifs() {
  try {
    const n = await api('/notifications');
    state.notifs = n;
    const unread = n.filter((x) => !x.read).length;
    const b = document.getElementById('notifBadge');
    b.textContent = unread;
    b.classList.toggle('hidden', unread === 0);
    if (!document.getElementById('notifPanel').classList.contains('hidden')) renderNotifPanel();
  } catch {
    /* ignore */
  }
}

function toggleNotifPanel() {
  const p = document.getElementById('notifPanel');
  p.classList.toggle('hidden');
  if (!p.classList.contains('hidden')) renderNotifPanel();
}

function renderNotifPanel() {
  const p = document.getElementById('notifPanel');
  const list = state.notifs || [];
  p.innerHTML = `
    <div class="notif-head"><span>Notifications</span>${
      list.some((n) => !n.read) ? '<button class="ghost small" onclick="markAllNotifs()">Mark all read</button>' : ''
    }</div>
    ${
      list.length
        ? list
            .slice(0, 30)
            .map(
              (n) => `<div class="notif-item ${n.read ? '' : 'unread'}" onclick="openNotif('${n.id}','${n.type}','${n.payload_json?.expenseId || ''}')">
        <div>${notifText(n)}</div>
        <div class="muted small">${new Date(n.created_at).toLocaleString()}</div>
      </div>`
            )
            .join('')
        : '<div class="notif-item muted">No notifications</div>'
    }`;
}

async function openNotif(id, type, expenseId) {
  try {
    await api(`/notifications/${id}/read`, { method: 'POST', body: '{}' });
  } catch {
    /* ignore */
  }
  document.getElementById('notifPanel').classList.add('hidden');
  refreshNotifs();
  if (type === 'approval_requested' && can(['manager', 'finance', 'admin'])) {
    go('approvals');
  } else if (expenseId) {
    state.openExpenseId = expenseId;
    go('expenses');
  }
}

async function markAllNotifs() {
  const unread = (state.notifs || []).filter((n) => !n.read);
  await Promise.all(
    unread.map((n) => api(`/notifications/${n.id}/read`, { method: 'POST', body: '{}' }).catch(() => {}))
  );
  refreshNotifs();
}

// ---------- Polling (auto-refresh) ----------
async function autoRefresh() {
  if (!state.accessToken) return;
  refreshNotifs();
  try {
    if (state.view === 'expenses') {
      await loadExpenseList();
      // Don't refresh the detail panel while the user is editing — it would
      // wipe their open edit form mid-typing.
      const ef = document.getElementById('editForm');
      const editing = ef && !ef.classList.contains('hidden');
      if (state.openExpenseId && !editing) await showDetail(state.openExpenseId);
    } else if (state.view === 'approvals') {
      await loadApprovals();
    }
  } catch {
    /* ignore transient */
  }
}
function startPolling() {
  stopPolling();
  state.poll = setInterval(autoRefresh, 8000);
}
function stopPolling() {
  if (state.poll) clearInterval(state.poll);
  state.poll = null;
}

// ---------- Wire up ----------
document.getElementById('loginBtn').onclick = () =>
  login(document.getElementById('email').value, document.getElementById('password').value).catch(
    (e) => (document.getElementById('loginErr').textContent = e.message)
  );
document.querySelectorAll('.quick-grid button').forEach((b) => {
  b.onclick = () => {
    document.getElementById('email').value = b.dataset.email;
    login(b.dataset.email, 'password123').catch(
      (e) => (document.getElementById('loginErr').textContent = e.message)
    );
  };
});
document.getElementById('logout').onclick = logout;
document.getElementById('notifBtn').onclick = toggleNotifPanel;

document.getElementById('toSignup').onclick = (e) => {
  e.preventDefault();
  document.getElementById('loginForm').classList.add('hidden');
  document.getElementById('signupForm').classList.remove('hidden');
  document.getElementById('loginErr').textContent = '';
};
document.getElementById('toLogin').onclick = (e) => {
  e.preventDefault();
  document.getElementById('signupForm').classList.add('hidden');
  document.getElementById('loginForm').classList.remove('hidden');
  document.getElementById('loginErr').textContent = '';
};
document.getElementById('signupBtn').onclick = () =>
  signup().catch((e) => (document.getElementById('loginErr').textContent = e.message));

// Close notif panel when clicking outside
document.addEventListener('click', (e) => {
  const wrap = document.getElementById('notifWrap');
  const panel = document.getElementById('notifPanel');
  if (wrap && !wrap.contains(e.target) && !panel.classList.contains('hidden')) {
    panel.classList.add('hidden');
  }
});

// Expose handlers used in inline onclick
window.act = act;
window.decide = decide;
window.doSubmit = doSubmit;
window.toggleEdit = toggleEdit;
window.saveEdit = saveEdit;
window.openNotif = openNotif;
window.markAllNotifs = markAllNotifs;
window.togglePolicy = togglePolicy;
window.deletePolicyUI = deletePolicyUI;
window.removeCategory = removeCategory;
window.closeDetail = closeDetail;
window.switchDetailTab = switchDetailTab;
window.toggleUser = toggleUser;
window.updateUserField = updateUserField;
window.uploadBill = uploadBill;
window.openBill = openBill;
window.openExpenseBills = openExpenseBills;

// Esc closes the expense detail modal.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.openExpenseId) closeDetail();
});

// ---------- Bootstrap (restore session on refresh) ----------
(function bootstrap() {
  if (loadAuth()) {
    enterApp();
    go('expenses');
    refreshNotifs();
  }
})();
