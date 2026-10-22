#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../platform/adapters/android/helper');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'helper_manifest.json'), 'utf8'));
const apk = fs.readFileSync(path.join(root, 'ArtemisAccessibilityHelper.apk'));
const source = fs.readFileSync(path.join(root, 'SOURCE.md'), 'utf8');

assert.strictEqual(manifest.package, 'com.artemis.helper');
assert.strictEqual(manifest.version_code, 7);
assert.strictEqual(manifest.version_name, '1.2.1');
assert.strictEqual(manifest.protocol_version, 2);
assert.strictEqual(crypto.createHash('sha256').update(apk).digest('hex'), manifest.sha256);
assert.ok(fs.readFileSync(path.join(root, 'LICENSE'), 'utf8').includes('Apache License'));
assert.ok(source.includes('google/artemis'));
assert.ok(source.includes('e85ec0203454aea47330c442be7cdf6664ae034cf9276843559fca90db575c1d'));

console.log('android helper bundle passed');
