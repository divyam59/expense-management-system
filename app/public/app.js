const state = { token: null, user: null, charts: {} };

// ---------- API ----------
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(path, { ...opts, headers });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
  return data;
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  setTimeout(() => t.classList.add('hidden'), 2600);
}

const fmt = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');
const pill = (s) => `<span class="pill ${s}">${s.replace('_', ' ')}</span>`;

// ---------- Auth ----------
async function login(email, password) {
  const data = await api('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password })
  });
  state.token = data.accessToken;
  state.user = data.user;
  document.getElementById('login').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  document.getElementById('whoami').textContent = `${data.user.name} · ${data.user.role}`;
  buildNav();
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
  state.token = data.accessToken;
  state.user = data.user;
  document.getElementById('login').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  document.getElementById('whoami').textContent = `${data.user.name} · ${data.user.role}`;
  buildNav();
  go('users');
  refreshNotifs();
  toast(`Organization "${data.organization.name}" created`);
}

function logout() {
  state.token = null;
  state.user = null;
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
  document.querySelectorAll('#nav button').forEach((b) =>
    b.classList.toggle('active', b.dataset.view === view)
  );
  ({ expenses: viewExpenses, approvals: viewApprovals, dashboard: viewDashboard,
     policies: viewPolicies, users: viewUsers }[view])();
}

// ---------- Expenses ----------
async function viewExpenses() {
  const list = await api('/expenses?scope=mine&limit=50');
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
      <button class="primary" id="createBtn">Create draft</button>
    </div>
    <div class="panel">
      <h3>My expenses</h3>
      <table><thead><tr><th>Type</th><th>Category</th><th>Amount</th><th>Status</th><th></th></tr></thead>
      <tbody>${list.map(rowExpense).join('') || emptyRow(5)}</tbody></table>
    </div>
    <div id="detail"></div>`;
  document.getElementById('createBtn').onclick = createExpense;
  v.querySelectorAll('[data-exp]').forEach((b) => (b.onclick = () => showDetail(b.dataset.exp)));
}

function rowExpense(e) {
  return `<tr>
    <td>${e.type.replace('_', ' ')}</td><td>${e.category}</td>
    <td>${fmt(e.base_amount)} ${e.currency !== 'INR' ? `<span class="muted small">(${e.amount} ${e.currency})</span>` : ''}</td>
    <td>${pill(e.status)}</td>
    <td><button data-exp="${e.id}">View</button></td></tr>`;
}
const emptyRow = (n) => `<tr><td colspan="${n}" class="muted">No records</td></tr>`;

async function createExpense() {
  try {
    await api('/expenses', {
      method: 'POST',
      body: JSON.stringify({
        type: document.getElementById('ftype').value,
        category: document.getElementById('fcat').value,
        amount: Number(document.getElementById('famount').value),
        currency: document.getElementById('fcur').value,
        description: document.getElementById('fdesc').value
      })
    });
    toast('Draft created');
    viewExpenses();
  } catch (e) { toast(e.message); }
}

async function showDetail(id) {
  const e = await api(`/expenses/${id}`);
  const hist = await api(`/expenses/${id}/history`);
  const d = document.getElementById('detail');
  const actions = [];
  if (e.status === 'draft') actions.push(`<button class="green" onclick="act('${id}','submit')">Submit</button>`);
  if (['draft', 'submitted', 'in_review'].includes(e.status))
    actions.push(`<button class="red" onclick="act('${id}','withdraw')">Withdraw</button>`);
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
      <div class="steps"><h3>Approval chain</h3>
        ${e.steps.map((s) => `<div class="step ${s.status}"><span class="dot"></span>
          L${s.level} · ${s.required_role} · ${pill(s.status)} ${s.reason ? `<span class="muted small">— ${s.reason}</span>` : ''}</div>`).join('') || '<p class="muted">Not submitted yet</p>'}
      </div>
      <div class="steps"><h3>History (audit trail)</h3>
        ${hist.map((h) => `<div class="step"><span class="dot"></span>${h.action} <span class="muted small">${new Date(h.created_at).toLocaleString()}</span></div>`).join('')}
      </div>
    </div>`;
}

async function act(id, action) {
  try { await api(`/expenses/${id}/${action}`, { method: 'POST', body: '{}' }); toast(action + ' done'); viewExpenses(); }
  catch (e) { toast(e.message); }
}

// ---------- Approvals ----------
async function viewApprovals() {
  const pending = await api('/approvals/pending');
  const v = document.getElementById('view');
  v.innerHTML = `<div class="panel"><h3>Pending approvals (your queue)</h3>
    <table><thead><tr><th>Category</th><th>Amount</th><th>Level</th><th>Actions</th></tr></thead>
    <tbody>${pending.map((p) => `<tr>
      <td>${p.category}<div class="muted small">${p.description || ''}</div></td>
      <td>${fmt(p.base_amount)}</td><td>L${p.level}</td>
      <td class="row">
        <button class="green" onclick="decide('${p.expense_id}','approve')">Approve</button>
        <button class="red" onclick="decide('${p.expense_id}','reject')">Reject</button>
      </td></tr>`).join('') || emptyRow(4)}</tbody></table></div>`;
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
    viewApprovals();
    refreshNotifs();
  } catch (e) { toast(e.message); }
}

// ---------- Dashboard ----------
async function viewDashboard() {
  const [summary, byStatus, byCat, spend, audit] = await Promise.all([
    api('/analytics/summary'), api('/analytics/by-status'), api('/analytics/by-category'),
    api('/analytics/spend'), api('/analytics/audit-volume')
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
    type: 'bar', data: { labels, datasets: [{ data, backgroundColor: color }] }, options: chartOpts()
  });
}
function donut(id, labels, data, colors) {
  return new Chart(document.getElementById(id), {
    type: 'doughnut', data: { labels, datasets: [{ data, backgroundColor: colors }] },
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
async function viewPolicies() {
  const policies = await api('/policies');
  const v = document.getElementById('view');
  v.innerHTML = `<div class="panel"><h3>Approval policies</h3>
    <table><thead><tr><th>Name</th><th>Rules (amount → levels)</th><th>Tolerance</th><th>Active</th></tr></thead>
    <tbody>${policies.map((p) => `<tr><td>${p.name}</td>
      <td>${p.rules_json.rules.map((r) => `${r.min}–${r.max ?? '∞'}: ${r.levels.join(' → ')}`).join('<br/>')}</td>
      <td>${p.tolerance_percent}%</td><td>${p.active}</td></tr>`).join('')}</tbody></table></div>`;
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
        <input id="uEmail" placeholder="email" />
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
      <button class="primary" id="addUserBtn">Create user</button>
    </div>
    <div class="panel"><h3>Users in your organization</h3>
    <table><thead><tr><th>Name</th><th>Email</th><th>Role</th></tr></thead>
    <tbody>${users.map((u) => `<tr><td>${u.name}</td><td>${u.email}</td><td><span class="small">${u.role}</span></td></tr>`).join('')}</tbody></table></div>`;
  document.getElementById('addUserBtn').onclick = createUser;
}

async function createUser() {
  try {
    const managerId = document.getElementById('uMgr').value;
    await api('/users', {
      method: 'POST',
      body: JSON.stringify({
        name: document.getElementById('uName').value,
        email: document.getElementById('uEmail').value,
        password: document.getElementById('uPass').value,
        role: document.getElementById('uRole').value,
        managerId: managerId || null
      })
    });
    toast('User created');
    viewUsers();
  } catch (e) { toast(e.message); }
}

// ---------- Notifications ----------
async function refreshNotifs() {
  try {
    const n = await api('/notifications');
    const unread = n.filter((x) => !x.read).length;
    const b = document.getElementById('notifBadge');
    b.textContent = unread;
    b.classList.toggle('hidden', unread === 0);
  } catch { /* ignore */ }
}

// ---------- Wire up ----------
document.getElementById('loginBtn').onclick = () =>
  login(document.getElementById('email').value, document.getElementById('password').value)
    .catch((e) => (document.getElementById('loginErr').textContent = e.message));
document.querySelectorAll('.quick-grid button').forEach((b) => {
  b.onclick = () => { document.getElementById('email').value = b.dataset.email; login(b.dataset.email, 'password123'); };
});
document.getElementById('logout').onclick = logout;

// Signup toggles
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

window.act = act; window.decide = decide;
