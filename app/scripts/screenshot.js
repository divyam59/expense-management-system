/* Captures real UI screenshots of the running app into ../docs/screenshots. */
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

// Screenshots live with the technical-doc markdown source in the archive
// (self-projects/docs/screenshots) — the same place make-pdf.js reads them from.
const OUT = path.join(__dirname, '../../../docs/screenshots');
const BASE = 'http://localhost:4000';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(page, name) {
  await page.screenshot({ path: path.join(OUT, name) });
  // eslint-disable-next-line no-console
  console.log('captured', name);
}

async function quickLogin(page, email) {
  await page.waitForSelector(`.quick-grid button[data-email="${email}"]`, { visible: true });
  await page.click(`.quick-grid button[data-email="${email}"]`);
  await page.waitForSelector('#nav button', { visible: true });
  await sleep(600);
}

async function gotoView(page, view) {
  await page.click(`#nav button[data-view="${view}"]`);
  await sleep(800);
}

async function logout(page) {
  await page.click('#logout');
  await page.waitForSelector('#login:not(.hidden)', { visible: true });
  await sleep(400);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });

  // 1. Login screen
  await page.goto(BASE, { waitUntil: 'networkidle2' });
  await page.waitForSelector('#login');
  await shot(page, '01-login.png');

  // 2. Signup screen
  await page.click('#toSignup');
  await sleep(400);
  await shot(page, '02-signup.png');
  await page.click('#toLogin');
  await sleep(300);

  // 3. Employee expenses (Riya)
  await quickLogin(page, 'riya@acme.test');
  await sleep(600);
  await shot(page, '03-expenses-employee.png');

  // 4. Expense detail (open first row)
  await page.waitForSelector('button[data-exp]');
  await page.click('button[data-exp]');
  await sleep(700);
  await shot(page, '04-expense-detail.png');
  // detail is a modal overlay now — dismiss it before the logout button is clickable
  await page.keyboard.press('Escape');
  await sleep(400);
  await logout(page);

  // 5. Manager approvals queue
  await quickLogin(page, 'manager@acme.test');
  await gotoView(page, 'approvals');
  await shot(page, '05-approvals-manager.png');
  await logout(page);

  // 6. Finance dashboard (charts) + 7. policies
  await quickLogin(page, 'cfo@acme.test');
  await gotoView(page, 'dashboard');
  await sleep(1800); // let charts animate/render
  await shot(page, '06-dashboard.png');
  await gotoView(page, 'policies');
  await shot(page, '07-policies.png');
  await logout(page);

  // 8. Admin users (with create form)
  await quickLogin(page, 'admin@acme.test');
  await gotoView(page, 'users');
  await shot(page, '08-users.png');

  await browser.close();
  // eslint-disable-next-line no-console
  console.log('done ->', OUT);
})().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
