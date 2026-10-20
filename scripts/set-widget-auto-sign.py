#!/usr/bin/env python3
"""
Set CODE_SIGN_STYLE = Automatic for NexusWidget build configurations.
This runs AFTER eas/configure_ios_credentials so the main Nexus target
stays Manual (with EAS-provisioned profile) while NexusWidget gets
Automatic (so -allowProvisioningUpdates can provision it).
"""
import re
import sys

PBXPROJ = "ios/Nexus.xcodeproj/project.pbxproj"
# Widget Debug and Release XCBuildConfiguration UUIDs
WIDGET_CONFIG_UUIDS = ["AA0000000000000000000AAA", "AA0000000000000000000BAA"]

with open(PBXPROJ) as f:
    content = f.read()

changed = False
for uuid in WIDGET_CONFIG_UUIDS:
    # Find this specific config block
    pattern = re.escape(uuid) + r' /\* (?:Debug|Release) \*/ = \{\s*isa = XCBuildConfiguration;\s*buildSettings = \{'
    match = re.search(pattern, content)
    if match:
        insert_pos = match.end()
        # Insert CODE_SIGN_STYLE = Automatic right after buildSettings = {
        if 'CODE_SIGN_STYLE' not in content[insert_pos:insert_pos+500]:
            content = content[:insert_pos] + '\n\t\t\t\tCODE_SIGN_STYLE = Automatic;' + content[insert_pos:]
            print(f"Set CODE_SIGN_STYLE = Automatic for {uuid}")
            changed = True
        else:
            # Replace existing value
            content = re.sub(
                r'('+re.escape(uuid)+r'.*?CODE_SIGN_STYLE = )\w+;',
                r'\1Automatic;',
                content, flags=re.DOTALL, count=1
            )
            print(f"Updated CODE_SIGN_STYLE = Automatic for {uuid}")
            changed = True
    else:
        print(f"WARNING: could not find config block for {uuid}", file=sys.stderr)

if changed:
    with open(PBXPROJ, "w") as f:
        f.write(content)
    print("Done — widget signing set to Automatic")
else:
    print("No changes made")
