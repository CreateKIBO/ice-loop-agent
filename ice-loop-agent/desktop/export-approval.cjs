'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

// The renderer receives a fresh child path, not the selected existing folder.
// Only paths issued by this desktop session may reach the export RPC.
class ExportApprovals {
  constructor({ now = Date.now, makeId = randomUUID, ttlMs = 600000 } = {}) {
    this.now = now; this.makeId = makeId; this.ttlMs = ttlMs; this.grants = new Map();
  }
  issue(parent) {
    if (typeof parent !== 'string' || !path.isAbsolute(parent) || /^c:/i.test(parent)) throw Error('请选择 C 盘之外的导出位置');
    if (!fs.statSync(parent).isDirectory()) throw Error('导出位置必须是文件夹');
    for (const [key, expires] of this.grants) if (expires <= this.now()) this.grants.delete(key);
    if (this.grants.size >= 20) throw Error('待使用的导出位置过多，请完成已有导出后再选择');
    const destination = path.join(path.resolve(parent), 'ICE-Loop-Export-' + this.makeId());
    if (fs.existsSync(destination)) throw Error('新导出目录已存在，请重新选择');
    this.grants.set(destination, this.now() + this.ttlMs);
    return destination;
  }
  assert(destination) {
    if (typeof destination !== 'string' || !path.isAbsolute(destination)) throw Error('请先使用目录选择器选择导出位置');
    const key = path.resolve(destination), expires = this.grants.get(key);
    if (!expires || expires <= this.now()) {
      this.grants.delete(key);
      throw Error('导出位置未经本次选择授权或已过期，请重新选择');
    }
    return key;
  }
  consume(destination) { this.grants.delete(path.resolve(destination)); }
  clear() { this.grants.clear(); }
}
module.exports = { ExportApprovals };
