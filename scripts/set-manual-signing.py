#!/usr/bin/env python3
"""
Patch manual code signing into the Release build configs before an archive.

Run AFTER `expo prebuild` + `add-native-targets.js`, which regenerate
project.pbxproj and wipe any signing settings.

Why this exists in this shape:

- Signing must NOT be passed as xcodebuild flags. Command-line
  CODE_SIGN_IDENTITY / PROVISIONING_PROFILE_SPECIFIER apply to every target in
  the workspace, including the ~78 Pods targets, and the archive fails exit 65.
  So it goes in the pbxproj, on exactly the app and widget Release configs.

- Profile names are read from ExportOptions.plist rather than duplicated here.
  The previous version hardcoded a profile UUID that went stale: it named
  e1589aff-... while the profile actually installed was bc1629b7-..., so the
  archive signed against a profile that did not exist on the machine. Reading
  the same file the export step uses means the two cannot disagree.

- Targets are matched by PRODUCT_BUNDLE_IDENTIFIER, not by hardcoded
  XCBuildConfiguration UUIDs, which also drift whenever prebuild regenerates
  the project.

Usage:  python3 scripts/set-manual-signing.py [--export-options ExportOptions.plist]
"""
import argparse
import plistlib
import re
import sys
from pathlib import Path

PBXPROJ = Path("ios/Nexus.xcodeproj/project.pbxproj")

# Matches one XCBuildConfiguration block, non-greedy to its closing brace.
BLOCK = re.compile(
    r"([0-9A-F]{24}) /\* (Debug|Release) \*/ = \{\s*isa = XCBuildConfiguration;.*?\n\t\t\};",
    re.S,
)


def load_signing(export_options: Path):
    """Read team, certificate and per-bundle-id profile names from ExportOptions."""
    with export_options.open("rb") as fh:
        opts = plistlib.load(fh)
    profiles = opts.get("provisioningProfiles") or {}
    if not profiles:
        sys.exit(f"{export_options}: no provisioningProfiles entries")
    team = opts.get("teamID")
    cert = opts.get("signingCertificate")
    if not team or not cert:
        sys.exit(f"{export_options}: teamID and signingCertificate are both required")
    return team, cert, profiles


def set_setting(block: str, key: str, value: str) -> str:
    """Replace an existing build setting, or insert it if absent."""
    existing = re.search(rf"\n\t+{re.escape(key)}(\[[^\]]*\])? = ", block)
    if existing:
        return re.sub(
            rf"(\n\t+){re.escape(key)}(\[[^\]]*\])? = [^;]+;",
            lambda m: f"{m.group(1)}{key} = {value};",
            block,
            count=1,
        )
    return block.replace("buildSettings = {", f"buildSettings = {{\n\t\t\t\t{key} = {value};", 1)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--export-options", default="ExportOptions.plist", type=Path)
    args = parser.parse_args()

    if not PBXPROJ.exists():
        sys.exit(f"{PBXPROJ} not found — run expo prebuild first, from the repo root")
    if not args.export_options.exists():
        sys.exit(f"{args.export_options} not found")

    team, cert, profiles = load_signing(args.export_options)
    source = PBXPROJ.read_text()
    patched = []

    def fix(match: "re.Match[str]") -> str:
        _uuid, config, block = match.group(1), match.group(2), match.group(0)
        bundle = re.search(r"PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);", block)
        if not bundle:
            return block
        bundle_id = bundle.group(1).strip().strip('"')
        # Debug builds keep automatic signing; only the archive needs manual.
        if config != "Release" or bundle_id not in profiles:
            return block
        for key, value in (
            ("CODE_SIGN_STYLE", "Manual"),
            ("DEVELOPMENT_TEAM", team),
            ("CODE_SIGN_IDENTITY", f'"{cert}"'),
            ("PROVISIONING_PROFILE_SPECIFIER", f'"{profiles[bundle_id]}"'),
        ):
            block = set_setting(block, key, value)
        patched.append(bundle_id)
        return block

    result = BLOCK.sub(fix, source)

    expected = sorted(profiles)
    if sorted(patched) != expected:
        sys.exit(
            "refusing to write: expected to patch Release configs for "
            f"{expected}, patched {sorted(patched)}. The project layout changed —"
            " fix this script rather than signing by hand."
        )

    PBXPROJ.write_text(result)
    for bundle_id in patched:
        print(f"  {bundle_id} -> {profiles[bundle_id]}")
    print(f"Manual signing set on {len(patched)} Release configs.")


if __name__ == "__main__":
    main()
