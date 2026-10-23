'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-plugin-test-config-'));
process.env.XDG_CONFIG_HOME = root;
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
