#!/usr/bin/env node
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const script = path.join(root, 'scripts/setup-dependencies.sh');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-setup-dependencies-'));

function executable(bin, name, body = 'exit 0') {
  const file = path.join(bin, name);
  fs.writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

function fixture(name, osName = 'Darwin') {
  const dir = path.join(temp, name);
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  executable(bin, 'uname', `printf '%s\\n' '${osName}'`);
  executable(bin, 'node');
  executable(bin, 'perl');
  return { dir, bin };
}

function run(args, fixtureValue, options = {}) {
  return childProcess.spawnSync('/bin/bash', [script, ...args], {
    cwd: root,
    encoding: 'utf8',
    input: options.input || '',
    env: {
      ...process.env,
      PATH: `${fixtureValue.bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: fixtureValue.dir,
      ...options.env,
    },
  });
}

try {
  const androidReady = fixture('android-ready');
  const sdk = path.join(androidReady.dir, 'android-sdk');
  fs.mkdirSync(path.join(sdk, 'platforms/android-35'), { recursive: true });
  fs.mkdirSync(path.join(sdk, 'build-tools/35.0.0'), { recursive: true });
  fs.writeFileSync(path.join(sdk, 'platforms/android-35/android.jar'), 'fixture');
  for (const tool of ['aapt', 'd8', 'apksigner']) {
    executable(path.join(sdk, 'build-tools/35.0.0'), tool);
  }
  for (const command of ['adb', 'java', 'javac']) executable(androidReady.bin, command);

  const ready = run(['--platform', 'android'], androidReady, {
    env: { ANDROID_HOME: sdk, ANDROID_SDK_ROOT: '' },
  });
  assert.strictEqual(ready.status, 0, ready.stderr || ready.stdout);
  assert.match(ready.stdout, /依赖已就绪/);
  assert.match(ready.stdout, /\[OK\] Android SDK Platform/);
  assert.match(ready.stdout, /\[OK\] Android SDK Build Tools/);

  const androidMissing = fixture('android-missing');
  const missing = run(['--platform', 'android'], androidMissing, {
    env: { ANDROID_HOME: '', ANDROID_SDK_ROOT: '' },
  });
  assert.strictEqual(missing.status, 1);
  assert.match(missing.stdout, /\[缺失\] adb/);
  assert.match(missing.stdout, /仍有依赖缺失/);

  const declined = fixture('ios-declined');
  executable(declined.bin, 'xcodebuild');
  executable(declined.bin, 'xcrun');
  const declinedLog = path.join(declined.dir, 'install.log');
  executable(declined.bin, 'npm', 'printf \'%s\\n\' "$*" >> "$MAVT_INSTALL_LOG"');
  const declinedResult = run(['--platform', 'ios', '--install'], declined, {
    input: 'n\n',
    env: { MAVT_INSTALL_LOG: declinedLog },
  });
  assert.strictEqual(declinedResult.status, 1);
  assert.match(declinedResult.stdout, /安装已取消/);
  assert.strictEqual(fs.existsSync(declinedLog), false);

  const iosInstall = fixture('ios-install');
  executable(iosInstall.bin, 'xcodebuild');
  executable(iosInstall.bin, 'xcrun');
  const installLog = path.join(iosInstall.dir, 'install.log');
  const driverState = path.join(iosInstall.dir, 'xcuitest-installed');
  executable(iosInstall.bin, 'npm', `
printf 'npm %s\\n' "$*" >> "$MAVT_INSTALL_LOG"
if [[ "$*" == "install -g appium" ]]; then
  cat > "$MAVT_TEST_BIN/appium" <<'APP'
#!/usr/bin/env bash
printf 'appium %s\\n' "$*" >> "$MAVT_INSTALL_LOG"
if [[ "\${1:-}" == "-v" ]]; then echo '2.0.0'; exit 0; fi
if [[ "\${1:-}" == "driver" && "\${2:-}" == "list" ]]; then
  [[ -f "$MAVT_DRIVER_STATE" ]] && echo '{"xcuitest":{"installed":true}}' || echo '{}'
  exit 0
fi
if [[ "\${1:-}" == "driver" && "\${2:-}" == "install" && "\${3:-}" == "xcuitest" ]]; then
  touch "$MAVT_DRIVER_STATE"
  exit 0
fi
exit 1
APP
  chmod +x "$MAVT_TEST_BIN/appium"
fi
`);
  const installed = run(['--platform', 'ios', '--install'], iosInstall, {
    input: 'y\n',
    env: {
      MAVT_INSTALL_LOG: installLog,
      MAVT_TEST_BIN: iosInstall.bin,
      MAVT_DRIVER_STATE: driverState,
    },
  });
  assert.strictEqual(installed.status, 0, installed.stderr || installed.stdout);
  assert.match(installed.stdout, /依赖已就绪/);
  assert.match(fs.readFileSync(installLog, 'utf8'), /npm install -g appium/);
  assert.match(fs.readFileSync(installLog, 'utf8'), /appium driver install xcuitest/);

  const harmony = fixture('harmony-manual');
  const harmonyResult = run(['--platform', 'harmony', '--install'], harmony, { input: 'y\n' });
  assert.strictEqual(harmonyResult.status, 1);
  assert.match(harmonyResult.stdout, /DevEco Studio 或 HarmonyOS Command Line Tools/);
  assert.match(harmonyResult.stdout, /仍有依赖缺失/);

  const androidManual = fixture('android-manual', 'Linux');
  const incompleteSdk = path.join(androidManual.dir, 'android-sdk');
  fs.mkdirSync(incompleteSdk, { recursive: true });
  for (const command of ['adb', 'java', 'javac']) executable(androidManual.bin, command);
  const androidManualResult = run(['--platform', 'android', '--install'], androidManual, {
    env: { ANDROID_HOME: incompleteSdk, ANDROID_SDK_ROOT: '' },
  });
  assert.strictEqual(androidManualResult.status, 1);
  assert.match(androidManualResult.stdout, /安装 Android SDK Command-line Tools/);
  assert.doesNotMatch(androidManualResult.stdout, /是否继续安装/);

  const iosUnsupported = fixture('ios-unsupported', 'Linux');
  executable(iosUnsupported.bin, 'npm');
  const iosUnsupportedResult = run(['--platform', 'ios', '--install'], iosUnsupported, { input: 'y\n' });
  assert.strictEqual(iosUnsupportedResult.status, 1);
  assert.match(iosUnsupportedResult.stdout, /iOS 自动化测试必须在 macOS 上运行/);
  assert.doesNotMatch(iosUnsupportedResult.stdout, /是否继续安装/);

  const invalid = run(['--platform', 'windows'], fixture('invalid'));
  assert.strictEqual(invalid.status, 2);
  assert.match(invalid.stderr, /android\|harmony\|ios/);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log('setup dependencies passed');
