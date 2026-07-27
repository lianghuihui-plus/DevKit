#!/usr/bin/env node
'use strict';

function checkerForPrecondition(precondition) {
  const text = String(precondition?.text || '').trim();
  if (/App\s*已安装|已安装/.test(text)) return 'app.launchable';
  if (/设备已连接/.test(text)) return 'device.connected';
  if (/截图/.test(text)) return 'capability.screenshot';
  if (/控件树/.test(text)) return 'capability.uiTree';
  return null;
}

function evaluateFrameworkPrecondition(checkerId, execution, events = []) {
  const environment = execution.environmentSnapshot || {};
  const probe = environment.probe || {};
  const bootstrapRestart = events.find((event) => event.type === 'actionResult' && event.scope === 'execution-bootstrap' && event.action === 'restartApp');
  if (checkerId === 'app.launchable') {
    const ok = execution.isolation?.clean === true && (execution.isolation?.skipped === true || bootstrapRestart?.coldStartVerified === true);
    return { status: ok ? 'PASS' : 'BLOCKED', failureCode: ok ? null : 'PRECONDITION_FAILED', evidenceRefs: [bootstrapRestart ? 'bootstrap-restart' : 'execution-isolation'], reason: ok ? '目标 App 的 execution 启动隔离已通过。' : '无法根据启动事实确认目标 App 可启动。' };
  }
  if (checkerId === 'device.connected') {
    const ok = execution.isolation?.clean === true;
    return { status: ok ? 'PASS' : 'BLOCKED', failureCode: ok ? null : 'ENV_UNAVAILABLE', evidenceRefs: [bootstrapRestart ? 'bootstrap-restart' : 'execution-isolation'], reason: ok ? 'execution 启动隔离已确认目标设备可用。' : '无法根据启动事实确认目标设备连接。' };
  }
  if (checkerId === 'capability.screenshot' || checkerId === 'capability.uiTree') {
    const capability = checkerId === 'capability.uiTree' ? 'layout' : 'screenshot';
    const ok = probe.ready === true && probe.capabilities?.[capability] === true;
    return { status: ok ? 'PASS' : 'BLOCKED', failureCode: ok ? null : 'ENV_UNAVAILABLE', evidenceRefs: ['environment-probe'], reason: ok ? `环境探测已确认 ${capability} 能力可用。` : `环境探测未确认 ${capability} 能力可用。` };
  }
  return { status: 'BLOCKED', failureCode: 'PRECONDITION_UNSUPPORTED', evidenceRefs: [], reason: `没有可执行的框架检查器：${checkerId || 'unknown'}` };
}

module.exports = { checkerForPrecondition, evaluateFrameworkPrecondition };
