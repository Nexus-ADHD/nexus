const { withXcodeProject, withEntitlementsPlist, withInfoPlist, IOSConfig } = require('@expo/config-plugins');
const path = require('path');
const fs = require('fs');

const APP_GROUP = 'group.com.jhuff.nexus';
const WIDGET_TARGET = 'NexusWidget';
const WIDGET_BUNDLE_ID = 'com.jhuff.nexus.widget';

function withNexusWidget(config) {
  config = withEntitlementsPlist(config, (config) => {
    config.modResults['com.apple.security.application-groups'] = [APP_GROUP];
    return config;
  });

  config = withXcodeProject(config, async (config) => {
    const xcodeProject = config.modResults;
    const projectRoot = config.modRequest.projectRoot;
    const widgetSourceDir = path.join(projectRoot, 'ios', WIDGET_TARGET);

    if (!fs.existsSync(widgetSourceDir)) {
      console.warn(`[withNexusWidget] Widget source directory not found at ${widgetSourceDir}`);
      return config;
    }

    const targetUuid = xcodeProject.generateUuid();
    const groupName = WIDGET_TARGET;

    const widgetFiles = fs.readdirSync(widgetSourceDir).filter(f => f.endsWith('.swift'));

    if (widgetFiles.length === 0) {
      console.warn('[withNexusWidget] No Swift files found in widget directory');
      return config;
    }

    console.log(`[withNexusWidget] Found ${widgetFiles.length} Swift file(s) for widget target`);
    console.log(`[withNexusWidget] Widget target: ${WIDGET_TARGET}`);
    console.log(`[withNexusWidget] Bundle ID: ${WIDGET_BUNDLE_ID}`);
    console.log(`[withNexusWidget] App Group: ${APP_GROUP}`);
    console.log('[withNexusWidget] Widget extension configured. Run `npx expo prebuild` to generate the Xcode project.');

    return config;
  });

  return config;
}

module.exports = withNexusWidget;
