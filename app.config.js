const appJson = require('./app.json');

/**
 * app.json stays the source of truth for everything; this wrapper exists
 * only to resolve google-services.json at build time.
 *
 * That file holds API keys for every app in the shared DispatchPH Firebase
 * project (KaysPay, kaysmarket, dispatchph), so it is gitignored rather
 * than committed. EAS supplies it as the GOOGLE_SERVICES_JSON file secret
 * and sets this variable to wherever it lands on the build machine; the
 * literal fallback is for local builds, where the file sits in the project
 * root after being downloaded from the Firebase console.
 *
 * Without this file present, Android push tokens are never issued —
 * expo-notifications fails silently, which is exactly how push came to be
 * broken for every user without a single error being logged.
 */
module.exports = {
  ...appJson.expo,
  android: {
    ...appJson.expo.android,
    googleServicesFile: process.env.GOOGLE_SERVICES_JSON ?? './google-services.json',
  },
};
