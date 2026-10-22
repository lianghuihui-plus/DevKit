'use strict';
const path = require('node:path');
const { fork } = require('node:child_process');
const { toolResult } = require('./management-service');

const READ_ONLY = /^mavt_(?:workspace_doctor|run_(?:status|report|read)|case_(?:read|image)|knowledge_(?:inspect|list|show|validate))$/;
const CONTROL = /^mavt_run_cancel$/;
function result(status, code, message, extra = {}) { return toolResult({ status, code, message, ...extra }); }

function createPool({ pluginRoot, maxWorkers = 5, maxPending = 64, idleTimeoutMs = 30000, maxOperationMs = 1800000 } = {}) {
  if (!Number.isInteger(maxWorkers) || maxWorkers < 3 || maxWorkers > 16 ||
    !Number.isInteger(maxPending) || maxPending < 1 || maxPending > 1024 ||
    !Number.isInteger(idleTimeoutMs) || idleTimeoutMs < 0 ||
    !Number.isInteger(maxOperationMs) || maxOperationMs < 1) throw new TypeError('Invalid worker-pool bounds');
  const workers = new Set(), pending = [], activeKeys = new Set();
  const effectLimit = maxWorkers - 2;
  let effects = 0, nonReads = 0, reads = 0, sequence = 0, started = 0, accepting = true, closing;

  function unknown(task, reason) {
    return result('UNKNOWN', 'MAVT_MCP_WORKER_OUTCOME_UNKNOWN', reason,
      { contextRef: task.args?.contextRef, workspace: task.args?.workspace, tool: task.name,
        retryable: false, recovery: 'Inspect the pinned Run/Case state and dispatch before deciding any further action' });
  }
  function clearIdle(worker) { if (worker.idleTimer) clearTimeout(worker.idleTimer); worker.idleTimer = null; }
  function stopIdle(worker) {
    if (worker.busy || !workers.has(worker)) return;
    clearIdle(worker);
    if (closing) { if (worker.child.connected) worker.child.disconnect(); }
    else if (idleTimeoutMs) {
      worker.idleTimer = setTimeout(() => { if (!worker.busy && workers.has(worker)) worker.child.disconnect(); }, idleTimeoutMs);
      worker.idleTimer.unref();
    }
  }
  function settleClose() {
    if (!closing || pending.length || [...workers].some(worker => worker.busy)) return;
    for (const worker of workers) stopIdle(worker);
    if (!workers.size) closing.resolve();
  }
  function spawnWorker() {
    const child = fork(path.join(__dirname, 'worker-child.js'), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [] });
    const worker = { child, busy: null, idleTimer: null, diagnostic: '' };
    started += 1; workers.add(worker);
    child.stderr.on('data', chunk => { worker.diagnostic = (worker.diagnostic + chunk.toString()).slice(-2048); });
    child.on('message', message => {
      const task = worker.busy;
      if (!task || message?.id !== task.id) return;
      clearTimeout(task.timer);
      worker.busy = null;
      activeKeys.delete(task.key);
      if (task.readOnly) reads -= 1;
      else { nonReads -= 1; if (!task.control) effects -= 1; }
      task.resolve(message.result);
      stopIdle(worker);
      drain();
    });
    child.on('exit', (code, signal) => {
      clearIdle(worker); workers.delete(worker);
      const task = worker.busy;
      if (task) {
        clearTimeout(task.timer);
        activeKeys.delete(task.key);
        if (task.readOnly) reads -= 1;
        else { nonReads -= 1; if (!task.control) effects -= 1; }
        task.resolve(unknown(task, task.timeout ? 'Worker timed out after dispatch; effect outcome is unknown'
          : `Worker exited after dispatch (${signal || code}); effect outcome is unknown`));
      }
      drain(); settleClose();
    });
    return worker;
  }
  function eligible(task) { return !activeKeys.has(task.key) &&
    (task.readOnly ? reads < maxWorkers - 1 : nonReads < maxWorkers - 1 && (task.control || effects < effectLimit)); }
  function nextTask() {
    const controlIndex = pending.findIndex(task => (task.control || task.readOnly) && eligible(task));
    const index = controlIndex >= 0 ? controlIndex : pending.findIndex(eligible);
    return index < 0 ? null : pending.splice(index, 1)[0];
  }
  function dispatch(worker, task) {
    clearIdle(worker);
    worker.busy = task;
    activeKeys.add(task.key);
    if (task.readOnly) reads += 1;
    else { nonReads += 1; if (!task.control) effects += 1; }
    task.timer = setTimeout(() => { task.timeout = true; worker.child.kill('SIGKILL'); }, maxOperationMs);
    task.timer.unref();
    try { worker.child.send({ id: task.id, pluginRoot, name: task.name, args: task.args }); }
    catch (error) { worker.child.kill('SIGKILL'); }
  }
  function drain() {
    while (pending.length) {
      const available = [...workers].find(worker => !worker.busy && worker.child.connected);
      if (!available && workers.size >= maxWorkers) break;
      const task = nextTask();
      if (!task) break;
      dispatch(available || spawnWorker(), task);
    }
    settleClose();
  }
  function callTool(name, args = {}) {
    if (!accepting) return Promise.resolve(result('REJECTED', 'MAVT_MCP_CLOSED', 'Server is draining accepted calls'));
    return new Promise(resolve => {
      const readOnly = READ_ONLY.test(name);
      const key = `${args.contextRef || args.workspace || `unbound:${++sequence}`}:${readOnly ? 'read' : 'write'}`;
      const task = { id: ++sequence, key, name, args, readOnly, control: CONTROL.test(name), resolve };
      pending.push(task);
      drain();
      if (pending.length > maxPending) {
        pending.splice(pending.indexOf(task), 1);
        resolve(result('REJECTED', 'MAVT_MCP_BUSY', 'Worker queue is full; call was not dispatched'));
      }
    });
  }
  function close() {
    if (closing) return closing.promise;
    accepting = false;
    closing = {};
    closing.promise = new Promise(resolve => { closing.resolve = resolve; });
    drain();
    return closing.promise;
  }
  function stats() { return { started, active: workers.size, pending: pending.length, workers: [...workers].map(worker => ({ pid: worker.child.pid, busyKey: worker.busy?.key || null })) }; }
  return { callTool, close, stats };
}

module.exports = { createPool };
