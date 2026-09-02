/**
 * Render a markdown doc to PDF via Playwright's print engine.
 *
 *   node docs/make-pdf.mjs docs/PITCH.md docs/PITCH.pdf
 *
 * Deliberately a tiny hand-rolled renderer rather than a markdown library: the
 * documents here use a small, known subset (headings, tables, code, blockquotes,
 * emphasis, rules), and a dependency for that would be more surface than it saves.
 *
 * Print styling is the point. A pitch script is read off a second screen or a
 * printout while recording, so: high contrast, generous line height, spoken lines
 * visually distinct from stage directions, and no page break inside a beat.
 */

import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';

import { chromium } from 'playwright';

const [, , inputPath, outputPath] = process.argv;
if (!inputPath || !outputPath) {
  console.error('usage: node docs/make-pdf.mjs <input.md> <output.pdf>');
  process.exit(1);
}

const escapeHtml = (text) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Inline formatting: code, bold, italic, links. Applied after escaping. */
function inline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

function renderTable(rows) {
  const cells = (line) =>
    line.replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
  const header = cells(rows[0]);
  const body = rows.slice(2).map(cells);
  return [
    '<table><thead><tr>',
    header.map((h) => `<th>${inline(h)}</th>`).join(''),
    '</tr></thead><tbody>',
    body
      .map((row) => `<tr>${row.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
      .join(''),
    '</tbody></table>',
  ].join('');
}

function markdownToHtml(markdown) {
  const lines = markdown.split('\n');
  const out = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (line.startsWith('```')) {
      const code = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith('```')) {
        code.push(lines[index]);
        index += 1;
      }
      index += 1;
      out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }

    if (line.startsWith('|')) {
      const rows = [];
      while (index < lines.length && lines[index].startsWith('|')) {
        rows.push(lines[index]);
        index += 1;
      }
      out.push(rows.length >= 2 ? renderTable(rows) : '');
      continue;
    }

    if (line.startsWith('> ')) {
      const quote = [];
      while (index < lines.length && (lines[index].startsWith('> ') || lines[index] === '>')) {
        quote.push(lines[index].replace(/^> ?/, ''));
        index += 1;
      }
      // Spoken lines. These are what you read aloud, so they get the strongest
      // visual treatment on the page.
      out.push(`<blockquote>${quote.map((l) => inline(l)).join(' ')}</blockquote>`);
      continue;
    }

    const heading = /^(#{1,4}) (.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      // Each timed beat starts a new block that must not split across pages.
      const isBeat = level === 2 && /^\d+:\d\d/.test(heading[2]);
      out.push(`<h${level}${isBeat ? ' class="beat"' : ''}>${inline(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^[-*] /.test(line)) {
      const items = [];
      while (index < lines.length && /^[-*] /.test(lines[index])) {
        items.push(`<li>${inline(lines[index].slice(2))}</li>`);
        index += 1;
      }
      out.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    if (/^\d+\. /.test(line)) {
      const items = [];
      while (index < lines.length && /^\d+\. /.test(lines[index])) {
        items.push(`<li>${inline(lines[index].replace(/^\d+\. /, ''))}</li>`);
        index += 1;
      }
      out.push(`<ol>${items.join('')}</ol>`);
      continue;
    }

    if (line.trim() === '---') {
      out.push('<hr>');
      index += 1;
      continue;
    }

    if (line.trim() === '') {
      index += 1;
      continue;
    }

    // Italic-only lines are stage directions: what to do with the mouse, where to
    // point. Set apart from spoken lines so they are never read aloud by mistake.
    const direction = /^\*(.+)\*$/.exec(line.trim());
    if (direction) {
      out.push(`<p class="direction">${inline(direction[1])}</p>`);
      index += 1;
      continue;
    }

    const paragraph = [];
    while (index < lines.length && lines[index].trim() !== '' && !/^[#>|`-]/.test(lines[index])) {
      paragraph.push(lines[index]);
      index += 1;
    }
    if (paragraph.length) out.push(`<p>${inline(paragraph.join(' '))}</p>`);
    else index += 1;
  }

  return out.join('\n');
}

const CSS = `
  @page { size: A4; margin: 18mm 16mm; }
  * { box-sizing: border-box; }
  body {
    font: 11pt/1.55 -apple-system, "Segoe UI", Roboto, sans-serif;
    color: #1a1a1a;
    margin: 0;
  }
  h1 { font-size: 21pt; margin: 0 0 4pt; letter-spacing: -0.01em; }
  h2 { font-size: 13pt; margin: 20pt 0 7pt; padding-bottom: 3pt; border-bottom: 1.5pt solid #1a1a1a; }
  h2.beat { color: #0b5cad; border-bottom-color: #0b5cad; }
  h3 { font-size: 11pt; margin: 13pt 0 5pt; }
  p { margin: 0 0 7pt; }
  hr { border: 0; border-top: 0.5pt solid #d4d4d4; margin: 14pt 0; }

  /* Spoken lines — the words you actually say. */
  blockquote {
    margin: 8pt 0;
    padding: 8pt 12pt;
    border-left: 3pt solid #0b5cad;
    background: #f2f7fc;
    font-size: 12pt;
    line-height: 1.6;
  }

  /* Stage directions — never read these aloud. */
  p.direction {
    margin: 6pt 0;
    padding-left: 12pt;
    color: #6a6a6a;
    font-style: italic;
    font-size: 10pt;
  }

  code {
    font-family: ui-monospace, "SF Mono", Consolas, monospace;
    font-size: 9.5pt;
    background: #f0f0f0;
    padding: 1pt 3pt;
    border-radius: 2pt;
  }
  pre {
    background: #f7f7f7;
    border: 0.5pt solid #dcdcdc;
    border-radius: 3pt;
    padding: 8pt 10pt;
    margin: 8pt 0;
    overflow-x: auto;
  }
  pre code { background: none; padding: 0; font-size: 9.5pt; line-height: 1.45; }

  table { width: 100%; border-collapse: collapse; margin: 8pt 0; font-size: 9.5pt; }
  th {
    text-align: left;
    background: #f0f0f0;
    padding: 5pt 7pt;
    border: 0.5pt solid #d4d4d4;
    font-weight: 600;
  }
  td { padding: 5pt 7pt; border: 0.5pt solid #d4d4d4; vertical-align: top; }

  ul, ol { margin: 6pt 0; padding-left: 20pt; }
  li { margin-bottom: 3pt; }
  a { color: #0b5cad; text-decoration: none; }
  strong { font-weight: 650; }

  /* A beat should never straddle a page break while you are reading it aloud. */
  h2, h3 { break-after: avoid; page-break-after: avoid; }
  blockquote, pre, table { break-inside: avoid; page-break-inside: avoid; }
`;

const markdown = readFileSync(resolve(inputPath), 'utf8');
const html = `<!doctype html><meta charset="utf-8"><style>${CSS}</style>${markdownToHtml(markdown)}`;

const temporaryHtml = resolve(outputPath.replace(/\.pdf$/, '.tmp.html'));
writeFileSync(temporaryHtml, html, 'utf8');

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`file://${temporaryHtml.replace(/\\/g, '/')}`, { waitUntil: 'load' });
await page.pdf({
  path: resolve(outputPath),
  format: 'A4',
  printBackground: true,
  displayHeaderFooter: true,
  headerTemplate: '<div></div>',
  footerTemplate:
    '<div style="width:100%;font-size:8pt;color:#8a8a8a;padding:0 16mm;text-align:right;">' +
    '<span class="pageNumber"></span> / <span class="totalPages"></span></div>',
  margin: { top: '18mm', bottom: '16mm', left: '16mm', right: '16mm' },
});
await browser.close();
if (!process.env.PRESERVE_HTML) unlinkSync(temporaryHtml);

console.log(`wrote ${outputPath}`);
