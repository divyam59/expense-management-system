// Renders docs/technical-documentation.md (with its screenshots) to a single PDF.
// Markdown -> HTML (marked) -> temp HTML in docs/ (so relative image paths
// resolve) -> Puppeteer prints to PDF -> temp HTML removed.
const fs = require('fs');
const path = require('path');
const { marked } = require('marked');
const puppeteer = require('puppeteer');

// Source markdown + screenshots live in the archive (self-projects/docs);
// the generated PDF deliverable is written into the clean project-ems/docs.
const srcDir = path.resolve(__dirname, '../../../docs');
const outDir = path.resolve(__dirname, '../../docs');
const mdPath = path.join(srcDir, 'technical-documentation.md');
const tmpHtmlPath = path.join(srcDir, '.tech-doc.tmp.html');
const pdfPath = path.join(outDir, 'technical-documentation.pdf');

const css = `
  @page { margin: 18mm 16mm; }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #1f2328; line-height: 1.55; font-size: 12px; max-width: 920px; margin: 0 auto;
  }
  h1 { font-size: 26px; border-bottom: 2px solid #d0d7de; padding-bottom: 8px; }
  h2 { font-size: 19px; border-bottom: 1px solid #d8dee4; padding-bottom: 5px; margin-top: 28px; }
  h3 { font-size: 15px; margin-top: 20px; }
  code { background: #f0f1f3; padding: 1px 5px; border-radius: 4px; font-size: 11px;
    font-family: "SF Mono", Menlo, Consolas, monospace; }
  pre { background: #0d1117; color: #e6edf3; padding: 12px 14px; border-radius: 8px;
    overflow-x: auto; font-size: 10.5px; line-height: 1.45; }
  pre code { background: transparent; color: inherit; padding: 0; }
  table { border-collapse: collapse; width: 100%; margin: 10px 0; font-size: 11px; }
  th, td { border: 1px solid #d0d7de; padding: 5px 9px; text-align: left; vertical-align: top; }
  th { background: #f6f8fa; }
  img { max-width: 100%; height: auto; border: 1px solid #d0d7de; border-radius: 8px;
    margin: 8px 0 4px; display: block; }
  hr { border: none; border-top: 1px solid #d8dee4; margin: 22px 0; }
  a { color: #0969da; text-decoration: none; }
  blockquote { color: #57606a; border-left: 3px solid #d0d7de; margin: 0; padding: 0 12px; }
`;

(async () => {
  const md = fs.readFileSync(mdPath, 'utf8');
  const bodyHtml = marked.parse(md);
  const html = `<!doctype html><html><head><meta charset="utf-8">
    <style>${css}</style></head><body>${bodyHtml}</body></html>`;
  fs.writeFileSync(tmpHtmlPath, html);

  const browser = await puppeteer.launch({ headless: 'new' });
  try {
    const page = await browser.newPage();
    await page.goto('file://' + tmpHtmlPath, { waitUntil: 'networkidle0' });
    await page.pdf({
      path: pdfPath,
      format: 'A4',
      printBackground: true,
      margin: { top: '0', bottom: '0', left: '0', right: '0' },
    });
    console.log('PDF written:', pdfPath);
  } finally {
    await browser.close();
    fs.unlinkSync(tmpHtmlPath);
  }
})().catch((e) => { console.error(e); process.exit(1); });
