/**
 * add-native-targets.js
 *
 * Patches the Xcode project (project.pbxproj) to add:
 *   1. NexusWidget — WidgetKit extension (iOS 16+ home/lock screen widgets)
 *
 * Also writes App Groups entitlement files for main app and widget.
 *
 * NOTE: watchOS target intentionally excluded — adding a watchOS target to
 * an iOS-only workspace causes xcodebuild SPM resolution to crash.
 *
 * Run: node scripts/add-native-targets.js
 * Called by EAS prebuildCommand after `npx expo prebuild`.
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const PBXPROJ = path.join(PROJECT_ROOT, 'ios', 'Nexus.xcodeproj', 'project.pbxproj');
const IOS_DIR = path.join(PROJECT_ROOT, 'ios');
const APP_GROUP = 'group.com.jhuff.nexus';
const WIDGET_BUNDLE = 'com.jhuff.nexus.NexusWidget';
// Your Apple Developer team ID (10 characters). Set APPLE_TEAM_ID in the environment.
const TEAM_ID = process.env.APPLE_TEAM_ID || '""';

// Stable UUIDs — all unique
const IDs = {
  WIDGET_CONTAINER_PROXY:  'AA0000000000000000000DAA', // PBXContainerItemProxy
  WIDGET_TARGET_DEP:       'AA00000000000000000010AA', // PBXTargetDependency
  WIDGET_NATIVE_TARGET:   'AA00000000000000000001AA', // PBXNativeTarget
  WIDGET_PRODUCT_REF:     'AA00000000000000000011AA', // PBXFileReference for .appex product
  WIDGET_SWIFT_FILE:      'AA00000000000000000002AA', // PBXFileReference for .swift source
  WIDGET_INFOPLIST_FILE:  'AA00000000000000000003AA', // PBXFileReference for Info.plist
  WIDGET_ENTITLEMENTS_FILE:'AA00000000000000000013AA', // PBXFileReference for .entitlements
  WIDGET_SWIFT_BUILD:     'AA00000000000000000004AA', // PBXBuildFile (swift in sources)
  WIDGET_PLIST_BUILD:     'AA00000000000000000005AA', // PBXBuildFile (plist in resources)
  WIDGET_GROUP:           'AA00000000000000000006AA', // PBXGroup
  WIDGET_FRAMEWORKS:      'AA00000000000000000007AA', // PBXFrameworksBuildPhase
  WIDGET_RESOURCES:       'AA00000000000000000008AA', // PBXResourcesBuildPhase
  WIDGET_SOURCES:         'AA00000000000000000009AA', // PBXSourcesBuildPhase
  WIDGET_CONFIG_DEBUG:    'AA0000000000000000000AAA', // XCBuildConfiguration Debug
  WIDGET_CONFIG_RELEASE:  'AA0000000000000000000BAA', // XCBuildConfiguration Release
  WIDGET_CONFIGLIST:      'AA0000000000000000000CAA', // XCConfigurationList
  WIDGET_EMBED_BUILD:     'AA0000000000000000000EAA', // PBXBuildFile for embed
  WIDGET_EMBED_PHASE:     'AA0000000000000000000FAA', // PBXCopyFilesBuildPhase (embed extensions)
  WIDGET_JPG_FILE:        'AA00000000000000000014AA', // PBXFileReference for night-sky-bg.jpg
  WIDGET_JPG_BUILD:       'AA00000000000000000015AA', // PBXBuildFile (jpg in resources)
  WIDGET_FONT_BUILD:      'AA00000000000000000016AA', // PBXBuildFile (Fraunces ttf in resources)
  WIDGET_FONT_FILE:       'AA00000000000000000017AA', // PBXFileReference for Fraunces-LightItalic.ttf
  WIDGET_INTER_MEDIUM_FILE:  'AA00000000000000000018AA', // PBXFileReference for Inter-Medium.ttf (brand font, mirrors src/theme/tokens.ts)
  WIDGET_INTER_MEDIUM_BUILD: 'AA00000000000000000019AA', // PBXBuildFile (Inter-Medium.ttf in resources)
  WIDGET_INTER_SEMIBOLD_FILE:  'AA0000000000000000001AAA', // PBXFileReference for Inter-SemiBold.ttf (brand font, mirrors src/theme/tokens.ts)
  WIDGET_INTER_SEMIBOLD_BUILD: 'AA0000000000000000001BAA', // PBXBuildFile (Inter-SemiBold.ttf in resources)
  WIDGET_INTER_BOLD_FILE:  'AA0000000000000000001CAA', // PBXFileReference for Inter-Bold.ttf (brand font, mirrors src/theme/tokens.ts)
  WIDGET_INTER_BOLD_BUILD: 'AA0000000000000000001DAA', // PBXBuildFile (Inter-Bold.ttf in resources)
  WIDGET_IBMPLEXMONO_MEDIUM_FILE:  'AA0000000000000000001EAA', // PBXFileReference for IBMPlexMono-Medium.ttf (brand font, mirrors src/theme/tokens.ts)
  WIDGET_IBMPLEXMONO_MEDIUM_BUILD: 'AA0000000000000000001FAA', // PBXBuildFile (IBMPlexMono-Medium.ttf in resources)
};

function readProj() {
  return fs.readFileSync(PBXPROJ, 'utf8');
}

function writeProj(content) {
  fs.writeFileSync(PBXPROJ, content, 'utf8');
}

// Copy Swift + plist files from native-targets/NexusWidget into ios/NexusWidget
function copyWidgetFiles() {
  const srcDir = path.join(PROJECT_ROOT, 'native-targets', 'NexusWidget');
  const destDir = path.join(IOS_DIR, 'NexusWidget');

  if (!fs.existsSync(srcDir)) {
    console.error(`[add-native-targets] ERROR: native-targets/NexusWidget not found at ${srcDir}`);
    process.exit(1);
  }

  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  const files = fs.readdirSync(srcDir);
  for (const file of files) {
    fs.copyFileSync(path.join(srcDir, file), path.join(destDir, file));
    console.log(`[add-native-targets] Copied ${file} -> ios/NexusWidget/${file}`);
  }
}

// Sync the widget Info.plist version literals from app.json. This project
// versions via plist literals, not MARKETING_VERSION build settings (the
// main target's pbxproj still says 1.0/1 — prebuild writes the real
// numbers into the app's Info.plist from app.json). App Store validation
// requires the appex CFBundleShortVersionString/CFBundleVersion to match
// the host app exactly, so mirror the same source of truth here. For
// manual Xcode archives: bump app.json, then run this script.
function syncWidgetVersion() {
  const appJson = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'app.json'), 'utf8'));
  const marketingVersion = appJson?.expo?.version;
  const buildNumber = appJson?.expo?.ios?.buildNumber;
  if (!marketingVersion || !buildNumber) {
    console.warn('[add-native-targets] WARNING: expo.version / expo.ios.buildNumber missing from app.json — widget plist versions left as-is');
    return;
  }
  const plistPath = path.join(IOS_DIR, 'NexusWidget', 'Info.plist');
  let plist = fs.readFileSync(plistPath, 'utf8');
  plist = plist.replace(
    /(<key>CFBundleShortVersionString<\/key>\s*<string>)[^<]*(<\/string>)/,
    `$1${marketingVersion}$2`
  );
  plist = plist.replace(
    /(<key>CFBundleVersion<\/key>\s*<string>)[^<]*(<\/string>)/,
    `$1${buildNumber}$2`
  );
  fs.writeFileSync(plistPath, plist);
  console.log(`[add-native-targets] Widget Info.plist versions synced from app.json: ${marketingVersion} (${buildNumber})`);
}

// Write entitlements file for widget
function writeWidgetEntitlements() {
  const entPath = path.join(IOS_DIR, 'NexusWidget', 'NexusWidget.entitlements');
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>com.apple.security.application-groups</key>
	<array>
		<string>${APP_GROUP}</string>
	</array>
</dict>
</plist>`;
  fs.writeFileSync(entPath, content);
  console.log('[add-native-targets] Written NexusWidget.entitlements');
}

// Brand fonts bundled with the widget (mirrors src/theme/tokens.ts `font`; the
// Swift NexusFont helper asks for these by PostScript name). Fraunces is wired
// by the original injection and is the anchor every widget project already has.
const WIDGET_FONTS = [
  { file: 'Inter-Medium.ttf',       ref: IDs.WIDGET_INTER_MEDIUM_FILE,       build: IDs.WIDGET_INTER_MEDIUM_BUILD },
  { file: 'Inter-SemiBold.ttf',     ref: IDs.WIDGET_INTER_SEMIBOLD_FILE,     build: IDs.WIDGET_INTER_SEMIBOLD_BUILD },
  { file: 'Inter-Bold.ttf',         ref: IDs.WIDGET_INTER_BOLD_FILE,         build: IDs.WIDGET_INTER_BOLD_BUILD },
  { file: 'IBMPlexMono-Medium.ttf', ref: IDs.WIDGET_IBMPLEXMONO_MEDIUM_FILE, build: IDs.WIDGET_IBMPLEXMONO_MEDIUM_BUILD },
];

// Idempotent: a project that already carries the widget target (the tracked
// ios/Nexus.xcodeproj, or a rebuild that skips `expo prebuild --clean`) gets
// each missing font's PBXFileReference, PBXBuildFile, group child and
// NexusWidget resources-phase entry inserted after the Fraunces anchors.
// Without this the widget declares the fonts in Info.plist, asks for them by
// name, and silently falls back to the system face (Greptile P1 on PR #491).
function backfillWidgetFonts(proj) {
  const anchors = {
    build: `\t\t${IDs.WIDGET_FONT_BUILD} /* Fraunces-LightItalic.ttf in Resources */ = {isa = PBXBuildFile; fileRef = ${IDs.WIDGET_FONT_FILE} /* Fraunces-LightItalic.ttf */; };`,
    ref:   `\t\t${IDs.WIDGET_FONT_FILE} /* Fraunces-LightItalic.ttf */ = {isa = PBXFileReference; lastKnownFileType = file; path = "Fraunces-LightItalic.ttf"; sourceTree = "<group>"; };`,
    child: `\t\t\t\t${IDs.WIDGET_FONT_FILE} /* Fraunces-LightItalic.ttf */,`,
    phase: `\t\t\t\t${IDs.WIDGET_FONT_BUILD} /* Fraunces-LightItalic.ttf in Resources */,`,
  };
  for (const key of Object.keys(anchors)) {
    if (!proj.includes(anchors[key])) {
      console.error(`[add-native-targets] ERROR: Fraunces ${key} anchor missing — cannot backfill widget fonts`);
      process.exit(1);
    }
  }
  for (const f of WIDGET_FONTS) {
    // Each of the four entries is checked and inserted on its own, so a
    // project left half-wired (say a build file without its file reference)
    // is repaired rather than skipped.
    const entries = {
      build: `\t\t${f.build} /* ${f.file} in Resources */ = {isa = PBXBuildFile; fileRef = ${f.ref} /* ${f.file} */; };`,
      ref:   `\t\t${f.ref} /* ${f.file} */ = {isa = PBXFileReference; lastKnownFileType = file; path = "${f.file}"; sourceTree = "<group>"; };`,
      child: `\t\t\t\t${f.ref} /* ${f.file} */,`,
      phase: `\t\t\t\t${f.build} /* ${f.file} in Resources */,`,
    };
    const added = [];
    for (const key of Object.keys(entries)) {
      if (proj.includes(entries[key])) continue;
      proj = proj.replace(anchors[key], `${anchors[key]}\n${entries[key]}`);
      added.push(key);
    }
    if (added.length) console.log(`[add-native-targets] Backfilled ${f.file} into the NexusWidget project (${added.join(', ')})`);
  }
  return proj;
}

// Patch project.pbxproj to add the widget target
function patchPbxproj() {
  let proj = readProj();

  if (proj.includes('NexusWidget') && proj.includes(IDs.WIDGET_NATIVE_TARGET)) {
    console.log('[add-native-targets] Already patched — backfilling any missing widget font resources');
    const backfilled = backfillWidgetFonts(proj);
    if (backfilled !== proj) writeProj(backfilled);
    return;
  }

  // ── PBXBuildFile ─────────────────────────────────────────────────────────
  proj = proj.replace(
    '/* Begin PBXBuildFile section */',
    `/* Begin PBXBuildFile section */
		${IDs.WIDGET_SWIFT_BUILD} /* NexusWidget.swift in Sources */ = {isa = PBXBuildFile; fileRef = ${IDs.WIDGET_SWIFT_FILE} /* NexusWidget.swift */; };
		${IDs.WIDGET_JPG_BUILD} /* night-sky-bg.jpg in Resources */ = {isa = PBXBuildFile; fileRef = ${IDs.WIDGET_JPG_FILE} /* night-sky-bg.jpg */; };
		${IDs.WIDGET_FONT_BUILD} /* Fraunces-LightItalic.ttf in Resources */ = {isa = PBXBuildFile; fileRef = ${IDs.WIDGET_FONT_FILE} /* Fraunces-LightItalic.ttf */; };
		${IDs.WIDGET_INTER_MEDIUM_BUILD} /* Inter-Medium.ttf in Resources */ = {isa = PBXBuildFile; fileRef = ${IDs.WIDGET_INTER_MEDIUM_FILE} /* Inter-Medium.ttf */; };
		${IDs.WIDGET_INTER_SEMIBOLD_BUILD} /* Inter-SemiBold.ttf in Resources */ = {isa = PBXBuildFile; fileRef = ${IDs.WIDGET_INTER_SEMIBOLD_FILE} /* Inter-SemiBold.ttf */; };
		${IDs.WIDGET_INTER_BOLD_BUILD} /* Inter-Bold.ttf in Resources */ = {isa = PBXBuildFile; fileRef = ${IDs.WIDGET_INTER_BOLD_FILE} /* Inter-Bold.ttf */; };
		${IDs.WIDGET_IBMPLEXMONO_MEDIUM_BUILD} /* IBMPlexMono-Medium.ttf in Resources */ = {isa = PBXBuildFile; fileRef = ${IDs.WIDGET_IBMPLEXMONO_MEDIUM_FILE} /* IBMPlexMono-Medium.ttf */; };
		${IDs.WIDGET_EMBED_BUILD} /* NexusWidget.appex in Embed Foundation Extensions */ = {isa = PBXBuildFile; fileRef = ${IDs.WIDGET_PRODUCT_REF} /* NexusWidget.appex */; settings = {ATTRIBUTES = (RemoveHeadersOnCopy, ); }; };`
  );

  // ── PBXFileReference ─────────────────────────────────────────────────────
  proj = proj.replace(
    '/* Begin PBXFileReference section */',
    `/* Begin PBXFileReference section */
		${IDs.WIDGET_SWIFT_FILE} /* NexusWidget.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = NexusWidget.swift; sourceTree = "<group>"; };
		${IDs.WIDGET_INFOPLIST_FILE} /* Info.plist */ = {isa = PBXFileReference; lastKnownFileType = text.plist.xml; path = Info.plist; sourceTree = "<group>"; };
		${IDs.WIDGET_ENTITLEMENTS_FILE} /* NexusWidget.entitlements */ = {isa = PBXFileReference; lastKnownFileType = text.plist.entitlements; path = NexusWidget.entitlements; sourceTree = "<group>"; };
		${IDs.WIDGET_JPG_FILE} /* night-sky-bg.jpg */ = {isa = PBXFileReference; lastKnownFileType = image.jpeg; path = "night-sky-bg.jpg"; sourceTree = "<group>"; };
		${IDs.WIDGET_FONT_FILE} /* Fraunces-LightItalic.ttf */ = {isa = PBXFileReference; lastKnownFileType = file; path = "Fraunces-LightItalic.ttf"; sourceTree = "<group>"; };
		${IDs.WIDGET_INTER_MEDIUM_FILE} /* Inter-Medium.ttf */ = {isa = PBXFileReference; lastKnownFileType = file; path = "Inter-Medium.ttf"; sourceTree = "<group>"; };
		${IDs.WIDGET_INTER_SEMIBOLD_FILE} /* Inter-SemiBold.ttf */ = {isa = PBXFileReference; lastKnownFileType = file; path = "Inter-SemiBold.ttf"; sourceTree = "<group>"; };
		${IDs.WIDGET_INTER_BOLD_FILE} /* Inter-Bold.ttf */ = {isa = PBXFileReference; lastKnownFileType = file; path = "Inter-Bold.ttf"; sourceTree = "<group>"; };
		${IDs.WIDGET_IBMPLEXMONO_MEDIUM_FILE} /* IBMPlexMono-Medium.ttf */ = {isa = PBXFileReference; lastKnownFileType = file; path = "IBMPlexMono-Medium.ttf"; sourceTree = "<group>"; };
		${IDs.WIDGET_PRODUCT_REF} /* NexusWidget.appex */ = {isa = PBXFileReference; explicitFileType = "wrapper.app-extension"; includeInIndex = 0; path = NexusWidget.appex; sourceTree = BUILT_PRODUCTS_DIR; };`
  );

  // ── PBXFrameworksBuildPhase ───────────────────────────────────────────────
  proj = proj.replace(
    '/* Begin PBXFrameworksBuildPhase section */',
    `/* Begin PBXFrameworksBuildPhase section */
		${IDs.WIDGET_FRAMEWORKS} /* Frameworks */ = {
			isa = PBXFrameworksBuildPhase;
			buildActionMask = 2147483647;
			files = (
			);
			runOnlyForDeploymentPostprocessing = 0;
		};`
  );

  // ── PBXContainerItemProxy + PBXTargetDependency ────────────────────────────
  // Find the PBXProject's containerPortal UUID
  const containerPortalMatch = proj.match(/([A-F0-9]{24}) \/\* Project object \*\/ = \{/);
  const containerPortal = containerPortalMatch ? containerPortalMatch[1] : 'MISSING_CONTAINER';

  const containerProxyBlock = `
		${IDs.WIDGET_CONTAINER_PROXY} /* PBXContainerItemProxy */ = {
			isa = PBXContainerItemProxy;
			containerPortal = ${containerPortal} /* Project object */;
			proxyType = 1;
			remoteGlobalIDString = ${IDs.WIDGET_NATIVE_TARGET};
			remoteInfo = NexusWidget;
		};`;

  const targetDepBlock = `
		${IDs.WIDGET_TARGET_DEP} /* PBXTargetDependency */ = {
			isa = PBXTargetDependency;
			target = ${IDs.WIDGET_NATIVE_TARGET} /* NexusWidget */;
			targetProxy = ${IDs.WIDGET_CONTAINER_PROXY} /* PBXContainerItemProxy */;
		};`;

  if (proj.includes('/* Begin PBXContainerItemProxy section */')) {
    proj = proj.replace('/* Begin PBXContainerItemProxy section */', `/* Begin PBXContainerItemProxy section */${containerProxyBlock}`);
  } else {
    // Inject both sections before CopyFiles (or XCBuildConfiguration if no CopyFiles)
    const insertBefore = proj.includes('/* Begin PBXCopyFilesBuildPhase section */')
      ? '/* Begin PBXCopyFilesBuildPhase section */'
      : '/* Begin XCBuildConfiguration section */';
    proj = proj.replace(insertBefore,
      `/* Begin PBXContainerItemProxy section */${containerProxyBlock}
		/* End PBXContainerItemProxy section */

		/* Begin PBXTargetDependency section */${targetDepBlock}
		/* End PBXTargetDependency section */

		${insertBefore}`);
  }

  if (proj.includes('/* Begin PBXTargetDependency section */') && !proj.includes(IDs.WIDGET_TARGET_DEP)) {
    proj = proj.replace('/* Begin PBXTargetDependency section */', `/* Begin PBXTargetDependency section */${targetDepBlock}`);
  }

  // ── PBXGroup (widget group + add to main group) ───────────────────────────
  proj = proj.replace(
    '/* Begin PBXGroup section */',
    `/* Begin PBXGroup section */
		${IDs.WIDGET_GROUP} /* NexusWidget */ = {
			isa = PBXGroup;
			children = (
				${IDs.WIDGET_SWIFT_FILE} /* NexusWidget.swift */,
				${IDs.WIDGET_INFOPLIST_FILE} /* Info.plist */,
				${IDs.WIDGET_ENTITLEMENTS_FILE} /* NexusWidget.entitlements */,
				${IDs.WIDGET_JPG_FILE} /* night-sky-bg.jpg */,
				${IDs.WIDGET_FONT_FILE} /* Fraunces-LightItalic.ttf */,
				${IDs.WIDGET_INTER_MEDIUM_FILE} /* Inter-Medium.ttf */,
				${IDs.WIDGET_INTER_SEMIBOLD_FILE} /* Inter-SemiBold.ttf */,
				${IDs.WIDGET_INTER_BOLD_FILE} /* Inter-Bold.ttf */,
				${IDs.WIDGET_IBMPLEXMONO_MEDIUM_FILE} /* IBMPlexMono-Medium.ttf */,
			);
			name = NexusWidget;
			path = NexusWidget;
			sourceTree = "<group>";
		};`
  );

  // Add widget group to the main group's children (find the main group that has "Nexus" child)
  // Inject widget group into root PBXGroup (83CBB9F6... contains Nexus, Libraries, Products)
  {
    const rootGroupMatch = proj.match(/83CBB9F6[A-F0-9]+ = \{\s*isa = PBXGroup;\s*children = \(/);
    if (rootGroupMatch) {
      const afterOpen = rootGroupMatch.index + rootGroupMatch[0].length;
      const closeIdx = proj.indexOf(');', afterOpen);
      if (closeIdx !== -1 && !proj.slice(afterOpen, closeIdx).includes(IDs.WIDGET_GROUP)) {
        proj = proj.slice(0, closeIdx) +
          '\n\t\t\t\t' + IDs.WIDGET_GROUP + ' /* NexusWidget */,' +
          proj.slice(closeIdx);
        console.log('[add-native-targets] Injected widget group into root PBXGroup');
      }
    } else {
      console.error('[add-native-targets] WARNING: Could not find root PBXGroup to inject widget group');
    }
  }

  // ── PBXNativeTarget ───────────────────────────────────────────────────────
  proj = proj.replace(
    '/* Begin PBXNativeTarget section */',
    `/* Begin PBXNativeTarget section */
		${IDs.WIDGET_NATIVE_TARGET} /* NexusWidget */ = {
			isa = PBXNativeTarget;
			buildConfigurationList = ${IDs.WIDGET_CONFIGLIST} /* Build configuration list for PBXNativeTarget "NexusWidget" */;
			buildPhases = (
				${IDs.WIDGET_SOURCES} /* Sources */,
				${IDs.WIDGET_FRAMEWORKS} /* Frameworks */,
				${IDs.WIDGET_RESOURCES} /* Resources */,
			);
			buildRules = (
			);
			dependencies = (
			);
			name = NexusWidget;
			productName = NexusWidget;
			productReference = ${IDs.WIDGET_PRODUCT_REF} /* NexusWidget.appex */;
			productType = "com.apple.product-type.app-extension";
		};`
  );

  // ── PBXResourcesBuildPhase ────────────────────────────────────────────────
  proj = proj.replace(
    '/* Begin PBXResourcesBuildPhase section */',
    `/* Begin PBXResourcesBuildPhase section */
		${IDs.WIDGET_RESOURCES} /* Resources */ = {
			isa = PBXResourcesBuildPhase;
			buildActionMask = 2147483647;
			files = (
				${IDs.WIDGET_JPG_BUILD} /* night-sky-bg.jpg in Resources */,
				${IDs.WIDGET_FONT_BUILD} /* Fraunces-LightItalic.ttf in Resources */,
				${IDs.WIDGET_INTER_MEDIUM_BUILD} /* Inter-Medium.ttf in Resources */,
				${IDs.WIDGET_INTER_SEMIBOLD_BUILD} /* Inter-SemiBold.ttf in Resources */,
				${IDs.WIDGET_INTER_BOLD_BUILD} /* Inter-Bold.ttf in Resources */,
				${IDs.WIDGET_IBMPLEXMONO_MEDIUM_BUILD} /* IBMPlexMono-Medium.ttf in Resources */,
			);
			runOnlyForDeploymentPostprocessing = 0;
		};`
  );

  // ── PBXSourcesBuildPhase ──────────────────────────────────────────────────
  proj = proj.replace(
    '/* Begin PBXSourcesBuildPhase section */',
    `/* Begin PBXSourcesBuildPhase section */
		${IDs.WIDGET_SOURCES} /* Sources */ = {
			isa = PBXSourcesBuildPhase;
			buildActionMask = 2147483647;
			files = (
				${IDs.WIDGET_SWIFT_BUILD} /* NexusWidget.swift in Sources */,
			);
			runOnlyForDeploymentPostprocessing = 0;
		};`
  );

  // ── Add widget target to PBXProject targets list ──────────────────────────
  proj = proj.replace(
    /targets = \(\n([\t ]+[A-F0-9]+ \/\* Nexus \*\/,)/,
    `targets = (\n$1\n\t\t\t\t${IDs.WIDGET_NATIVE_TARGET} /* NexusWidget */,`
  );

  // ── Add widget dependency to main Nexus target's dependencies array ────────
  // Find the main Nexus PBXNativeTarget and add the dependency reference
  // Inject widget dependency into main Nexus PBXNativeTarget
  // Must match PBXNativeTarget specifically, not PBXGroup (both have /* Nexus */ = {)
  {
    // Find the PBXNativeTarget block for Nexus (contains isa = PBXNativeTarget)
    const nativeTargetMatch = proj.match(/\/\* Nexus \*\/ = \{\s*isa = PBXNativeTarget;[\s\S]*?dependencies = \(/);
    if (nativeTargetMatch) {
      const depsOpenIdx = nativeTargetMatch.index + nativeTargetMatch[0].length;
      // Find the closing ); of this dependencies array
      const closeDepIdx = proj.indexOf(');', depsOpenIdx);
      if (closeDepIdx !== -1 && !proj.slice(depsOpenIdx, closeDepIdx).includes(IDs.WIDGET_TARGET_DEP)) {
        proj = proj.slice(0, closeDepIdx) +
          '\n\t\t\t\t' + IDs.WIDGET_TARGET_DEP + ' /* PBXTargetDependency */,\n\t\t\t' +
          proj.slice(closeDepIdx);
        console.log('[add-native-targets] Injected widget dep into Nexus PBXNativeTarget dependencies');
      } else if (proj.slice(depsOpenIdx, closeDepIdx).includes(IDs.WIDGET_TARGET_DEP)) {
        console.log('[add-native-targets] Widget dep already present in Nexus target');
      }
    } else {
      console.error('[add-native-targets] ERROR: Could not find Nexus PBXNativeTarget dependencies block');
    }
  }

  // ── Add Embed Foundation Extensions phase to main Nexus target ───────────
  // Find the main Nexus target's buildPhases list and append the embed phase
  // Inject embed phase into Nexus buildPhases using [CP] Copy Pods Resources anchor
  if (!proj.includes(IDs.WIDGET_EMBED_PHASE + ' /* Embed Foundation Extensions */,')) {
    const cpAnchor = '/* [CP] Copy Pods Resources */';
    const cpIdx = proj.indexOf(cpAnchor);
    if (cpIdx !== -1) {
      const lineEnd = proj.indexOf('\n', cpIdx);
      const closeIdx = proj.indexOf('\n\t\t\t);', lineEnd);
      if (closeIdx !== -1) {
        proj = proj.slice(0, closeIdx) +
          '\n\t\t\t\t' + IDs.WIDGET_EMBED_PHASE + ' /* Embed Foundation Extensions */,' +
          proj.slice(closeIdx);
        console.log('[add-native-targets] Injected embed phase into Nexus buildPhases');
      } else {
        console.warn('[add-native-targets] WARNING: Could not find closing ); after CP Resources');
      }
    } else {
      console.warn('[add-native-targets] WARNING: [CP] Copy Pods Resources not found');
    }
  } else {
    console.log('[add-native-targets] Embed phase already in buildPhases');
  }

  // ── PBXCopyFilesBuildPhase (embed widget extension) ───────────────────────
  // Insert into CopyFiles section if it exists, otherwise inject before XCBuildConfiguration
  const embedPhaseBlock = `
		${IDs.WIDGET_EMBED_PHASE} /* Embed Foundation Extensions */ = {
			isa = PBXCopyFilesBuildPhase;
			buildActionMask = 2147483647;
			dstPath = "";
			dstSubfolderSpec = 13;
			files = (
				${IDs.WIDGET_EMBED_BUILD} /* NexusWidget.appex in Embed Foundation Extensions */,
			);
			name = "Embed Foundation Extensions";
			runOnlyForDeploymentPostprocessing = 0;
		};`;

  if (proj.includes('/* Begin PBXCopyFilesBuildPhase section */')) {
    proj = proj.replace(
      '/* Begin PBXCopyFilesBuildPhase section */',
      `/* Begin PBXCopyFilesBuildPhase section */${embedPhaseBlock}`
    );
  } else {
    proj = proj.replace(
      '/* Begin XCBuildConfiguration section */',
      `/* Begin PBXCopyFilesBuildPhase section */${embedPhaseBlock}\n\t\t/* End PBXCopyFilesBuildPhase section */\n\n\t\t/* Begin XCBuildConfiguration section */`
    );
  }

  // ── XCBuildConfiguration ──────────────────────────────────────────────────
  proj = proj.replace(
    '/* Begin XCBuildConfiguration section */',
    `/* Begin XCBuildConfiguration section */
		${IDs.WIDGET_CONFIG_DEBUG} /* Debug */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				ALWAYS_EMBED_SWIFT_STANDARD_LIBRARIES = NO;
				CODE_SIGN_ENTITLEMENTS = "NexusWidget/NexusWidget.entitlements";
				DEVELOPMENT_TEAM = ${TEAM_ID};
				INFOPLIST_FILE = "NexusWidget/Info.plist";
				IPHONEOS_DEPLOYMENT_TARGET = 17.0;
				PRODUCT_BUNDLE_IDENTIFIER = "${WIDGET_BUNDLE}";
				PRODUCT_NAME = NexusWidget;
				SKIP_INSTALL = YES;
				SWIFT_VERSION = 5.0;
				TARGETED_DEVICE_FAMILY = "1,2";
			};
			name = Debug;
		};
		${IDs.WIDGET_CONFIG_RELEASE} /* Release */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				ALWAYS_EMBED_SWIFT_STANDARD_LIBRARIES = NO;
				CODE_SIGN_ENTITLEMENTS = "NexusWidget/NexusWidget.entitlements";
				DEVELOPMENT_TEAM = ${TEAM_ID};
				INFOPLIST_FILE = "NexusWidget/Info.plist";
				IPHONEOS_DEPLOYMENT_TARGET = 17.0;
				PRODUCT_BUNDLE_IDENTIFIER = "${WIDGET_BUNDLE}";
				PRODUCT_NAME = NexusWidget;
				SKIP_INSTALL = YES;
				SWIFT_VERSION = 5.0;
				TARGETED_DEVICE_FAMILY = "1,2";
			};
			name = Release;
		};`
  );

  // ── XCConfigurationList ───────────────────────────────────────────────────
  proj = proj.replace(
    '/* Begin XCConfigurationList section */',
    `/* Begin XCConfigurationList section */
		${IDs.WIDGET_CONFIGLIST} /* Build configuration list for PBXNativeTarget "NexusWidget" */ = {
			isa = XCConfigurationList;
			buildConfigurations = (
				${IDs.WIDGET_CONFIG_DEBUG} /* Debug */,
				${IDs.WIDGET_CONFIG_RELEASE} /* Release */,
			);
			defaultConfigurationIsVisible = 0;
			defaultConfigurationName = Release;
		};`
  );

  writeProj(proj);
  console.log('[add-native-targets] ✅ pbxproj patched with NexusWidget target');
}

// Gymfile removed - conflicts with EAS Fastlane config

// ── Main ──────────────────────────────────────────────────────────────────────
function writeGemfile() {
  if (!fs.existsSync(IOS_DIR)) {
    console.log('[add-native-targets] ios/ not found, skipping Gemfile write');
    return;
  }
  const gemfilePath = path.join(IOS_DIR, 'Gemfile');
  if (!fs.existsSync(gemfilePath)) {
    const gemfileContent = 'source "https://rubygems.org"\n\ngem "cocoapods", ">= 1.13", "!= 1.15.1"\ngem "fastlane"\n';
    fs.writeFileSync(gemfilePath, gemfileContent);
    console.log('[add-native-targets] Written ios/Gemfile');
  } else {
    console.log('[add-native-targets] ios/Gemfile already exists');
  }
}

// Stable UUIDs for WidgetReloader files in main Nexus target
// Pattern: ObjC .m registers RCT module, Swift file exports C symbol via @_cdecl (no RCT types in Swift)
const RELOADER_H_REF        = 'BB00000000000000000001BB'; // PBXFileReference WidgetReloader.h
const RELOADER_M_REF        = 'BB00000000000000000002BB'; // PBXFileReference WidgetReloader.m
const RELOADER_SW_REF       = 'BB00000000000000000003BB'; // PBXFileReference WidgetReloaderBridge.swift
const RELOADER_M_BUILD      = 'BB00000000000000000004BB'; // PBXBuildFile .m in Sources
const RELOADER_WK_REF       = 'BB00000000000000000005BB'; // PBXFileReference WidgetKit.framework
const RELOADER_WK_BUILD     = 'BB00000000000000000006BB'; // PBXBuildFile WidgetKit in Frameworks
const RELOADER_SW_BUILD     = 'BB00000000000000000007BB'; // PBXBuildFile .swift in Sources
const MAIN_SOURCES_PHASE    = '13B07F871A680F5B00A75B9A'; // main Nexus PBXSourcesBuildPhase
const MAIN_FRAMEWORKS_PHASE = '13B07F8C1A680F5B00A75B9A'; // main Nexus PBXFrameworksBuildPhase
const APPDELEGATE_ANCHOR    = 'F11748422D0307B40044C1D9 /* AppDelegate.swift in Sources */,'; // anchor

/**
 * Copies WidgetReloader.h + .m (pure ObjC) into ios/Nexus/ and injects them
 * into the main Nexus PBXSourcesBuildPhase. Also links WidgetKit.framework
 * to the main app target so [WidgetCenter reloadAllTimelines] is available.
 */
function injectWidgetReloader() {
  const srcDir  = path.join(PROJECT_ROOT, 'native-targets', 'Nexus');
  const destDir = path.join(IOS_DIR, 'Nexus');

  if (!fs.existsSync(srcDir)) {
    console.log('[add-native-targets] native-targets/Nexus/ not found — skipping WidgetReloader');
    return;
  }

  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

  for (const file of ['WidgetReloader.h', 'WidgetReloader.m', 'WidgetReloaderBridge.swift']) {
    const src = path.join(srcDir, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(destDir, file));
      console.log(`[add-native-targets] Copied ${file} -> ios/Nexus/${file}`);
    }
  }

  let proj = readProj();

  if (proj.includes(RELOADER_M_REF)) {
    console.log('[add-native-targets] WidgetReloader already injected — skipping');
    return;
  }

  // 1. PBXBuildFile entries (.m + .swift in Sources + WidgetKit.framework in Frameworks)
  proj = proj.replace(
    '/* Begin PBXBuildFile section */',
    `/* Begin PBXBuildFile section */
		${RELOADER_M_BUILD} /* WidgetReloader.m in Sources */ = {isa = PBXBuildFile; fileRef = ${RELOADER_M_REF} /* WidgetReloader.m */; };
		${RELOADER_SW_BUILD} /* WidgetReloaderBridge.swift in Sources */ = {isa = PBXBuildFile; fileRef = ${RELOADER_SW_REF} /* WidgetReloaderBridge.swift */; };
		${RELOADER_WK_BUILD} /* WidgetKit.framework in Frameworks */ = {isa = PBXBuildFile; fileRef = ${RELOADER_WK_REF} /* WidgetKit.framework */; };`
  );

  // 2. PBXFileReference entries
  proj = proj.replace(
    '/* Begin PBXFileReference section */',
    `/* Begin PBXFileReference section */
		${RELOADER_H_REF} /* WidgetReloader.h */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.c.h; name = WidgetReloader.h; path = Nexus/WidgetReloader.h; sourceTree = "<group>"; };
		${RELOADER_M_REF} /* WidgetReloader.m */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.c.objc; name = WidgetReloader.m; path = Nexus/WidgetReloader.m; sourceTree = "<group>"; };
		${RELOADER_SW_REF} /* WidgetReloaderBridge.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; name = WidgetReloaderBridge.swift; path = Nexus/WidgetReloaderBridge.swift; sourceTree = "<group>"; };
		${RELOADER_WK_REF} /* WidgetKit.framework */ = {isa = PBXFileReference; lastKnownFileType = wrapper.framework; name = WidgetKit.framework; path = System/Library/Frameworks/WidgetKit.framework; sourceTree = SDKROOT; };`
  );

  // 3. Inject .m + .swift into main Nexus PBXSourcesBuildPhase after AppDelegate anchor
  if (proj.includes(APPDELEGATE_ANCHOR)) {
    proj = proj.replace(
      APPDELEGATE_ANCHOR,
      `${APPDELEGATE_ANCHOR}
				${RELOADER_M_BUILD} /* WidgetReloader.m in Sources */,
				${RELOADER_SW_BUILD} /* WidgetReloaderBridge.swift in Sources */,`
    );
    console.log('[add-native-targets] ✅ WidgetReloader.m + WidgetReloaderBridge.swift injected into main Nexus Sources phase');
  } else {
    console.error('[add-native-targets] ❌ AppDelegate anchor not found — cannot inject WidgetReloader');
    process.exit(1);
  }

  // 4. Inject WidgetKit.framework into main Nexus Frameworks phase
  const fwAnchor = `${MAIN_FRAMEWORKS_PHASE} /* Frameworks */ = {\n\t\t\tisa = PBXFrameworksBuildPhase;\n\t\t\tbuildActionMask = 2147483647;\n\t\t\tfiles = (`;
  if (proj.includes(fwAnchor)) {
    proj = proj.replace(
      fwAnchor,
      `${fwAnchor}\n\t\t\t\t${RELOADER_WK_BUILD} /* WidgetKit.framework in Frameworks */,`
    );
    console.log('[add-native-targets] ✅ WidgetKit.framework linked to main Nexus target');
  } else {
    // fallback: inject after opening paren of the files list
    const altAnchor = `${MAIN_FRAMEWORKS_PHASE} /* Frameworks */ = {`;
    const fwIdx = proj.indexOf(altAnchor);
    if (fwIdx !== -1) {
      const filesIdx = proj.indexOf('files = (', fwIdx);
      const insertAt = filesIdx + 'files = ('.length;
      proj = proj.slice(0, insertAt) +
        `\n\t\t\t\t${RELOADER_WK_BUILD} /* WidgetKit.framework in Frameworks */,` +
        proj.slice(insertAt);
      console.log('[add-native-targets] ✅ WidgetKit.framework linked (fallback path)');
    } else {
      console.warn('[add-native-targets] ⚠️ Could not find main Frameworks phase — WidgetKit NOT linked');
    }
  }

  writeProj(proj);
}

console.log('[add-native-targets] Starting widget target injection...');
copyWidgetFiles();
syncWidgetVersion();

writeWidgetEntitlements();
patchPbxproj();
injectWidgetReloader();
writeGemfile();
// Final self-verification — fails the build if anything is wrong
(function selfVerify() {
  const finalProj = readProj();
  const checks = {
    'Widget group in root PBXGroup': finalProj.includes('AA00000000000000000006AA'),
    'Widget native target exists':   finalProj.includes('AA00000000000000000001AA'),
    'Widget embed phase exists':     finalProj.includes('AA0000000000000000000FAA'),
    'Widget backdrop jpg wired':     finalProj.includes('AA00000000000000000015AA /* night-sky-bg.jpg in Resources */'),
    'Widget Fraunces font wired':    finalProj.includes('AA00000000000000000016AA /* Fraunces-LightItalic.ttf in Resources */'),
    'Widget Inter-Medium font wired': finalProj.includes('AA00000000000000000019AA /* Inter-Medium.ttf in Resources */'),
    'Widget Inter-SemiBold font wired': finalProj.includes('AA0000000000000000001BAA /* Inter-SemiBold.ttf in Resources */'),
    'Widget Inter-Bold font wired': finalProj.includes('AA0000000000000000001DAA /* Inter-Bold.ttf in Resources */'),
    'Widget IBMPlexMono-Medium font wired': finalProj.includes('AA0000000000000000001FAA /* IBMPlexMono-Medium.ttf in Resources */'),
    'No invalid G UUIDs':            !finalProj.includes('0000000000000GAA'),
    'Widget deploy target 17.0':     (finalProj.match(/IPHONEOS_DEPLOYMENT_TARGET = 17\.0/g)||[]).length >= 2,
    'WidgetReloader.m in main Sources':           finalProj.includes('BB00000000000000000004BB /* WidgetReloader.m in Sources */'),
    'WidgetReloaderBridge.swift in main Sources':  finalProj.includes('BB00000000000000000007BB /* WidgetReloaderBridge.swift in Sources */'),
    'WidgetKit.framework in main Frameworks':      finalProj.includes('BB00000000000000000006BB /* WidgetKit.framework in Frameworks */'),
    'WidgetReloader NOT in NexusWidget target': !finalProj.includes('AA00000000000000000009AA') || !finalProj.slice(finalProj.indexOf('AA00000000000000000009AA'), finalProj.indexOf('AA00000000000000000009AA') + 500).includes('BB000000000000000000'),
  };
  let allPass = true;
  for (const [name, pass] of Object.entries(checks)) {
    if (pass) { console.log(`[add-native-targets] ✅ ${name}`); }
    else       { console.error(`[add-native-targets] ❌ FAILED: ${name}`); allPass = false; }
  }
  if (!allPass) { console.error('[add-native-targets] ❌ Self-checks failed'); process.exit(1); }
})();
console.log('[add-native-targets] ✅ Done — NexusWidget injected into Xcode project.');
