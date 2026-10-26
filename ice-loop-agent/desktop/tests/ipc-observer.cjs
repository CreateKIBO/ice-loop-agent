'use strict';
// Test-only instrumentation. Preserve every handler and its return/rejection.
const fs = require('node:fs');
function observeIpc({ipcMain, BrowserWindow, observed, trace, fault}) {
  const handle = ipcMain.handle.bind(ipcMain);
  let sequence = 0;
  const append = (file, row) => fs.appendFileSync(file, JSON.stringify(row) + '\n');
  ipcMain.handle = (channel, fn) => handle(channel, async (...args) => {
    const started = Date.now(), id = ++sequence;
    const method = channel === 'ice:request' ? args[1] : channel==='ice:chat-send'?'chat.send':null;
    const faultKey = method || (channel === 'ice:original-image-open' ? channel : null);
    const account = method ? (channel==='ice:chat-send'?args[1]:args[2])?.account_id || null : null;
    // Never log request payloads, secrets, returned bodies or raw error messages.
    const meta = {id, channel, method, account};
    append(trace, {...meta, phase:'started', at:started});
    let control = {};
    try {
      if (faultKey) {
        try { control = JSON.parse(fs.readFileSync(fault, 'utf8')); } catch {}
        if ((control.fail || []).includes(faultKey)) {
          throw Error(control.errorMessage || '[NETWORK] 注入的读取故障');
        }
        const delay = control.delayMs?.[faultKey];
        if (Number.isFinite(delay) && delay > 0) await new Promise(r => setTimeout(r, Math.min(delay, 30000)));
      }
      const result = await fn(...args);
      if(faultKey&&(control.loseAfterReply||[]).includes(faultKey)){append(trace,{...meta,phase:'handler_returned',at:Date.now()});throw Error('[NETWORK] 注入的回执丢失');}
      const responseDelay = control.responseDelayMs?.[faultKey];
      if (faultKey && Number.isFinite(responseDelay) && responseDelay > 0) {
        append(trace, {...meta, phase:'handler_returned', at:Date.now()});
        await new Promise(r => setTimeout(r, Math.min(responseDelay, 30000)));
      }
      if (method) append(observed, {method, account, at:started, ok:true});
      if (channel.startsWith('ice:browser-')) {
        const windows = BrowserWindow.getAllWindows();
        const owner = windows.find(w => w.webContents.getURL().startsWith('ice://')) || windows[0];
        const ids = owner?.contentView.children.map(v => v.webContents.id) || [];
        append(observed, {channel, ids});
      }
      append(trace, {...meta, phase:'resolved', at:Date.now(), elapsed_ms:Date.now()-started});
      return result;
    } catch (error) {
      if (method) append(observed, {method, account, at:started, ok:false});
      append(trace, {...meta, phase:'rejected', at:Date.now(), elapsed_ms:Date.now()-started});
      throw error;
    }
  });
}
module.exports = {observeIpc};
