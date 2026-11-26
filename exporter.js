'use strict';
const ExcelJS = require('exceljs');

function csvCell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return String(v);
  let s = v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;                 // neutralise spreadsheet formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** columns: [{key, header, type?: 'number'|'money'}] */
function toCsv(columns, rows) {
  const head = columns.map((c) => csvCell(c.header)).join(',');
  const body = rows.map((r) => columns.map((c) => csvCell(r[c.key])).join(','));
  return `﻿${[head, ...body].join('\r\n')}\r\n`;   // BOM so Excel opens ₹ and Hindi text correctly
}

async function toXlsx(sheetName, columns, rows, { title } = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Bhookzy';
  const ws = wb.addWorksheet(sheetName.slice(0, 30), { views: [{ state: 'frozen', ySplit: title ? 2 : 1 }] });
  if (title) { ws.addRow([title]).font = { bold: true, size: 13 }; }
  ws.columns = columns.map((c) => ({ key: c.key, width: c.width || Math.max(12, c.header.length + 2) }));
  const header = ws.addRow(columns.map((c) => c.header));
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF141518' } };
  for (const r of rows) ws.addRow(columns.map((c) => r[c.key] ?? null));
  columns.forEach((c, i) => { if (c.type === 'money') ws.getColumn(i + 1).numFmt = '"₹"#,##0'; });
  return wb.xlsx.writeBuffer();
}

module.exports = { toCsv, toXlsx, csvCell };
