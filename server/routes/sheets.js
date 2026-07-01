// Spreadsheet data bridge for the in-panel Univer editor.
//
// Univer's OSS build has no xlsx import/export, so we do the file <-> data
// conversion here with exceljs (MIT). The client (public/univer-sheet.html)
// fetches a plain JSON model, edits it in Univer, and posts it back.
//
// Model shape (kept deliberately simple):
//   { ok:true, name, sheets: [ { name, rows: [ [ cell, cell, … ], … ] } ] }
//   cell = string | number | boolean | null   (formatted display values)
//
// exceljs is imported lazily so the (multi-MB) library only loads when a
// spreadsheet is actually opened for editing.

import fs from 'fs';
import path from 'path';
import os from 'os';

const EDITABLE = new Set(['.xlsx', '.xlsm', '.xls']);

function _resolveAbs(p) {
  if (!p) return '';
  return path.isAbsolute(p) ? p : path.join(os.homedir(), p);
}

function _cellOut(value) {
  if (value === null || value === undefined) return null;
  // exceljs rich values → plain display text.
  if (typeof value === 'object') {
    if (value.text !== undefined) return String(value.text);
    if (value.result !== undefined) return value.result;      // formula result
    if (value.formula !== undefined) return '=' + value.formula;
    if (value.richText) return value.richText.map(function (r) { return r.text; }).join('');
    if (value instanceof Date) return value.toISOString();
    if (value.hyperlink !== undefined) return String(value.text || value.hyperlink);
    return String(value);
  }
  return value;
}

export function registerSheetRoutes(app) {
  // GET ?path=<file> → JSON model of the workbook for editing.
  app.get('/api/sheet-data', async (req, res) => {
    const abs = _resolveAbs(req.query.path ? String(req.query.path) : '');
    if (!abs) return res.status(400).json({ ok: false, error: 'path required' });
    if (!fs.existsSync(abs)) return res.status(404).json({ ok: false, error: 'File not found' });
    if (!EDITABLE.has(path.extname(abs).toLowerCase())) {
      return res.status(415).json({ ok: false, error: 'Only .xlsx/.xlsm/.xls are editable here' });
    }
    try {
      const ExcelJS = (await import('exceljs')).default;
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(abs);
      const sheets = [];
      wb.eachSheet(function (ws) {
        const rows = [];
        const rowCount = Math.max(ws.rowCount || 0, 1);
        const colCount = Math.max(ws.columnCount || 0, 1);
        for (let r = 1; r <= rowCount; r++) {
          const row = ws.getRow(r);
          const cells = [];
          for (let c = 1; c <= colCount; c++) {
            cells.push(_cellOut(row.getCell(c).value));
          }
          rows.push(cells);
        }
        sheets.push({ name: ws.name || ('Sheet' + (sheets.length + 1)), rows: rows });
      });
      if (!sheets.length) sheets.push({ name: 'Sheet1', rows: [[null]] });
      res.json({ ok: true, name: path.basename(abs), sheets: sheets });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });

  // POST { path, sheets:[{name, rows:[[cell,…]]}] } → overwrite the .xlsx.
  app.post('/api/sheet-write', async (req, res) => {
    const { path: p, sheets } = req.body || {};
    const abs = _resolveAbs(p ? String(p) : '');
    if (!abs) return res.status(400).json({ ok: false, error: 'path required' });
    if (!Array.isArray(sheets)) return res.status(400).json({ ok: false, error: 'sheets array required' });
    if (!fs.existsSync(abs)) return res.status(404).json({ ok: false, error: 'File not found' });
    if (!EDITABLE.has(path.extname(abs).toLowerCase())) {
      return res.status(415).json({ ok: false, error: 'Only .xlsx/.xlsm/.xls are editable here' });
    }
    try {
      const ExcelJS = (await import('exceljs')).default;
      const wb = new ExcelJS.Workbook();
      sheets.forEach(function (s, i) {
        const ws = wb.addWorksheet(String((s && s.name) || ('Sheet' + (i + 1))).slice(0, 31) || ('Sheet' + (i + 1)));
        const rows = (s && Array.isArray(s.rows)) ? s.rows : [];
        rows.forEach(function (cells, ri) {
          if (!Array.isArray(cells)) return;
          const row = ws.getRow(ri + 1);
          cells.forEach(function (val, ci) {
            if (val === null || val === undefined || val === '') return;
            const cell = row.getCell(ci + 1);
            if (typeof val === 'string' && val.charAt(0) === '=') {
              cell.value = { formula: val.slice(1) };
            } else {
              cell.value = val;
            }
          });
          row.commit && row.commit();
        });
      });
      if (!wb.worksheets.length) wb.addWorksheet('Sheet1');
      await wb.xlsx.writeFile(abs);
      res.json({ ok: true, path: abs });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });
}
