import type { ExpoConfig } from 'expo/config';

/**
 * Store requirements (Section 14a):
 *  - Just-in-time permission rationale strings (iOS Info.plist / Android manifest).
 *  - Background location only for technicians while online / en route.
 *  - No contacts permission, ever — communication stays in-app / WhatsApp-relayed.
 *  - No IAP: this is a physical-service marketplace (boosts are a service fee, not a digital good).
 */
const config: ExpoConfig = {
  name: 'Handiwork-Deck',
  slug: 'handiwork-deck',
  scheme: 'handiwork',
  version: '0.1.0',
  orientation: 'portrait',
  userInterfaceStyle: 'automatic',
  newArchEnabled: true,
  icon: './assets/icon.png',
  ios: {
    bundleIdentifier: 'com.handiworkdeck.app',
    supportsTablet: false,
    googleServicesFile: process.env.GOOGLE_SERVICE_INFO_PLIST ?? './GoogleService-Info.plist',
    infoPlist: {
      NSLocationWhenInUseUsageDescription:
        'Handiwork-Deck uses your location to show technicians near you and, for technicians, to show customers where you are while you are online.',
      NSLocationAlwaysAndWhenInUseUsageDescription:
        'Technicians only: while you are online or travelling to a job, your location is shared with the customer so they can see your ETA. Sharing stops when you go offline.',
      NSCameraUsageDescription: 'Take photos of your work, receipts and price evidence.',
      NSPhotoLibraryUsageDescription: 'Choose portfolio photos, receipts and price evidence.',
      UIBackgroundModes: ['location', 'remote-notification'],
      ITSAppUsesNonExemptEncryption: false,
    },
    privacyManifests: {
      NSPrivacyAccessedAPITypes: [
        { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults', NSPrivacyAccessedAPITypeReasons: ['CA92.1'] },
      ],
    },
  },
  android: {
    package: 'com.handiworkdeck.app',
    googleServicesFile: process.env.GOOGLE_SERVICES_JSON ?? './google-services.json',
    adaptiveIcon: { foregroundImage: './assets/adaptive-icon.png', backgroundColor: '#0E3B2E' },
    permissions: [
      'ACCESS_COARSE_LOCATION',
      'ACCESS_FINE_LOCATION',
      'ACCESS_BACKGROUND_LOCATION',
      'FOREGROUND_SERVICE',
      'FOREGROUND_SERVICE_LOCATION',
      'CAMERA',
      'POST_NOTIFICATIONS',
    ],
    blockedPermissions: ['android.permission.READ_CONTACTS', 'android.permission.WRITE_CONTACTS'],
  },
  plugins: [
    'expo-router',
    '@react-native-firebase/app',
    '@react-native-firebase/auth',
    '@react-native-firebase/messaging',
    ['expo-build-properties', { ios: { useFrameworks: 'static' } }],
    [
      'expo-location',
      {
        isIosBackgroundLocationEnabled: true,
        isAndroidBackgroundLocationEnabled: true,
        isAndroidForegroundServiceEnabled: true,
      },
    ],
    ['expo-image-picker', { photosPermission: 'Choose portfolio photos, receipts and price evidence.' }],
  ],
  experiments: { typedRoutes: true },
  extra: {
    apiUrl: process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:4000',
    authMode: process.env.EXPO_PUBLIC_AUTH_MODE ?? 'firebase',
    eas: { projectId: process.env.EAS_PROJECT_ID },
  },
};

export default config;
