const state = {
  accessToken: null,
  refreshToken: null,
  user: null,
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
      user: state.user
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
    return true;
  } catch {
    return false;
  }
}
function clearAuth() {
  state.accessToken = state.refreshToken = state.user = null;
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

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  setTimeout(() => t.classList.add('hidden'), 2800);
}

const fmt = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');
const pill = (s) => `<span class="pill ${s}">${s.replace('_', ' ')}</span>`;
const isValidEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

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
      password: document.getElementById('suPass').value
    })
  });
  state.accessToken = data.accessToken;
  state.refreshToken = data.refreshToken;
  state.user = data.user;
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
    users: viewUsers
  }[view])();
}

// ---------- Expenses ----------
async function viewExpenses() {
  const v = document.getElementById('view');
  v.innerHTML = `
    <div class="panel">
      <h3>Create expense</h3>
      <div class="flex">
        <select id="ftype">
          <option value="reimbursement">Reimbursement (self-paid)</option>
          <option value="company_paid">Company paid (direct)</option>
        </select>
        <input id="fcat" placeholder="category" value="travel" />
        <input id="famount" type="number" placeholder="amount" value="3000" />
        <select id="fcur"><option>INR</option><option>USD</option><option>EUR</option><option>GBP</option></select>
      </div>
      <input id="fdesc" placeholder="description" value="Business expense" />
      <p id="expErr" class="form-err"></p>
      <button class="primary" id="createBtn">Create draft</button>
    </div>
    <div class="panel">
      <div class="row between"><h3>My expenses</h3><button id="refreshExp" class="ghost small">↻ Refresh</button></div>
      <table><thead><tr><th>Type</th><th>Category</th><th>Amount</th><th>Status</th><th></th></tr></thead>
      <tbody id="expBody"></tbody></table>
    </div>
    <div id="detail"></div>`;
  document.getElementById('createBtn').onclick = createExpense;
  document.getElementById('refreshExp').onclick = () => {
    loadExpenseList();
    if (state.openExpenseId) showDetail(state.openExpenseId);
  };
  await loadExpenseList();
  if (state.openExpenseId) await showDetail(state.openExpenseId);
}

async function loadExpenseList() {
  const body = document.getElementById('expBody');
  if (!body) return;
  const list = await api('/expenses?scope=mine&limit=50');
  body.innerHTML = list.map(rowExpense).join('') || emptyRow(5);
  body.querySelectorAll('[data-exp]').forEach((b) => (b.onclick = () => showDetail(b.dataset.exp)));
}

function rowExpense(e) {
  return `<tr${e.id === state.openExpenseId ? ' class="sel"' : ''}>
    <td>${e.type.replace('_', ' ')}</td><td>${e.category}</td>
    <td>${fmt(e.base_amount)} ${e.currency !== 'INR' ? `<span class="muted small">(${e.amount} ${e.currency})</span>` : ''}</td>
    <td>${pill(e.status)}</td>
    <td><button data-exp="${e.id}">View</button></td></tr>`;
}
const emptyRow = (n) => `<tr><td colspan="${n}" class="muted">No records</td></tr>`;

async function createExpense() {
  const err = document.getElementById('expErr');
  err.textContent = '';
  const amount = Number(document.getElementById('famount').value);
  if (!(amount > 0)) {
    err.textContent = 'Amount must be greater than 0.';
    return;
  }
  try {
    await api('/expenses', {
      method: 'POST',
      body: JSON.stringify({
        type: document.getElementById('ftype').value,
        category: document.getElementById('fcat').value,
        amount,
        currency: document.getElementById('fcur').value,
        description: document.getElementById('fdesc').value
      })
    });
    toast('Draft created');
    loadExpenseList();
  } catch (e) {
    err.textContent = e.message;
  }
}

async function showDetail(id) {
  state.openExpenseId = id;
  const e = await api(`/expenses/${id}`);
  const hist = await api(`/expenses/${id}/history`);
  const d = document.getElementById('detail');
  if (!d) return;
  const editable = ['draft', 'submitted', 'in_review'].includes(e.status);
  const actions = [];
  if (e.status === 'draft') actions.push(`<button class="green" onclick="doSubmit('${id}')">Submit</button>`);
  if (editable) actions.push(`<button onclick="toggleEdit('${id}')">Edit</button>`);
  if (editable) actions.push(`<button class="red" onclick="act('${id}','withdraw')">Withdraw</button>`);

  d.innerHTML = `
    <div class="panel">
      <div class="row between"><h3>Expense detail</h3><div class="row">${actions.join('')}</div></div>
      <div class="detail-grid">
        <div class="k">Status</div><div>${pill(e.status)}</div>
        <div class="k">Type</div><div>${e.type}</div>
        <div class="k">Amount</div><div>${fmt(e.base_amount)} (${e.amount} ${e.currency})</div>
        <div class="k">Category</div><div>${e.category}</div>
        <div class="k">Current level</div><div>${e.current_level}</div>
      </div>
      ${
        editable
          ? `<div id="editForm" class="edit-form hidden">
        <h3>Edit expense</h3>
        <div class="flex">
          <input id="eAmount" type="number" value="${e.amount}" />
          <select id="eCur">${['INR', 'USD', 'EUR', 'GBP']
            .map((c) => `<option ${c === e.currency ? 'selected' : ''}>${c}</option>`)
            .join('')}</select>
          <input id="eCat" value="${e.category}" />
        </div>
        <input id="eDesc" value="${e.description || ''}" placeholder="description" />
        <p id="editErr" class="form-err"></p>
        <button class="primary" onclick="saveEdit('${id}')">Save changes</button>
      </div>`
          : ''
      }
      <div class="steps"><h3>Approval chain</h3>
        ${
          e.steps
            .map(
              (s) => `<div class="step ${s.status}"><span class="dot"></span>
          L${s.level} · ${s.required_role} · ${pill(s.status)} ${s.reason ? `<span class="muted small">— ${s.reason}</span>` : ''}</div>`
            )
            .join('') || '<p class="muted">Not submitted yet</p>'
        }
      </div>
      <div class="steps"><h3>History (audit trail)</h3>
        ${hist
          .map(
            (h) =>
              `<div class="step"><span class="dot"></span>${h.action} <span class="muted small">${new Date(h.created_at).toLocaleString()}</span></div>`
          )
          .join('')}
      </div>
    </div>`;
}

function toggleEdit(id) {
  const f = document.getElementById('editForm');
  if (f) f.classList.toggle('hidden');
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
    toast(e.message);
    if (/budget/i.test(e.message)) {
      toast('Over budget — please edit the amount instead of withdrawing.');
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
    toast(e.message);
  }
}

// ---------- Approvals ----------
async function viewApprovals() {
  const v = document.getElementById('view');
  v.innerHTML = `<div class="panel">
    <div class="row between"><h3>Pending approvals (your queue)</h3><button id="refreshAppr" class="ghost small">↻ Refresh</button></div>
    <table><thead><tr><th>Requester</th><th>Category</th><th>Amount</th><th>Level</th><th>Actions</th></tr></thead>
    <tbody id="apprBody"></tbody></table></div>`;
  document.getElementById('refreshAppr').onclick = loadApprovals;
  await loadApprovals();
}

async function loadApprovals() {
  const body = document.getElementById('apprBody');
  if (!body) return;
  const pending = await api('/approvals/pending');
  body.innerHTML =
    pending
      .map(
        (p) => `<tr>
      <td class="muted small">${p.requester_id?.slice(0, 8) || ''}</td>
      <td>${p.category}<div class="muted small">${p.description || ''}</div></td>
      <td>${fmt(p.base_amount)}</td><td>L${p.level}</td>
      <td class="row">
        <button class="green" onclick="decide('${p.expense_id}','approve')">Approve</button>
        <button class="red" onclick="decide('${p.expense_id}','reject')">Reject</button>
      </td></tr>`
      )
      .join('') || emptyRow(5);
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
    toast(e.message);
  }
}

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

// ---------- Policies ----------
const POLICY_TEMPLATE = JSON.stringify(
  {
    currency: 'INR',
    rules: [
      { min: 0, max: 5000, levels: ['manager'] },
      { min: 5001, max: 50000, levels: ['manager', 'finance'] },
      { min: 50001, max: null, levels: ['manager', 'finance', 'admin'] }
    ]
  },
  null,
  2
);

async function viewPolicies() {
  const policies = await api('/policies');
  const v = document.getElementById('view');
  const canManage = ['finance', 'admin'].includes(state.user.role);
  v.innerHTML = `
    ${
      canManage
        ? `<div class="panel">
      <h3>Create approval policy</h3>
      <div class="flex">
        <input id="pName" placeholder="policy name" value="Travel policy" />
        <input id="pTol" type="number" placeholder="tolerance %" value="10" />
      </div>
      <label class="muted small">Rules (JSON: amount range → approver roles)</label>
      <textarea id="pRules" rows="9">${POLICY_TEMPLATE}</textarea>
      <p id="polErr" class="form-err"></p>
      <button class="primary" id="createPolicyBtn">Create policy</button>
    </div>`
        : ''
    }
    <div class="panel"><h3>Approval policies</h3>
    <table><thead><tr><th>Name</th><th>Rules (amount → levels)</th><th>Tolerance</th><th>Active</th></tr></thead>
    <tbody>${policies
      .map(
        (p) => `<tr><td>${p.name}</td>
      <td>${p.rules_json.rules.map((r) => `${r.min}–${r.max ?? '∞'}: ${r.levels.join(' → ')}`).join('<br/>')}</td>
      <td>${p.tolerance_percent}%</td><td>${p.active}</td></tr>`
      )
      .join('')}</tbody></table></div>`;
  if (canManage) document.getElementById('createPolicyBtn').onclick = createPolicy;
}

async function createPolicy() {
  const err = document.getElementById('polErr');
  err.textContent = '';
  let rulesJson;
  try {
    rulesJson = JSON.parse(document.getElementById('pRules').value);
  } catch {
    err.textContent = 'Rules must be valid JSON.';
    return;
  }
  if (!rulesJson || !Array.isArray(rulesJson.rules) || rulesJson.rules.length === 0) {
    err.textContent = 'Rules JSON must contain a non-empty "rules" array.';
    return;
  }
  try {
    await api('/policies', {
      method: 'POST',
      body: JSON.stringify({
        name: document.getElementById('pName').value,
        tolerancePercent: Number(document.getElementById('pTol').value) || 0,
        rulesJson
      })
    });
    toast('Policy created');
    viewPolicies();
  } catch (e) {
    err.textContent = e.message;
  }
}

// ---------- Users ----------
async function viewUsers() {
  const users = await api('/users');
  const managers = users.filter((u) => u.role === 'manager' || u.role === 'admin');
  const v = document.getElementById('view');
  v.innerHTML = `
    <div class="panel">
      <h3>Add employee / user</h3>
      <div class="flex">
        <input id="uName" placeholder="name" />
        <input id="uEmail" type="email" placeholder="email" />
      </div>
      <div class="flex">
        <input id="uPass" type="password" placeholder="password (min 6)" />
        <select id="uRole">
          <option value="employee">employee</option>
          <option value="manager">manager</option>
          <option value="finance">finance</option>
          <option value="admin">admin</option>
        </select>
        <select id="uMgr">
          <option value="">— manager (optional) —</option>
          ${managers.map((m) => `<option value="${m.id}">${m.name} (${m.role})</option>`).join('')}
        </select>
      </div>
      <p id="userErr" class="form-err"></p>
      <button class="primary" id="addUserBtn">Create user</button>
    </div>
    <div class="panel"><h3>Users in your organization</h3>
    <table><thead><tr><th>Name</th><th>Email</th><th>Role</th></tr></thead>
    <tbody>${users
      .map(
        (u) => `<tr><td>${u.name}</td><td>${u.email}</td><td><span class="small">${u.role}</span></td></tr>`
      )
      .join('')}</tbody></table></div>`;
  document.getElementById('addUserBtn').onclick = createUser;
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
      if (state.openExpenseId) await showDetail(state.openExpenseId);
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

// ---------- Bootstrap (restore session on refresh) ----------
(function bootstrap() {
  if (loadAuth()) {
    enterApp();
    go('expenses');
    refreshNotifs();
  }
})();
