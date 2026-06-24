/* Captures real UI screenshots of the running app into ../docs/screenshots. */
const puppeteer = require('puppeteer');
const path = require('path');
const os = require('os');
const fs = require('fs');

const RECEIPT_PATH = path.join(os.tmpdir(), 'ems-sample-receipt.png');

// Render a realistic-looking receipt to a PNG so the bill-upload screenshot
// shows a believable thumbnail (rather than a 1x1 placeholder).
async function makeReceiptPng(browser) {
  const p = await browser.newPage();
  await p.setViewport({ width: 360, height: 520, deviceScaleFactor: 2 });
  await p.setContent(`<html><body style="margin:0">
    <div style="width:360px;font-family:'Courier New',monospace;padding:26px;background:#fff;color:#111">
      <h2 style="text-align:center;margin:0">ACME BISTRO</h2>
      <div style="text-align:center;font-size:12px;color:#555;margin-bottom:8px">Tax Invoice / Receipt</div>
      <hr/>
      <div style="font-size:13px;line-height:1.9">Date: 2026-06-24 &nbsp; 20:42<br/>Table 7 · 4 Guests</div>
      <hr/>
      <table style="width:100%;font-size:13px;line-height:1.9">
        <tr><td>Paneer Tikka</td><td style="text-align:right">420</td></tr>
        <tr><td>Dal Makhani</td><td style="text-align:right">380</td></tr>
        <tr><td>Garlic Naan x4</td><td style="text-align:right">240</td></tr>
        <tr><td>Beverages</td><td style="text-align:right">560</td></tr>
      </table>
      <hr/>
      <table style="width:100%;font-size:13px;line-height:1.9">
        <tr><td>Subtotal</td><td style="text-align:right">1600</td></tr>
        <tr><td>GST 5%</td><td style="text-align:right">80</td></tr>
        <tr><td>Service</td><td style="text-align:right">170</td></tr>
      </table>
      <hr/>
      <div style="display:flex;justify-content:space-between;font-weight:bold;font-size:17px"><span>TOTAL</span><span>₹1850</span></div>
      <hr/>
      <div style="text-align:center;font-size:12px;color:#555">Thank you! Visit again</div>
    </div>
  </body></html>`);
  await p.screenshot({ path: RECEIPT_PATH });
  await p.close();
}

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
  await makeReceiptPng(browser);
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

  // 9. Bill upload — create a fresh draft, open it, attach a receipt image
  await page.type('#famount', '1850');
  await page.type('#fdesc', 'Client dinner — receipt attached');
  await page.click('#createBtn');
  await sleep(1000); // list refreshes; newest draft is the first row
  await page.click('button[data-exp]');
  await sleep(600);
  await page.click('#detailOverlay .tab[data-tab="bills"]');
  await sleep(300);
  const fileInput = await page.waitForSelector('#billFile');
  await fileInput.uploadFile(RECEIPT_PATH);
  await page.click('#detailOverlay .bill-upload button');
  await sleep(1500); // upload + re-render + thumbnail fetch
  await shot(page, '09-bill-upload.png');
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
