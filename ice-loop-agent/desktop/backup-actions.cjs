'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

// Picker grants stay in the main process. Restores always use a new directory;
// selection publication is a separate atomic operation after restore succeeds.
class BackupActions {
  constructor({ request, dialog, window, project, selection, now = Date.now, ttlMs = 10 * 60 * 1000 }) {
    Object.assign(this, { request, dialog, window, project, selection, now, ttlMs });
    this.review = null;
    this.pendingSelection = null;
    this.busy = false;
  }
  async exclusive(operation) {
    if (this.busy) throw Error('备份或恢复正在处理，请等待完成');
    this.busy = true;
    try { return await operation(); } finally { this.busy = false; }
  }
  create() {
    return this.exclusive(async () => {
      const picked = await this.dialog.showSaveDialog(this.window(), {
        title: '保存工作台备份',
        defaultPath: path.join(this.project, 'backups', 'ice-workspace-' + new Date(this.now()).toISOString().slice(0, 10) + '.zip'),
        filters: [{ name: '工作台备份', extensions: ['zip'] }],
      });
      if (picked.canceled) return null;
      return this.request('backup.create', { file_path: picked.filePath });
    });
  }
  inspect() {
    return this.exclusive(async () => {
      this.review = null;
      const picked = await this.dialog.showOpenDialog(this.window(), {
        title: '预览工作台备份', properties: ['openFile'], filters: [{ name: '工作台备份', extensions: ['zip'] }],
      });
      if (picked.canceled) return null;
      const summary = await this.request('backup.inspect', { file_path: picked.filePaths[0] });
      const token = randomUUID();
      this.review = { token, file: picked.filePaths[0], hash: summary.package_hash, expires: this.now() + this.ttlMs };
      return { ...summary, token };
    });
  }
  checkedReview(token) {
    if (!this.review || typeof token !== 'string' || this.review.token !== token) throw Error('请先选择并预览备份包');
    if (this.now() >= this.review.expires) { this.review = null; throw Error('备份预览已过期，请重新选择并校验'); }
    return this.review;
  }
  restore(token) {
    return this.exclusive(async () => {
      const review = this.checkedReview(token);
      const picked = await this.dialog.showOpenDialog(this.window(), {
        title: '选择恢复目录的父文件夹（会新建工作目录）', properties: ['openDirectory', 'createDirectory'],
      });
      if (picked.canceled) return null;
      this.checkedReview(token); // The native picker can remain open past expiry.
      this.review = null; // one attempt per reviewed package; changed bytes require review again
      const destination = path.join(picked.filePaths[0], 'ice-restored-' + this.now() + '-' + randomUUID().slice(0, 8));
      const restored = await this.request('backup.restore', { file_path: review.file, destination, package_hash: review.hash });
      this.pendingSelection = { token: randomUUID(), restored };
      return this.publishSelection();
    });
  }
  activate(token) {
    return this.exclusive(async () => {
      if (!this.pendingSelection || this.pendingSelection.token !== token) throw Error('恢复目录确认已失效，请重新预览恢复');
      return this.publishSelection();
    });
  }
  publishSelection() {
    const pending = this.pendingSelection;
    const temporary = this.selection + '.' + randomUUID() + '.tmp';
    try {
      fs.mkdirSync(path.dirname(this.selection), { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify({ runtime_root: pending.restored.runtime_root }, null, 2), { flag: 'wx' });
      fs.renameSync(temporary, this.selection);
      this.pendingSelection = null;
      return { ...pending.restored, restart_required: true };
    } catch {
      // Data are already safely restored. Report that fact even when the
      // small selection file cannot be written, keeping the old selection.
      return { ...pending.restored, restart_required: false, activation_token: pending.token,
        selection_error: '资料已恢复，但未能切换工作目录。当前工作目录保持原样；请重试切换，或保留恢复目录后排查写入权限。' };
    } finally {
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') console.warn('备份目录选择临时文件清理失败'); }
    }
  }
}
module.exports = { BackupActions };
