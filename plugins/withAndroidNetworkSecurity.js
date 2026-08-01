const { withAndroidManifest } = require('@expo/config-plugins');

/** Enforce HTTPS-only networking in every generated Android production app. */
module.exports = function withAndroidNetworkSecurity(config) {
  return withAndroidManifest(config, (androidConfig) => {
    const application = androidConfig.modResults.manifest.application?.[0];
    if (!application) {
      throw new Error('AndroidManifest application element is missing');
    }
    application.$['android:usesCleartextTraffic'] = 'false';
    return androidConfig;
  });
};
