const { notarize } = require('@electron/notarize');
const { build } = require('../package.json');

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;  
  if (electronPlatformName !== 'darwin') {
    return;
  }

  console.log('Notarizing app...');
  
  // Skip if not running on CI and not explicitly set
  if (!process.env.CI && !process.env.NOTARIZE) {
    console.log('Skipping notarization');
    return;
  }
  
  // Skip if code signing is disabled
  if (process.env.CSC_IDENTITY_AUTO_DISCOVERY === 'false') {
    console.log('Code signing is disabled, skipping notarization');
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  
  try {
    await notarize({
      appBundleId: build.appId,
      appPath: `${appOutDir}/${appName}.app`,
      appleId: process.env.APPLE_ID,
      appleIdPassword: process.env.APPLE_ID_PASSWORD,
      teamId: process.env.APPLE_TEAM_ID,
    });
  } catch (error) {
    console.error('Notarization failed:', error);
  }
};