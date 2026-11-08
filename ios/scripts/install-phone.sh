#!/bin/zsh
# Build Threadbear, install it on Mike's phone over wifi and launch it.
# Release by default; CONFIG=Debug for a Debug build (which also takes a
# local http://127.0.0.1 pairing link, useless on a phone). Signs with the
# App Store Connect API key like Quick Ask and Poddle, so no Xcode account
# is needed. Copied from quick-ask/scripts/install-phone.sh.
#
#   ios/scripts/install-phone.sh                       # the 15 Pro Max
#   DEVICE=<udid> ios/scripts/install-phone.sh         # another phone (xcrun devicectl list devices)
#   BUILD_ONLY=1 ios/scripts/install-phone.sh          # just prove signing works
#
# "developer disk image could not be mounted ... cryptexd": restart the phone.
set -euo pipefail
cd "$(dirname "$0")/.."
CONFIG=${CONFIG:-Release}
DEVICE=${DEVICE:-D9ABE466-764B-5AA5-B42D-67ACBF71784E}   # Ben's iPhone
DD=${DD:-/tmp/threadbear-dd-device}
ASC_KEY_ID=${ASC_KEY_ID:-7SS6J9F98P}
ASC_ISSUER_ID=${ASC_ISSUER_ID:-69a6de6f-a06e-47e3-e053-5b8c7c11a4d1}
ASC_KEY=${ASC_KEY:-$HOME/.config/poddle/AuthKey_$ASC_KEY_ID.p8}
extra=()
if [[ -f "$ASC_KEY" ]]; then
  extra+=(-allowProvisioningUpdates -allowProvisioningDeviceRegistration
    -authenticationKeyPath "$ASC_KEY" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")
else
  echo "No API key at $ASC_KEY: signing with whatever Xcode has (sign in to Xcode if this fails)"
  extra+=(-allowProvisioningUpdates)
fi
# The derived data lives in /tmp and is shared by every thread, and on
# 5 Nov it was left with package checkouts and binary frameworks half gone
# (convex-swift with no Package.swift, Sentry's xcframework with no
# Info.plist), which fails every build until it's cleared. Packages are
# cheap to fetch again, so drop them when any look broken.
if [[ -d "$DD/SourcePackages" ]]; then
  broken=0
  for d in "$DD"/SourcePackages/checkouts/*(N/); do [[ -f "$d/Package.swift" ]] || broken=1; done
  for f in "$DD"/SourcePackages/artifacts/**/*.xcframework(N/); do [[ -f "$f/Info.plist" ]] || broken=1; done
  (( broken )) && { echo "Package cache in $DD looks damaged; fetching packages again"; rm -rf "$DD/SourcePackages"; }
fi
# Release says production for APNs (the App Store build), but this build is
# development-signed, so its pushes come through the sandbox.
xcodebuild -project Threadbear.xcodeproj -scheme Threadbear -configuration "$CONFIG" \
  -destination 'generic/platform=iOS' -derivedDataPath "$DD" "${extra[@]}" \
  THREADBEAR_APS_ENVIRONMENT=development build | grep -E "(^| )error:|BUILD (SUCCEEDED|FAILED)"
APP="$DD/Build/Products/$CONFIG-iphoneos/Threadbear.app"
[[ "${BUILD_ONLY:-0}" == 1 ]] && { echo "Built $APP"; exit 0; }
xcrun devicectl device install app --device "$DEVICE" "$APP"
xcrun devicectl device process launch --device "$DEVICE" --terminate-existing com.lunarlabs.threadbear
