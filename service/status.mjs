/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Inputs documented by the generated module and its Package contracts.
 * [OUTPUT]: The behavior implemented by the generated module.
 * [POS]: A generated Extension Package source file.
 * [PROTOCOL]: Keep this English header synchronized with Package behavior.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * ⚠ 目录只建一次。这个函数每秒被调用一次，而 `mkdirSync` 每次都要走一趟文件系统
 * 去确认一件已经确认过的事。
 */
const ensured = new Set();

export function writeStatus(file, obj) {
  const dir = path.dirname(file);
  if (!ensured.has(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    ensured.add(dir);
  }
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ ...obj, updated_at: Date.now() }, null, 2));
  fs.renameSync(tmp, file);
}

export function readStatus(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
