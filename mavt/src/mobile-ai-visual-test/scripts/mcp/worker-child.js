'use strict';
const { execute, failureValue, toolResult } = require('./management-service');

let prepared;
process.on('message', message => {
  if (message.kind === 'prepare') {
    if (prepared) return;
    prepared = message;
    if (process.connected) process.send({ id: message.id, kind: 'accepted' });
    return;
  }
  if (message.kind !== 'start' || !prepared || message.id !== prepared.id) return;
  const { id, pluginRoot, name, args } = prepared;
  prepared = null;
  let result;
  try { result = toolResult(execute(pluginRoot, name, args)); }
  catch (error) { result = toolResult(failureValue(error)); }
  if (process.connected) process.send({ id, kind: 'result', result });
});
process.on('disconnect', () => process.exit(0));
