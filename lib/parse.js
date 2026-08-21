'use strict';
const fs = require('fs');
const path = require('path');

let pdfParse = null;
try { pdfParse = require('pdf-parse'); } catch (e) { /* ignore */ }

const mammoth = require('mammoth');
const WordExtractor = require('word-extractor');

const SUPPORTED = ['.pdf', '.doc', '.docx', '.txt', '.md', '.wps'];

function extOf(filename) {
  return path.extname(String(filename || '')).toLowerCase();
}

function normalizeText(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function parsePDFBuffer(buffer) {
  if (!pdfParse) throw new Error('pdf-parse 未安装');
  const data = await pdfParse(buffer);
  return data.text || '';
}

async function parseDocxBuffer(buffer) {
  const result = await mammoth.extractRawText({ buffer });
  return result.value || '';
}

async function parseDocBuffer(buffer) {
  const extractor = new WordExtractor();
  const doc = await extractor.extract(buffer);
  return doc.getBody ? doc.getBody() : (doc.toString ? doc.toString() : '');
}

/**
 * Parse a file on disk to plain text.
 */
async function parseFile(filePath) {
  const ext = extOf(filePath);
  const buf = fs.readFileSync(filePath);
  return parseBuffer(buf, path.basename(filePath));
}

/**
 * Parse a Buffer by filename extension.
 */
async function parseBuffer(buffer, filename) {
  const ext = extOf(filename);
  let text = '';
  if (ext === '.pdf') {
    text = await parsePDFBuffer(buffer);
  } else if (ext === '.docx') {
    text = await parseDocxBuffer(buffer);
  } else if (ext === '.doc' || ext === '.wps') {
    // WPS 老格式本质也是 OLE 二进制，尝试按 doc 解析
    try {
      text = await parseDocBuffer(buffer);
    } catch (e) {
      text = '';
    }
  } else if (ext === '.txt' || ext === '.md') {
    text = buffer.toString('utf8');
  } else {
    // 尝试按文本读取
    text = buffer.toString('utf8');
  }
  const normalized = normalizeText(text);
  if (!normalized) throw new Error('无法从文件提取文本（可能是扫描件/图片型 PDF，请使用多模态模型重试）');
  return normalized;
}

module.exports = { parseFile, parseBuffer, SUPPORTED, extOf };
