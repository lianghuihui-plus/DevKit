#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"

device="${MAVT_IOS_DEVICE:-}"
app="${MAVT_IOS_APP:-${MAVT_IOS_BUNDLE:-}}"
appium_server="${MAVT_IOS_APPIUM_SERVER:-}"
wda_local_port="${MAVT_IOS_WDA_LOCAL_PORT:-}"
wda_url="${MAVT_IOS_WDA_URL:-}"
xcode_org_id="${MAVT_IOS_XCODE_ORG_ID:-}"
xcode_signing_id="${MAVT_IOS_XCODE_SIGNING_ID:-}"
updated_wda_bundle_id="${MAVT_IOS_UPDATED_WDA_BUNDLE_ID:-}"
show_xcode_log="${MAVT_IOS_SHOW_XCODE_LOG:-}"
show_ios_log="${MAVT_IOS_SHOW_IOS_LOG:-}"
use_new_wda="${MAVT_IOS_USE_NEW_WDA:-}"
allow_provisioning="${MAVT_IOS_ALLOW_PROVISIONING_DEVICE_REGISTRATION:-}"
wda_launch_timeout="${MAVT_IOS_WDA_LAUNCH_TIMEOUT:-}"
derived_data_path="${MAVT_IOS_DERIVED_DATA_PATH:-}"

usage() {
  printf '%s\n' \
    "Usage: $0 --device <udid> --app <bundleId> --xcode-org-id <teamId> --xcode-signing-id <signingId> --updated-wda-bundle-id <bundleId> [options]" \
    "" \
    "Environment fallbacks:" \
    "  MAVT_IOS_DEVICE, MAVT_IOS_APP or MAVT_IOS_BUNDLE" \
    "  MAVT_IOS_XCODE_ORG_ID, MAVT_IOS_XCODE_SIGNING_ID, MAVT_IOS_UPDATED_WDA_BUNDLE_ID" \
    "  MAVT_IOS_APPIUM_SERVER, MAVT_IOS_WDA_LOCAL_PORT, MAVT_IOS_WDA_URL" \
    "  MAVT_IOS_SHOW_XCODE_LOG, MAVT_IOS_SHOW_IOS_LOG, MAVT_IOS_USE_NEW_WDA" \
    "  MAVT_IOS_ALLOW_PROVISIONING_DEVICE_REGISTRATION, MAVT_IOS_WDA_LAUNCH_TIMEOUT, MAVT_IOS_DERIVED_DATA_PATH" \
    "" \
    "Options:" \
    "  --bundle <bundleId>              Alias of --app" \
    "  --appium-server <url>            Appium server URL" \
    "  --wda-local-port <port>          Local WDA port" \
    "  --web-driver-agent-url <url>     Reuse an existing WDA URL" \
    "  --show-xcode-log [true|false]    Print xcodebuild output through Appium" \
    "  --show-ios-log [true|false]      Print iOS device logs through Appium" \
    "  --use-new-wda [true|false]       Force a fresh WDA startup" \
    "  --allow-provisioning-device-registration [true|false]" \
    "  --wda-launch-timeout <ms>        WDA startup timeout" \
    "  --derived-data-path <path>       Xcode DerivedData path for WDA"
}

require_value() {
  local name="$1"
  local value="${2:-}"
  if [[ -z "$value" ]]; then
    printf 'Missing value for %s\n' "$name" >&2
    usage >&2
    exit 2
  fi
}

read_optional_bool() {
  local __name="$1"
  if [[ $# -gt 1 && "${2:-}" != --* ]]; then
    printf -v "$__name" '%s' "$2"
    OPTION_BOOL_SHIFT=2
    return 0
  fi
  printf -v "$__name" '%s' "true"
  OPTION_BOOL_SHIFT=1
  return 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --device)
      require_value "$1" "${2:-}"
      device="$2"
      shift 2
      ;;
    --app|--bundle)
      require_value "$1" "${2:-}"
      app="$2"
      shift 2
      ;;
    --appium-server)
      require_value "$1" "${2:-}"
      appium_server="$2"
      shift 2
      ;;
    --wda-local-port)
      require_value "$1" "${2:-}"
      wda_local_port="$2"
      shift 2
      ;;
    --web-driver-agent-url)
      require_value "$1" "${2:-}"
      wda_url="$2"
      shift 2
      ;;
    --xcode-org-id)
      require_value "$1" "${2:-}"
      xcode_org_id="$2"
      shift 2
      ;;
    --xcode-signing-id)
      require_value "$1" "${2:-}"
      xcode_signing_id="$2"
      shift 2
      ;;
    --updated-wda-bundle-id)
      require_value "$1" "${2:-}"
      updated_wda_bundle_id="$2"
      shift 2
      ;;
    --show-xcode-log)
      read_optional_bool show_xcode_log "${2:-}"
      shift "$OPTION_BOOL_SHIFT"
      ;;
    --show-ios-log)
      read_optional_bool show_ios_log "${2:-}"
      shift "$OPTION_BOOL_SHIFT"
      ;;
    --use-new-wda)
      read_optional_bool use_new_wda "${2:-}"
      shift "$OPTION_BOOL_SHIFT"
      ;;
    --allow-provisioning-device-registration)
      read_optional_bool allow_provisioning "${2:-}"
      shift "$OPTION_BOOL_SHIFT"
      ;;
    --wda-launch-timeout)
      require_value "$1" "${2:-}"
      wda_launch_timeout="$2"
      shift 2
      ;;
    --derived-data-path)
      require_value "$1" "${2:-}"
      derived_data_path="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

missing=()
[[ -z "$device" ]] && missing+=("--device or MAVT_IOS_DEVICE")
[[ -z "$app" ]] && missing+=("--app/--bundle or MAVT_IOS_APP/MAVT_IOS_BUNDLE")
[[ -z "$xcode_org_id" ]] && missing+=("--xcode-org-id or MAVT_IOS_XCODE_ORG_ID")
[[ -z "$xcode_signing_id" ]] && missing+=("--xcode-signing-id or MAVT_IOS_XCODE_SIGNING_ID")
[[ -z "$updated_wda_bundle_id" ]] && missing+=("--updated-wda-bundle-id or MAVT_IOS_UPDATED_WDA_BUNDLE_ID")

if [[ "${#missing[@]}" -gt 0 ]]; then
  printf 'Missing required iOS real-device settings:\n' >&2
  printf '  - %s\n' "${missing[@]}" >&2
  usage >&2
  exit 2
fi

args=(
  --device "$device"
  --device-type realDevice
  --app "$app"
  --xcode-org-id "$xcode_org_id"
  --xcode-signing-id "$xcode_signing_id"
  --updated-wda-bundle-id "$updated_wda_bundle_id"
)

[[ -n "$appium_server" ]] && args+=(--appium-server "$appium_server")
[[ -n "$wda_local_port" ]] && args+=(--wda-local-port "$wda_local_port")
[[ -n "$wda_url" ]] && args+=(--web-driver-agent-url "$wda_url")
[[ -n "$show_xcode_log" ]] && args+=(--show-xcode-log "$show_xcode_log")
[[ -n "$show_ios_log" ]] && args+=(--show-ios-log "$show_ios_log")
[[ -n "$use_new_wda" ]] && args+=(--use-new-wda "$use_new_wda")
[[ -n "$allow_provisioning" ]] && args+=(--allow-provisioning-device-registration "$allow_provisioning")
[[ -n "$wda_launch_timeout" ]] && args+=(--wda-launch-timeout "$wda_launch_timeout")
[[ -n "$derived_data_path" ]] && args+=(--derived-data-path "$derived_data_path")

exec "$script_dir/prepare-env.sh" "${args[@]}"
