'use strict';

const crypto = require('node:crypto');

function extractTextFromRawPdfStructure(rawContent) {
  // Check if content is a raw %PDF- file
  if (!rawContent.trimStart().startsWith('%PDF-')) {
    return null;
  }

  if (!rawContent.includes('%%EOF')) {
    throw Object.assign(
      new Error('Malformed PDF file: missing %%EOF trailer marker.'),
      { statusCode: 422, errorCode: 'MALFORMED_SOURCE_FILE', processingStatus: 'FAILED' }
    );
  }

  // Split by /Type /Page (excluding /Type /Pages) or extract BT...ET blocks
  const pageBlocks = rawContent.split(/\/Type\s*\/Page\b(?!s)/i);
  const pagesToScan = pageBlocks.length > 1 ? pageBlocks.slice(1) : [rawContent];
  const extractedPages = [];

  for (let pIdx = 0; pIdx < pagesToScan.length; pIdx++) {
    const block = pagesToScan[pIdx];
    const textChunks = [];
    const btMatches = block.matchAll(/BT([\s\S]*?)ET/g);
    for (const m of btMatches) {
      const inner = m[1];
      const strLiterals = inner.matchAll(/\(([^()\\]*(?:\\.[^()\\]*)*)\)\s*(?:Tj|')?/g);
      for (const lit of strLiterals) {
        const cleaned = lit[1].replace(/\\([()\\nrt])/g, '$1').trim();
        if (cleaned) textChunks.push(cleaned);
      }
    }
    const joinedPageText = textChunks.join(' ').trim();
    if (joinedPageText) {
      extractedPages.push({ pageNumber: pIdx + 1, text: joinedPageText });
    }
  }

  if (extractedPages.length === 0) {
    // Check if it contains image XObjects or is an image-only scan
    throw Object.assign(
      new Error(
        'Scanned or image-only PDF detected: no extractable text layer found in PDF streams. OCR is not enabled in this MVP (status: NEEDS_OCR).'
      ),
      { statusCode: 422, errorCode: 'SCANNED_PDF_NEEDS_OCR', processingStatus: 'NEEDS_OCR' }
    );
  }

  return extractedPages;
}

function parsePdfSpans(rawContent) {
  const trimmedAll = rawContent.trim();

  // Explicit scanned/image-only PDF marker or raw PDF without text streams
  if (
    /^\[SCANNED_PDF_NO_TEXT_LAYER\]$/i.test(trimmedAll) ||
    /^\[IMAGE_ONLY_PDF\]$/i.test(trimmedAll)
  ) {
    throw Object.assign(
      new Error(
        'Scanned or image-only PDF detected: no extractable text layer found. OCR is not enabled in this MVP (status: NEEDS_OCR).'
      ),
      { statusCode: 422, errorCode: 'SCANNED_PDF_NEEDS_OCR', processingStatus: 'NEEDS_OCR' }
    );
  }

  const rawPdfPages = extractTextFromRawPdfStructure(rawContent);
  if (rawPdfPages) {
    const spans = [];
    let spanIndex = 1;
    for (const pg of rawPdfPages) {
      const start = rawContent.indexOf(pg.text);
      const end = start >= 0 ? start + pg.text.length : pg.text.length;
      spans.push({
        span_index: spanIndex++,
        locator_type: 'PDF_PAGE',
        locator_label: `Page ${pg.pageNumber}, Span 1`,
        page_number: pg.pageNumber,
        section_heading: null,
        line_start: null,
        line_end: null,
        row_index: null,
        record_key: null,
        column_names_json: null,
        content_text: pg.text,
        char_start: Math.max(0, start),
        char_end: Math.max(0, end)
      });
    }
    return { spans, pageCount: rawPdfPages.length, rowCount: null };
  }

  const spans = [];
  const pageRegex = /\[PAGE\s+(\d+)\]/gi;
  const matches = Array.from(rawContent.matchAll(pageRegex));

  if (matches.length === 0) {
    const blocks = rawContent.split(/\r?\n\r?\n+/);
    let cursor = 0;
    let spanIndex = 1;
    for (const block of blocks) {
      const trimmed = block.trim();
      if (!trimmed) continue;
      const start = rawContent.indexOf(trimmed, cursor);
      const end = start + trimmed.length;
      cursor = end;
      spans.push({
        span_index: spanIndex,
        locator_type: 'PDF_PAGE',
        locator_label: `Page 1, Span ${spanIndex}`,
        page_number: 1,
        section_heading: null,
        line_start: null,
        line_end: null,
        row_index: null,
        record_key: null,
        column_names_json: null,
        content_text: trimmed,
        char_start: start >= 0 ? start : 0,
        char_end: start >= 0 ? end : trimmed.length
      });
      spanIndex++;
    }
    return { spans, pageCount: spans.length > 0 ? 1 : 0, rowCount: null };
  }

  let spanIndex = 1;
  const pageNumbersSeen = new Set();

  for (let i = 0; i < matches.length; i++) {
    const pageNum = Number(matches[i][1]);
    pageNumbersSeen.add(pageNum);
    const contentStart = matches[i].index + matches[i][0].length;
    const contentEnd = i + 1 < matches.length ? matches[i + 1].index : rawContent.length;
    const pageBody = rawContent.slice(contentStart, contentEnd);
    const paragraphs = pageBody.split(/\r?\n\r?\n+/);
    let localCursor = contentStart;
    let paraIdx = 1;

    for (const para of paragraphs) {
      const trimmed = para.trim();
      if (!trimmed) continue;
      const start = rawContent.indexOf(trimmed, localCursor);
      const end = start + trimmed.length;
      if (start >= 0) localCursor = end;
      spans.push({
        span_index: spanIndex++,
        locator_type: 'PDF_PAGE',
        locator_label: `Page ${pageNum}, Para ${paraIdx++}`,
        page_number: pageNum,
        section_heading: null,
        line_start: null,
        line_end: null,
        row_index: null,
        record_key: null,
        column_names_json: null,
        content_text: trimmed,
        char_start: start >= 0 ? start : contentStart,
        char_end: start >= 0 ? end : contentEnd
      });
    }
  }

  if (spans.length === 0) {
    throw Object.assign(
      new Error(
        'Scanned or image-only PDF detected: page markers present but zero extractable text spans found (status: NEEDS_OCR).'
      ),
      { statusCode: 422, errorCode: 'SCANNED_PDF_NEEDS_OCR', processingStatus: 'NEEDS_OCR' }
    );
  }

  return { spans, pageCount: pageNumbersSeen.size, rowCount: null };
}

function parseLabNoteSpans(rawContent) {
  const lines = rawContent.split(/\r?\n/);
  const spans = [];
  let currentHeading = 'General Notes';
  let bufferLines = [];
  let startLine = 1;
  let spanIndex = 1;
  let charCursor = 0;

  function flushSection(endLineNum) {
    const joined = bufferLines.join('\n').trim();
    if (!joined) return;
    const startOffset = rawContent.indexOf(joined, charCursor);
    const endOffset = startOffset >= 0 ? startOffset + joined.length : charCursor + joined.length;
    if (startOffset >= 0) charCursor = endOffset;

    spans.push({
      span_index: spanIndex++,
      locator_type: 'NOTE_SECTION_LINE',
      locator_label: `Section "${currentHeading}" (Lines ${startLine}-${endLineNum})`,
      page_number: null,
      section_heading: currentHeading,
      line_start: startLine,
      line_end: endLineNum,
      row_index: null,
      record_key: null,
      column_names_json: null,
      content_text: joined,
      char_start: Math.max(0, startOffset),
      char_end: Math.max(0, endOffset)
    });
  }

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const line = lines[i];
    const headingMatch = line.match(/^#{1,4}\s+(.+)$/);
    if (headingMatch) {
      if (bufferLines.length > 0) {
        flushSection(lineNum - 1);
      }
      currentHeading = headingMatch[1].trim();
      bufferLines = [line];
      startLine = lineNum;
    } else {
      if (bufferLines.length === 0) {
        startLine = lineNum;
      }
      bufferLines.push(line);
    }
  }

  if (bufferLines.length > 0) {
    flushSection(lines.length);
  }

  return { spans, pageCount: null, rowCount: lines.length };
}

function parseCsvSpans(rawContent) {
  const lines = rawContent
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    throw Object.assign(
      new Error('Malformed CSV_DATASET: must contain a comma-separated header row and at least one data row.'),
      { statusCode: 422, errorCode: 'SOURCE_PROCESSING_FAILED', processingStatus: 'FAILED' }
    );
  }

  const headers = lines[0].split(',').map((h) => h.trim());
  if (headers.length < 2 || headers.some((h) => !h)) {
    throw Object.assign(
      new Error('Malformed CSV_DATASET: header row must have at least 2 non-empty column names.'),
      { statusCode: 422, errorCode: 'SOURCE_PROCESSING_FAILED', processingStatus: 'FAILED' }
    );
  }

  const columnsJson = JSON.stringify(headers);
  const spans = [];
  let charCursor = 0;

  for (let i = 1; i < lines.length; i++) {
    const rowValues = lines[i].split(',').map((v) => v.trim());
    if (rowValues.length !== headers.length) {
      throw Object.assign(
        new Error(
          `Malformed CSV_DATASET at data row #${i} (line ${i + 1}): expected ${headers.length} columns (${headers.join(', ')}), found ${rowValues.length}.`
        ),
        { statusCode: 422, errorCode: 'SOURCE_PROCESSING_FAILED', processingStatus: 'FAILED' }
      );
    }

    const rowIndex = i;
    const recordKey = rowValues[0] || `row_${rowIndex}`;
    const formattedPairs = headers.map((h, idx) => `${h}=${rowValues[idx] ?? ''}`).join(' | ');
    const startOffset = rawContent.indexOf(lines[i], charCursor);
    const endOffset = startOffset >= 0 ? startOffset + lines[i].length : charCursor + lines[i].length;
    if (startOffset >= 0) charCursor = endOffset;

    spans.push({
      span_index: rowIndex,
      locator_type: 'CSV_ROW',
      locator_label: `Row #${rowIndex} (${headers[0]}=${recordKey})`,
      page_number: null,
      section_heading: null,
      line_start: i + 1,
      line_end: i + 1,
      row_index: rowIndex,
      record_key: recordKey,
      column_names_json: columnsJson,
      content_text: formattedPairs,
      char_start: Math.max(0, startOffset),
      char_end: Math.max(0, endOffset)
    });
  }

  return { spans, pageCount: null, rowCount: spans.length };
}

function parseJsonSpans(rawContent) {
  let parsed;
  try {
    parsed = JSON.parse(rawContent);
  } catch (err) {
    throw Object.assign(
      new Error(`Invalid JSON in JSON_RECORDS source: ${err.message}`),
      { statusCode: 422, errorCode: 'SOURCE_PROCESSING_FAILED', processingStatus: 'FAILED' }
    );
  }

  if (!parsed || typeof parsed !== 'object') {
    throw Object.assign(
      new Error('Malformed JSON_RECORDS source: root value must be a JSON array or object.'),
      { statusCode: 422, errorCode: 'SOURCE_PROCESSING_FAILED', processingStatus: 'FAILED' }
    );
  }

  const records = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.records)
      ? parsed.records
      : [parsed];

  if (records.length === 0) {
    throw Object.assign(
      new Error('JSON_RECORDS source contains zero records.'),
      { statusCode: 422, errorCode: 'SOURCE_PROCESSING_FAILED', processingStatus: 'FAILED' }
    );
  }

  const spans = records.map((rec, idx) => {
    if (!rec || typeof rec !== 'object' || Array.isArray(rec) || Object.keys(rec).length === 0) {
      throw Object.assign(
        new Error(`Malformed JSON_RECORDS at record #${idx + 1}: each item must be a non-empty JSON object with field keys.`),
        { statusCode: 422, errorCode: 'SOURCE_PROCESSING_FAILED', processingStatus: 'FAILED' }
      );
    }
    const rowIndex = idx + 1;
    const keys = Object.keys(rec);
    const firstKey = keys[0];
    const recordKey = rec[firstKey] !== undefined ? String(rec[firstKey]) : `record_${rowIndex}`;
    const serialized = JSON.stringify(rec);
    return {
      span_index: rowIndex,
      locator_type: 'JSON_RECORD',
      locator_label: `Record #${rowIndex} (${firstKey}=${recordKey})`,
      page_number: null,
      section_heading: null,
      line_start: null,
      line_end: null,
      row_index: rowIndex,
      record_key: recordKey,
      column_names_json: JSON.stringify(keys),
      content_text: serialized,
      char_start: 0,
      char_end: serialized.length
    };
  });

  return { spans, pageCount: null, rowCount: spans.length };
}

function indexSourceSpans(db, { sourceId, projectId, sourceType, rawContent, idPrefix = null }) {
  let parseResult;
  if (sourceType === 'PDF_DOCUMENT') {
    parseResult = parsePdfSpans(rawContent);
  } else if (sourceType === 'LAB_NOTE') {
    parseResult = parseLabNoteSpans(rawContent);
  } else if (sourceType === 'CSV_DATASET') {
    parseResult = parseCsvSpans(rawContent);
  } else if (sourceType === 'JSON_RECORDS') {
    parseResult = parseJsonSpans(rawContent);
  } else {
    throw Object.assign(new Error(`Unsupported source_type: ${sourceType}`), {
      statusCode: 400,
      errorCode: 'INVALID_SOURCE_TYPE'
    });
  }

  const parsedSpans = parseResult.spans;
  if (!parsedSpans || parsedSpans.length === 0) {
    throw Object.assign(new Error('Source parsing produced zero provenance spans.'), {
      statusCode: 422,
      errorCode: 'SOURCE_PROCESSING_FAILED',
      processingStatus: 'FAILED'
    });
  }

  const now = new Date().toISOString();
  const insertStmt = db.prepare(`
    INSERT INTO source_spans (
      id, source_id, project_id, span_index, locator_type, locator_label,
      page_number, section_heading, line_start, line_end,
      row_index, record_key, column_names_json,
      content_text, char_start, char_end, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const inserted = [];
  for (const sp of parsedSpans) {
    const spanId = idPrefix
      ? `${idPrefix}_${sp.span_index}`
      : `spn_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;

    insertStmt.run(
      spanId,
      sourceId,
      projectId,
      sp.span_index,
      sp.locator_type,
      sp.locator_label,
      sp.page_number,
      sp.section_heading,
      sp.line_start,
      sp.line_end,
      sp.row_index,
      sp.record_key,
      sp.column_names_json,
      sp.content_text,
      sp.char_start,
      sp.char_end,
      now
    );

    inserted.push({ id: spanId, source_id: sourceId, project_id: projectId, ...sp, created_at: now });
  }

  db.prepare('UPDATE sources SET page_count = ?, row_count = ? WHERE id = ?').run(
    parseResult.pageCount,
    parseResult.rowCount,
    sourceId
  );

  return inserted;
}

module.exports = { indexSourceSpans };
