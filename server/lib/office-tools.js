// Office document tools: render-to-PNG, path-based get/set, issue scanning,
// and template merge.  All manipulation runs through Python (python-pptx /
// python-docx / openpyxl) so no LibreOffice dependency is needed for edits.
// Render-to-PNG uses the existing LibreOffice PDF pipeline + pdftoppm.
//
// Path syntax (mirrors OfficeCLI conventions, 1-based):
//   PPTX: /               → root (slide list)
//         /slide[N]       → slide N
//         /slide[N]/shape[M]          → shape M on slide N (1-based)
//         /slide[N]/shape[@name=Foo]  → shape by name
//   DOCX: /               → root stats
//         /body           → list body elements
//         /body/p[N]      → paragraph N (1-based)
//         /body/tbl[N]    → table N
//   XLSX: /               → sheet list
//         /SheetName      → sheet stats
//         /SheetName/A1   → cell A1
//         /SheetName/row[N] → row N

import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import { buildShellEnv } from './shell-env.js';
import { renderOfficeToPdf, isOfficeRenderable } from './office-render.js';

const { augmentedPath: AUGMENTED_PATH } = buildShellEnv(process.platform === 'win32');
const EXEC_ENV = { ...process.env, PATH: AUGMENTED_PATH };

// ── Python runner ──────────────────────────────────────────────────────────

/** Spawn python3 with a script string. stdin = optional input string.
 *  Resolves with the parsed JSON output or {ok:false, error}. */
async function _runPy(script, args = [], input = undefined, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('python3', ['-c', script, ...args], { env: EXEC_ENV });
    } catch (e) {
      resolve({ ok: false, error: 'python3 not available: ' + e.message });
      return;
    }
    let stdout = '', stderr = '', settled = false;
    const MAX_BUF = 8 * 1024 * 1024;
    const finish = (v) => { if (settled) return; settled = true; clearTimeout(timer); resolve(v); };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      finish({ ok: false, error: 'python timed out after ' + timeoutMs + 'ms' });
    }, timeoutMs);
    child.stdout.on('data', d => {
      stdout += d;
      if (stdout.length > MAX_BUF) { try { child.kill('SIGKILL'); } catch (_) {} finish({ ok: false, error: 'output too large' }); }
    });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', e => finish({ ok: false, error: e.message }));
    child.on('close', () => {
      let parsed = null;
      try { parsed = JSON.parse(stdout.trim()); } catch (_) {}
      finish(parsed || { ok: false, error: (stderr || 'no JSON output').slice(0, 400) });
    });
    if (input !== undefined) { try { child.stdin.write(String(input)); } catch (_) {} }
    try { child.stdin.end(); } catch (_) {}
  });
}

// ── Python scripts ─────────────────────────────────────────────────────────
// Note: no backtick characters inside these strings — they are embedded in JS
// template literals. Single quotes only in Python.

const _GET_PY = `
import sys, json, re, os

def parse_path(p):
    parts = []
    for seg in p.strip('/').split('/'):
        if not seg:
            continue
        m = re.match(r'^([\\w .]+)\\[(\\d+)\\]$', seg)
        if m:
            parts.append((m.group(1), int(m.group(2)), None)); continue
        m2 = re.match(r'^([\\w .]+)\\[@(\\w+)=(.+)\\]$', seg)
        if m2:
            parts.append((m2.group(1), None, (m2.group(2), m2.group(3)))); continue
        parts.append((seg, None, None))
    return parts

fp = sys.argv[1]
doc_path = sys.argv[2] if len(sys.argv) > 2 else '/'
ext = os.path.splitext(fp)[1].lower()
parts = parse_path(doc_path)

try:
    if ext == '.pptx':
        from pptx import Presentation
        prs = Presentation(fp)
        if not parts:
            slides_info = []
            for i, slide in enumerate(prs.slides):
                titles = [s.text_frame.text.strip() for s in slide.shapes if s.has_text_frame and s.name.lower().startswith('title')]
                slides_info.append({'index': i+1, 'title': titles[0] if titles else '', 'shape_count': len(slide.shapes)})
            print(json.dumps({'ok': True, 'format': 'pptx', 'slide_count': len(prs.slides), 'slides': slides_info}))
        elif parts[0][0] == 'slide':
            si = (parts[0][1] or 1) - 1
            if si >= len(prs.slides):
                print(json.dumps({'ok': False, 'code': 'not_found', 'error': f'Slide {si+1} not found (total: {len(prs.slides)})', 'suggestion': f'Valid slide range: 1-{len(prs.slides)}'})); sys.exit(0)
            slide = prs.slides[si]
            if len(parts) == 1:
                shapes_info = []
                for j, s in enumerate(slide.shapes):
                    info = {'index': j+1, 'name': s.name, 'shape_type': str(s.shape_type).split('.')[-1]}
                    if s.has_text_frame: info['text'] = s.text_frame.text
                    if hasattr(s, 'left') and s.left is not None:
                        info['x'] = s.left; info['y'] = s.top; info['width'] = s.width; info['height'] = s.height
                    shapes_info.append(info)
                print(json.dumps({'ok': True, 'path': doc_path, 'slide': si+1, 'shapes': shapes_info}))
            elif parts[1][0] == 'shape':
                shapes = list(slide.shapes)
                if parts[1][2]:
                    attr, val = parts[1][2]
                    shape = next((s for s in shapes if s.name == val), None) if attr == 'name' else None
                    if shape is None:
                        print(json.dumps({'ok': False, 'code': 'not_found', 'error': f'No shape with {attr}={val}', 'suggestion': f'Available names: {[s.name for s in shapes[:8]]}'})); sys.exit(0)
                else:
                    shi = (parts[1][1] or 1) - 1
                    if shi >= len(shapes):
                        print(json.dumps({'ok': False, 'code': 'not_found', 'error': f'Shape {shi+1} not found (total: {len(shapes)})', 'suggestion': f'Valid shape range: 1-{len(shapes)}'})); sys.exit(0)
                    shape = shapes[shi]
                info = {'name': shape.name, 'shape_type': str(shape.shape_type).split('.')[-1],
                        'x': shape.left, 'y': shape.top, 'width': shape.width, 'height': shape.height}
                if shape.has_text_frame:
                    info['text'] = shape.text_frame.text
                    info['paragraphs'] = [p.text for p in shape.text_frame.paragraphs]
                    try:
                        r0 = shape.text_frame.paragraphs[0].runs[0] if shape.text_frame.paragraphs and shape.text_frame.paragraphs[0].runs else None
                        if r0: info['font'] = {'bold': r0.font.bold, 'italic': r0.font.italic, 'size_pt': round(r0.font.size.pt, 1) if r0.font.size else None}
                    except Exception: pass
                print(json.dumps({'ok': True, 'path': doc_path, **info}))
            else:
                print(json.dumps({'ok': False, 'code': 'invalid_path', 'error': f'Unknown segment: {parts[1][0]}', 'suggestion': 'Use /slide[N]/shape[M]'}))
        else:
            print(json.dumps({'ok': False, 'code': 'invalid_path', 'error': 'PPTX paths start with / or /slide[N]', 'suggestion': 'Use / (root), /slide[N], /slide[N]/shape[M]'}))

    elif ext == '.docx':
        from docx import Document
        doc = Document(fp)
        if not parts:
            print(json.dumps({'ok': True, 'format': 'docx', 'paragraph_count': len(doc.paragraphs), 'table_count': len(doc.tables)}))
        elif parts[0][0] == 'body':
            if len(parts) == 1:
                elems = []
                for i, p in enumerate(doc.paragraphs[:30]):
                    elems.append({'index': i+1, 'type': 'paragraph', 'style': p.style.name, 'text': p.text[:80]})
                for i, t in enumerate(doc.tables):
                    elems.append({'type': 'table', 'index': i+1, 'rows': len(t.rows), 'cols': len(t.columns)})
                print(json.dumps({'ok': True, 'path': doc_path, 'elements': elems}))
            elif parts[1][0] in ('p', 'para', 'paragraph'):
                pi = (parts[1][1] or 1) - 1
                paras = doc.paragraphs
                if pi >= len(paras):
                    print(json.dumps({'ok': False, 'code': 'not_found', 'error': f'Paragraph {pi+1} not found (total: {len(paras)})', 'suggestion': f'Valid range: 1-{len(paras)}'})); sys.exit(0)
                p = paras[pi]
                runs_info = [{'text': r.text, 'bold': r.bold, 'italic': r.italic} for r in p.runs]
                print(json.dumps({'ok': True, 'path': doc_path, 'index': pi+1, 'style': p.style.name, 'text': p.text, 'runs': runs_info}))
            elif parts[1][0] in ('tbl', 'table'):
                ti = (parts[1][1] or 1) - 1
                tables = doc.tables
                if ti >= len(tables):
                    print(json.dumps({'ok': False, 'code': 'not_found', 'error': f'Table {ti+1} not found (total: {len(tables)})', 'suggestion': f'Valid range: 1-{len(tables)}'})); sys.exit(0)
                tbl = tables[ti]
                rows_data = [[cell.text for cell in row.cells] for row in tbl.rows[:20]]
                print(json.dumps({'ok': True, 'path': doc_path, 'rows': len(tbl.rows), 'cols': len(tbl.columns), 'data': rows_data}))
            else:
                print(json.dumps({'ok': False, 'code': 'invalid_path', 'error': f'Unknown body child: {parts[1][0]}', 'suggestion': 'Use /body/p[N] or /body/tbl[N]'}))
        else:
            print(json.dumps({'ok': False, 'code': 'invalid_path', 'error': 'DOCX paths start with / or /body', 'suggestion': 'Use /, /body, /body/p[N], /body/tbl[N]'}))

    elif ext in ('.xlsx', '.xlsm', '.xls'):
        import openpyxl
        wb = openpyxl.load_workbook(fp, data_only=True)
        if not parts:
            print(json.dumps({'ok': True, 'format': 'xlsx', 'sheet_names': wb.sheetnames, 'sheet_count': len(wb.sheetnames)})); sys.exit(0)
        sn = parts[0][0]
        if sn.lower() == 'sheet' and parts[0][1] is not None:
            idx = parts[0][1] - 1
            if idx >= len(wb.sheetnames):
                print(json.dumps({'ok': False, 'code': 'not_found', 'error': f'Sheet index {idx+1} out of range', 'suggestion': f'Available: {wb.sheetnames}'})); sys.exit(0)
            ws = wb[wb.sheetnames[idx]]
        elif sn in wb.sheetnames:
            ws = wb[sn]
        else:
            match = next((n for n in wb.sheetnames if n.lower() == sn.lower()), None)
            if not match:
                print(json.dumps({'ok': False, 'code': 'not_found', 'error': f'Sheet "{sn}" not found', 'suggestion': f'Available: {wb.sheetnames}'})); sys.exit(0)
            ws = wb[match]
        if len(parts) == 1:
            print(json.dumps({'ok': True, 'sheet': ws.title, 'rows': ws.max_row or 0, 'cols': ws.max_column or 0}))
        else:
            seg2 = parts[1]
            if seg2[0].lower() == 'row' and seg2[1] is not None:
                ri = seg2[1]
                row_data = [{'col': ws.cell(row=ri, column=ci).column_letter, 'value': ws.cell(row=ri, column=ci).value} for ci in range(1, (ws.max_column or 0) + 1)]
                print(json.dumps({'ok': True, 'path': doc_path, 'row': ri, 'cells': row_data}))
            else:
                cell_ref = seg2[0].upper()
                try:
                    cell = ws[cell_ref]
                    print(json.dumps({'ok': True, 'path': doc_path, 'cell': cell_ref, 'value': cell.value, 'data_type': cell.data_type}))
                except Exception as e:
                    print(json.dumps({'ok': False, 'code': 'invalid_path', 'error': str(e)}))

    else:
        print(json.dumps({'ok': False, 'code': 'unsupported_format', 'error': f'Unsupported: {ext}', 'suggestion': 'Supported: .pptx, .docx, .xlsx'}))

except Exception as e:
    import traceback
    print(json.dumps({'ok': False, 'error': str(e), 'detail': traceback.format_exc()[-400:]}))
`.trim();

const _SET_PY = `
import sys, json, re, os

def parse_path(p):
    parts = []
    for seg in p.strip('/').split('/'):
        if not seg: continue
        m = re.match(r'^([\\w .]+)\\[(\\d+)\\]$', seg)
        if m:
            parts.append((m.group(1), int(m.group(2)), None)); continue
        m2 = re.match(r'^([\\w .]+)\\[@(\\w+)=(.+)\\]$', seg)
        if m2:
            parts.append((m2.group(1), None, (m2.group(2), m2.group(3)))); continue
        parts.append((seg, None, None))
    return parts

fp = sys.argv[1]
doc_path = sys.argv[2] if len(sys.argv) > 2 else '/'
ext = os.path.splitext(fp)[1].lower()
parts = parse_path(doc_path)
props_json = sys.stdin.read()

try:
    props = json.loads(props_json) if props_json.strip() else {}
except Exception as e:
    print(json.dumps({'ok': False, 'error': 'Invalid props JSON: ' + str(e)})); sys.exit(0)

try:
    if ext == '.pptx':
        from pptx import Presentation
        from pptx.util import Pt
        from pptx.dml.color import RGBColor
        prs = Presentation(fp)
        if len(parts) >= 2 and parts[0][0] == 'slide' and parts[1][0] == 'shape':
            si = (parts[0][1] or 1) - 1
            if si >= len(prs.slides):
                print(json.dumps({'ok': False, 'code': 'not_found', 'error': f'Slide {si+1} not found (total: {len(prs.slides)})'})); sys.exit(0)
            shapes = list(prs.slides[si].shapes)
            if parts[1][2]:
                attr, val = parts[1][2]
                shape = next((s for s in shapes if s.name == val), None)
            else:
                shi = (parts[1][1] or 1) - 1
                if shi >= len(shapes):
                    print(json.dumps({'ok': False, 'code': 'not_found', 'error': f'Shape {shi+1} not found (total: {len(shapes)})'})); sys.exit(0)
                shape = shapes[shi]
            if shape is None:
                print(json.dumps({'ok': False, 'code': 'not_found', 'error': 'Shape not found'})); sys.exit(0)
            changed = []
            if 'text' in props and shape.has_text_frame:
                tf = shape.text_frame
                paras = str(props['text']).split('\\n')
                tf.text = paras[0]
                for extra in paras[1:]:
                    p = tf.add_paragraph(); p.text = extra
                changed.append('text')
            if 'font_size' in props and shape.has_text_frame:
                sz = Pt(float(props['font_size']))
                for para in shape.text_frame.paragraphs:
                    for run in para.runs: run.font.size = sz
                changed.append('font_size')
            if 'bold' in props and shape.has_text_frame:
                b = bool(props['bold'])
                for para in shape.text_frame.paragraphs:
                    for run in para.runs: run.font.bold = b
                changed.append('bold')
            if 'italic' in props and shape.has_text_frame:
                it = bool(props['italic'])
                for para in shape.text_frame.paragraphs:
                    for run in para.runs: run.font.italic = it
                changed.append('italic')
            if 'color' in props and shape.has_text_frame:
                hx = str(props['color']).lstrip('#').upper()
                if len(hx) == 6:
                    rgb = RGBColor(int(hx[0:2],16), int(hx[2:4],16), int(hx[4:6],16))
                    for para in shape.text_frame.paragraphs:
                        for run in para.runs: run.font.color.rgb = rgb
                    changed.append('color')
            prs.save(fp)
            print(json.dumps({'ok': True, 'path': doc_path, 'changed': changed}))
        else:
            print(json.dumps({'ok': False, 'code': 'invalid_path', 'error': 'PPTX set requires /slide[N]/shape[M] path'}))

    elif ext == '.docx':
        from docx import Document
        doc = Document(fp)
        if len(parts) >= 2 and parts[0][0] == 'body' and parts[1][0] in ('p', 'para', 'paragraph'):
            pi = (parts[1][1] or 1) - 1
            paras = doc.paragraphs
            if pi >= len(paras):
                print(json.dumps({'ok': False, 'code': 'not_found', 'error': f'Paragraph {pi+1} not found (total: {len(paras)})'})); sys.exit(0)
            p = paras[pi]; changed = []
            if 'text' in props:
                for run in p.runs: run.text = ''
                if p.runs: p.runs[0].text = str(props['text'])
                else: p.add_run(str(props['text']))
                changed.append('text')
            if 'bold' in props:
                for run in p.runs: run.bold = bool(props['bold'])
                changed.append('bold')
            if 'style' in props:
                try: p.style = doc.styles[props['style']]; changed.append('style')
                except Exception: pass
            doc.save(fp)
            print(json.dumps({'ok': True, 'path': doc_path, 'changed': changed}))
        else:
            print(json.dumps({'ok': False, 'code': 'invalid_path', 'error': 'DOCX set requires /body/p[N] path'}))

    elif ext in ('.xlsx', '.xlsm'):
        import openpyxl
        wb = openpyxl.load_workbook(fp)
        if len(parts) >= 2:
            sn = parts[0][0]
            ws = wb[sn] if sn in wb.sheetnames else wb[next((n for n in wb.sheetnames if n.lower() == sn.lower()), wb.sheetnames[0])]
            cell_ref = parts[1][0].upper()
            changed = []
            if 'value' in props:
                ws[cell_ref] = props['value']; changed.append('value')
            elif 'formula' in props:
                ws[cell_ref] = str(props['formula']); changed.append('formula')
            wb.save(fp)
            print(json.dumps({'ok': True, 'path': doc_path, 'changed': changed}))
        else:
            print(json.dumps({'ok': False, 'code': 'invalid_path', 'error': 'XLSX set requires /SheetName/CellRef path'}))

    else:
        print(json.dumps({'ok': False, 'code': 'unsupported_format', 'error': f'Unsupported: {ext}'}))

except Exception as e:
    import traceback
    print(json.dumps({'ok': False, 'error': str(e), 'detail': traceback.format_exc()[-400:]}))
`.trim();

const _ISSUES_PY = `
import sys, json, os

fp = sys.argv[1]
ext = os.path.splitext(fp)[1].lower()
issues = []

try:
    if ext == '.pptx':
        from pptx import Presentation
        prs = Presentation(fp)
        SW = prs.slide_width; SH = prs.slide_height
        for si, slide in enumerate(prs.slides):
            has_content = False
            for shape in slide.shapes:
                if shape.has_text_frame and shape.text_frame.text.strip():
                    has_content = True
                    if len(shape.text_frame.text) > 600:
                        issues.append({'type': 'long_text', 'slide': si+1, 'shape': shape.name,
                                       'message': f'Slide {si+1}: shape "{shape.name}" has {len(shape.text_frame.text)} chars — may overflow'})
                elif shape.has_text_frame and not shape.text_frame.text.strip():
                    issues.append({'type': 'empty_shape', 'slide': si+1, 'shape': shape.name,
                                   'message': f'Slide {si+1}: shape "{shape.name}" is an empty text frame'})
                if hasattr(shape, 'left') and shape.left is not None:
                    margin = 91440  # 0.1 cm in EMU
                    if shape.left + shape.width > SW + margin or shape.top + shape.height > SH + margin:
                        issues.append({'type': 'out_of_bounds', 'slide': si+1, 'shape': shape.name,
                                       'message': f'Slide {si+1}: shape "{shape.name}" extends outside slide boundary'})
                try:
                    from pptx.enum.shapes import MSO_SHAPE_TYPE
                    if shape.shape_type == MSO_SHAPE_TYPE.PICTURE and not shape.name.strip():
                        issues.append({'type': 'missing_alt_text', 'slide': si+1,
                                       'message': f'Slide {si+1}: an image shape has no name/alt text'})
                except Exception:
                    pass
            if not has_content:
                issues.append({'type': 'empty_slide', 'slide': si+1, 'message': f'Slide {si+1}: no text content found'})

    elif ext == '.docx':
        from docx import Document
        doc = Document(fp)
        empty_run = 0
        for i, p in enumerate(doc.paragraphs):
            if len(p.text) > 800:
                issues.append({'type': 'long_paragraph', 'paragraph': i+1,
                               'message': f'Paragraph {i+1}: {len(p.text)} chars — consider splitting'})
            if not p.text.strip():
                empty_run += 1
                if empty_run == 6:
                    issues.append({'type': 'excessive_empty_paragraphs', 'paragraph': i+1,
                                   'message': f'6+ consecutive empty paragraphs at paragraph {i+1}'})
            else:
                empty_run = 0

    elif ext in ('.xlsx', '.xlsm'):
        import openpyxl
        wb = openpyxl.load_workbook(fp, data_only=True)
        ERROR_VALS = {'#VALUE!', '#REF!', '#N/A', '#DIV/0!', '#NAME?', '#NULL!', '#NUM!'}
        for ws in wb.worksheets:
            for row in ws.iter_rows():
                for cell in row:
                    if str(cell.value) in ERROR_VALS:
                        issues.append({'type': 'formula_error', 'sheet': ws.title, 'cell': cell.coordinate,
                                       'error_value': str(cell.value),
                                       'message': f'{ws.title}!{cell.coordinate}: formula error {cell.value}'})

    else:
        issues.append({'type': 'info', 'message': f'Issue scanning not yet supported for {ext}'})

    print(json.dumps({'ok': True, 'issue_count': len(issues), 'issues': issues}))

except Exception as e:
    import traceback
    print(json.dumps({'ok': False, 'error': str(e), 'detail': traceback.format_exc()[-400:]}))
`.trim();

const _MERGE_PY = `
import sys, json, re, os

fp_src = sys.argv[1]
fp_dst = sys.argv[2]
ext = os.path.splitext(fp_src)[1].lower()
data_json = sys.stdin.read()

try:
    data = json.loads(data_json)
except Exception as e:
    print(json.dumps({'ok': False, 'error': 'Invalid data JSON: ' + str(e)})); sys.exit(0)

def replace(text, data):
    return re.sub(r'\\{\\{([^}]+)\\}\\}', lambda m: str(data.get(m.group(1).strip(), m.group(0))), text)

replaced = 0

try:
    if ext == '.pptx':
        from pptx import Presentation
        prs = Presentation(fp_src)
        for slide in prs.slides:
            for shape in slide.shapes:
                if shape.has_text_frame:
                    for para in shape.text_frame.paragraphs:
                        for run in para.runs:
                            new = replace(run.text, data)
                            if new != run.text:
                                run.text = new; replaced += 1
        prs.save(fp_dst)
        print(json.dumps({'ok': True, 'src': fp_src, 'dst': fp_dst, 'replacements': replaced}))

    elif ext == '.docx':
        from docx import Document
        doc = Document(fp_src)
        def proc(paras):
            global replaced
            for p in paras:
                for r in p.runs:
                    new = replace(r.text, data)
                    if new != r.text:
                        r.text = new; replaced += 1
        proc(doc.paragraphs)
        for tbl in doc.tables:
            for row in tbl.rows:
                for cell in row.cells: proc(cell.paragraphs)
        for section in doc.sections:
            try: proc(section.header.paragraphs); proc(section.footer.paragraphs)
            except Exception: pass
        doc.save(fp_dst)
        print(json.dumps({'ok': True, 'src': fp_src, 'dst': fp_dst, 'replacements': replaced}))

    elif ext in ('.xlsx', '.xlsm'):
        import openpyxl
        wb = openpyxl.load_workbook(fp_src)
        for ws in wb.worksheets:
            for row in ws.iter_rows():
                for cell in row:
                    if isinstance(cell.value, str) and '{{' in cell.value:
                        new = replace(cell.value, data)
                        if new != cell.value:
                            cell.value = new; replaced += 1
        wb.save(fp_dst)
        print(json.dumps({'ok': True, 'src': fp_src, 'dst': fp_dst, 'replacements': replaced}))

    else:
        print(json.dumps({'ok': False, 'code': 'unsupported_format', 'error': f'Unsupported: {ext}', 'suggestion': 'Supported: .pptx, .docx, .xlsx'}))

except Exception as e:
    import traceback
    print(json.dumps({'ok': False, 'error': str(e), 'detail': traceback.format_exc()[-400:]}))
`.trim();

// ── PDF → PNG conversion ────────────────────────────────────────────────────

/**
 * Convert a PDF to per-page PNG files using pdftoppm (poppler).
 * @param {string} pdfPath
 * @param {string} outDir   directory to write page-*.png files
 * @param {{first?:number, last?:number, dpi?:number}} opts
 * @returns {Promise<string[]>} sorted absolute PNG paths
 */
async function _pdfToPngs(pdfPath, outDir, { first = null, last = null, dpi = 150 } = {}) {
  await fsp.mkdir(outDir, { recursive: true });
  const prefix = path.join(outDir, 'page');
  const args = ['-r', String(dpi), '-png'];
  if (first !== null) { args.push('-f', String(first)); }
  if (last  !== null) { args.push('-l', String(last));  }
  args.push(pdfPath, prefix);

  return new Promise((resolve, reject) => {
    const child = spawn('pdftoppm', args, { env: EXEC_ENV });
    let stderr = '';
    child.stderr.on('data', d => { stderr += d; });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} reject(new Error('pdftoppm timed out')); }, 60000);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error('pdftoppm failed (code ' + code + '): ' + stderr.slice(0, 300)));
      let pngs = [];
      try { pngs = fs.readdirSync(outDir).filter(f => f.endsWith('.png')).sort().map(f => path.join(outDir, f)); } catch (_) {}
      resolve(pngs);
    });
  });
}

// ── Resolve absolute path ───────────────────────────────────────────────────
function _absPath(p) {
  if (!p) return '';
  if (path.isAbsolute(p)) return p;
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return path.join(os.homedir(), p);
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Render a document to PNG screenshots (via LibreOffice PDF + pdftoppm).
 * Returns an array of absolute PNG file paths, one per page/slide.
 *
 * @param {string} filePath  absolute or ~/ path to the document
 * @param {{pages?:number|number[]|'all', dpi?:number}} opts
 * @returns {Promise<{ok:boolean, pngs?:string[], error?:string, needsInstall?:boolean}>}
 */
export async function renderDocumentToPngs(filePath, { pages = 'all', dpi = 150 } = {}) {
  const abs = _absPath(filePath);
  if (!fs.existsSync(abs)) return { ok: false, error: 'File not found: ' + abs };
  if (!isOfficeRenderable(abs)) return { ok: false, error: 'Unsupported format: ' + path.extname(abs) };

  // Step 1: doc → PDF
  const pdfResult = await renderOfficeToPdf({ srcPath: abs });
  if (!pdfResult.ok) return pdfResult;

  // Step 2: PDF → PNGs
  const key = crypto.createHash('sha1').update(abs + ':' + dpi + ':' + String(pages)).digest('hex').slice(0, 12);
  const pngDir = path.join(os.tmpdir(), 'fauna-office-png', key);

  let first = null, last = null;
  if (pages !== 'all') {
    const pg = Array.isArray(pages) ? pages : [pages];
    first = Math.min(...pg);
    last  = Math.max(...pg);
  }

  try {
    const pngs = await _pdfToPngs(pdfResult.pdfPath, pngDir, { first, last, dpi });
    if (!pngs.length) return { ok: false, error: 'pdftoppm produced no PNG files' };
    return { ok: true, pngs, pdfPath: pdfResult.pdfPath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Get document element(s) at a path.
 * @param {string} filePath
 * @param {string} docPath  e.g. '/', '/slide[1]', '/slide[1]/shape[2]', '/body/p[3]', '/Sheet1/A1'
 */
export async function documentGet(filePath, docPath = '/') {
  const abs = _absPath(filePath);
  if (!fs.existsSync(abs)) return { ok: false, code: 'file_not_found', error: 'File not found: ' + abs };
  return _runPy(_GET_PY, [abs, docPath]);
}

/**
 * Set properties on a document element at a path.
 * @param {string} filePath
 * @param {string} docPath
 * @param {object} props   e.g. {text:'hello', bold:true, font_size:24, color:'FF0000'}
 *                         or XLSX: {value:42} / {formula:'=SUM(A1:A3)'}
 */
export async function documentSet(filePath, docPath, props) {
  const abs = _absPath(filePath);
  if (!fs.existsSync(abs)) return { ok: false, code: 'file_not_found', error: 'File not found: ' + abs };
  return _runPy(_SET_PY, [abs, docPath], JSON.stringify(props || {}));
}

/**
 * Scan a document for common quality issues.
 * @returns {Promise<{ok:boolean, issue_count:number, issues:Array}>}
 */
export async function documentIssues(filePath) {
  const abs = _absPath(filePath);
  if (!fs.existsSync(abs)) return { ok: false, error: 'File not found: ' + abs };
  return _runPy(_ISSUES_PY, [abs]);
}

/**
 * Template merge: replace {{key}} placeholders in a document with values from data.
 * Writes output to destPath (may equal srcPath for in-place merge).
 * @param {string} srcPath   source template file
 * @param {string} destPath  output file (can be same as srcPath)
 * @param {object} data      {key: value, ...}
 */
export async function documentMerge(srcPath, destPath, data) {
  const absSrc  = _absPath(srcPath);
  const absDest = _absPath(destPath);
  if (!fs.existsSync(absSrc)) return { ok: false, error: 'Source file not found: ' + absSrc };
  // Ensure output directory exists
  try { fs.mkdirSync(path.dirname(absDest), { recursive: true }); } catch (_) {}
  return _runPy(_MERGE_PY, [absSrc, absDest], JSON.stringify(data || {}));
}
