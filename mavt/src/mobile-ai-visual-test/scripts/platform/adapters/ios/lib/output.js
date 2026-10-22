#!/usr/bin/env node
'use strict';

function localIso(date = new Date()) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  const pad = (value, size = 2) => String(value).padStart(size, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function atomResult(atom, extra = {}) {
  return {
    schemaVersion: 1,
    type: 'atomResult',
    atom,
    platform: 'ios',
    time: localIso(),
    ok: true,
    ...extra,
  };
}

function actionResult(action, extra = {}) {
  return {
    schemaVersion: 1,
    type: 'actionResult',
    platform: 'ios',
    time: localIso(),
    action,
    ok: true,
    ...extra,
  };
}

function dependency(id, ok, extra = {}) {
  return {
    id,
    ok: !!ok,
    required: true,
    ...extra,
  };
}

module.exports = {
  actionResult,
  atomResult,
  dependency,
  localIso,
};
