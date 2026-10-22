'use strict';
const { execute, failureValue, toolResult } = require('./management-service');

process.on('message', ({ id, pluginRoot, name, args }) => {
  let result;
  try { result = toolResult(execute(pluginRoot, name, args)); }
  catch (error) { result = toolResult(failureValue(error)); }
  if (process.connected) process.send({ id, result });
});
process.on('disconnect', () => process.exit(0));
