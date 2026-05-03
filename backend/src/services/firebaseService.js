/**
 * Firebase Cloud Messaging (FCM) service for "Ghost Node" wakeup.
 *
 * Sends invisible high-priority data payloads to sleeping Android devices
 * via Google's FCM infrastructure, piercing Deep Doze to boot MicService.
 *
 * Setup:
 *   1. Place your Firebase Admin SDK service account JSON in the backend root
 *      and set the FCM_SERVICE_ACCOUNT_PATH env var, OR
 *   2. Set GOOGLE_APPLICATION_CREDENTIALS env var to the JSON path.
 */

let admin = null;
let initialized = false;

function initFirebase() {
  if (initialized) return true;

  try {
    admin = require("firebase-admin");

    const rootJsonPath = require("path").join(__dirname, "../../firebase-adminsdk-key.json");
    const fs = require("fs");

    const serviceAccountPath =
      process.env.FCM_SERVICE_ACCOUNT_PATH ||
      process.env.GOOGLE_APPLICATION_CREDENTIALS ||
      (fs.existsSync(rootJsonPath) ? rootJsonPath : null);

    if (serviceAccountPath) {
      const serviceAccount = require(serviceAccountPath);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
      console.log(`🔥 Firebase Admin initialized with: ${serviceAccountPath}`);
    } else {
      // Try default credentials (works on GCP, Cloud Run, etc.)
      admin.initializeApp();
      console.log("🔥 Firebase Admin initialized with default credentials.");
    }

    initialized = true;
    return true;
  } catch (error) {
    console.warn(
      `⚠️  Firebase Admin not available: ${error.message}. FCM wakeup disabled.`
    );
    return false;
  }
}

/**
 * Send a high-priority invisible wakeup pulse to a device via FCM.
 * @param {string} fcmToken - The device's FCM registration token.
 * @returns {Promise<boolean>} true if the message was sent successfully.
 */
async function wakeDevice(fcmToken) {
  if (!fcmToken) return false;
  if (!initialized && !initFirebase()) return false;

  const message = {
    data: {
      command: "wakeup",
    },
    token: fcmToken,
    android: {
      priority: "high", // CRITICAL: This is what pierces Deep Doze
    },
  };

  try {
    const response = await admin.messaging().send(message);
    console.log(`🔥 Successfully sent FCM Wakeup pulse: ${response}`);
    return true;
  } catch (error) {
    console.error(`❌ Error sending FCM Wakeup pulse:`, error.message);
    // If the token is invalid/expired, return false so caller knows
    return false;
  }
}

// Try to initialize on module load (non-fatal if missing)
initFirebase();

module.exports = { wakeDevice, initFirebase };
