'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const workerRoot = path.resolve(__dirname, '../src/mobile-ai-visual-test/scripts/mcp');
function running(pid) {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' });
  return result.status === 0 && result.stdout.trim() !== '' && !result.stdout.trim().startsWith('Z');
}
async function waitForFile(filename) {
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(filename)) {
    if (Date.now() > deadline) throw new Error(`Missing process barrier: ${filename}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

for (const mode of ['timeout', 'crash']) test(`worker ${mode} reaps operation processes before releasing the lane and preserves detached services`, { skip: process.platform === 'win32' }, async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-worker-process-test-'));
  const entered = path.join(temp, 'entered.json');
  const descendant = path.join(temp, 'descendant.pid');
  // Preserve the real dependency layout; worker-pool also reads reporting
  // descriptors before it starts either operation process.
  const fixtureMcpRoot = path.join(temp, 'mcp');
  fs.mkdirSync(fixtureMcpRoot);
  fs.mkdirSync(path.join(temp, 'reporting'));
  fs.copyFileSync(path.join(workerRoot, '../reporting/tools.js'), path.join(temp, 'reporting/tools.js'));
  for (const file of ['worker-pool.js', 'worker-child.js']) fs.copyFileSync(path.join(workerRoot, file), path.join(fixtureMcpRoot, file));
  // Substitute only the domain operation. Worker IPC, fork, timeout, lane and close are real.
  fs.writeFileSync(path.join(fixtureMcpRoot, 'management-service.js'), `
    const fs = require('node:fs'), cp = require('node:child_process');
    exports.toolResult = value => ({ structuredContent: value });
    exports.failureValue = error => ({ status: 'FAILED', message: error.message });
    exports.execute = (_root, _name, args) => {
      if (args.block) {
        const service = cp.spawn(process.execPath, ['-e', 'setTimeout(()=>{},15000)'], { detached: true, stdio: 'ignore' });
        service.unref();
        cp.spawnSync(process.execPath, ['-e', ${JSON.stringify(`
          const fs = require('node:fs'), cp = require('node:child_process');
          const child = cp.spawn(process.execPath, ['-e', 'setTimeout(()=>{},15000)'], { stdio: 'ignore' });
          fs.writeFileSync(${JSON.stringify(descendant)}, String(child.pid));
          fs.writeFileSync(${JSON.stringify(entered)}, JSON.stringify({ command: process.pid, service: Number(process.argv[1]) }));
          setTimeout(()=>{},15000);
        `)}, String(service.pid)]);
      }
      const ids = JSON.parse(fs.readFileSync(${JSON.stringify(entered)}));
      const pids = [ids.command, Number(fs.readFileSync(${JSON.stringify(descendant)}, 'utf8'))];
      return { status: 'SUCCEEDED', runningCommands: pids.filter(pid => {
        const result = cp.spawnSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' });
        return result.status === 0 && result.stdout.trim() !== '' && !result.stdout.trim().startsWith('Z');
      }) };
    };
  `);
  const pool = require(path.join(fixtureMcpRoot, 'worker-pool')).createPool({ pluginRoot: temp, maxOperationMs: mode === 'timeout' ? 1200 : 5000 });
  t.after(async () => {
    await pool.close();
    if (fs.existsSync(entered)) for (const pid of Object.values(JSON.parse(fs.readFileSync(entered)))) {
      try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    if (fs.existsSync(descendant)) { try { process.kill(Number(fs.readFileSync(descendant)), 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const first = pool.callTool('mavt_run_advance', { contextRef: 'offline', block: true });
  await waitForFile(entered);
  const second = pool.callTool('mavt_run_advance', { contextRef: 'offline' });
  assert.equal(pool.stats().pending, 1);
  if (mode === 'crash') process.kill(pool.stats().workers.find(worker => worker.busyKey).pid, 'SIGKILL');
  assert.equal((await first).structuredContent.status, 'UNKNOWN');
  const next = (await second).structuredContent;
  assert.equal(next.status, 'SUCCEEDED');
  assert.deepEqual(next.runningCommands, [], 'the next same-context call must not overlap any old command or grandchild');
  await pool.close();
  assert.equal(pool.stats().active, 0);
  assert.equal(running(JSON.parse(fs.readFileSync(entered)).service), true, 'shared services own a separate process group');
});
