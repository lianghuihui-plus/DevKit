'use strict';

const path = require('node:path');
const { createRequire } = require('node:module');

// Use the installed XCUITest driver's own dependency, including hoisted installs.
// Importing the dependency does not connect to a device; only query() does.
function loadServices(driverPath) {
  if (!path.isAbsolute(driverPath || '')) throw new Error('XCUITest driver installPath must be absolute');
  const driverRequire = createRequire(path.join(driverPath, 'package.json'));
  const { services } = driverRequire('appium-ios-device');
  if (typeof services?.startInstallationProxyService !== 'function') {
    throw new Error('Installed XCUITest driver does not expose Installation Proxy');
  }
  return services;
}

async function query(services, device, appId) {
  if (!device) throw new Error('Missing target device');
  const connection = await services.startInstallationProxyService(device);
  try {
    const returnAttributes = ['CFBundleIdentifier', 'CFBundleDisplayName', 'CFBundleName',
      'CFBundleShortVersionString', 'CFBundleVersion', 'CFBundlePackageType', 'ApplicationType'];
    const applications = appId
      ? await connection.lookupApplications({ bundleIds: [appId], applicationType: 'Any', returnAttributes })
      : await connection.listApplications({ applicationType: 'Any', returnAttributes });
    if (!applications || typeof applications !== 'object' || Array.isArray(applications)) {
      throw new Error('Installation Proxy returned an invalid application map');
    }
    return { applications };
  } finally { await connection.close(); }
}

async function main(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    if (!['--driver', '--device', '--app'].includes(option) || !argv[index + 1] || Object.hasOwn(args, option)) {
      throw new Error('Invalid Installation Proxy query arguments');
    }
    args[option] = argv[index + 1];
  }
  const result = await query(loadServices(args['--driver']), args['--device'], args['--app']);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) main(process.argv.slice(2)).catch(error => {
  process.stderr.write(`${String(error.message || error).slice(0, 2000)}\n`);
  process.exitCode = 1;
});

module.exports = { loadServices, query };
