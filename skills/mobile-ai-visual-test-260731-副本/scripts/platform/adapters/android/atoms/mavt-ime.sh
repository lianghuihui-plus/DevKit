#!/usr/bin/env bash
set -euo pipefail

device=""
command=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --device) device="${2:-}"; shift 2 ;;
    --status) command="status"; shift ;;
    --prepare) command="prepare"; shift ;;
    --apk-path) command="apk-path"; shift ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$command" ]] || { echo "mavt-ime 需要 --status、--prepare 或 --apk-path" >&2; exit 2; }

script_dir="$(cd "$(dirname "$0")" && pwd)"
adapter_dir="$(cd "$script_dir/.." && pwd)"
ime_id="mavt.android.ime/.MavtInputMethodService"
package_name="mavt.android.ime"

adb_prefix=(adb)
if [[ -n "$device" ]]; then
  adb_prefix=(adb -s "$device")
fi

android_sdk_root() {
  local candidate
  for candidate in "${ANDROID_HOME:-}" "${ANDROID_SDK_ROOT:-}" "$HOME/Library/Android/sdk"; do
    if [[ -n "$candidate" && -d "$candidate/platforms" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

android_latest_platform_dir() {
  local sdk="$1"
  node -e '
const fs = require("fs");
const path = require("path");
const sdk = process.argv[1];
const platforms = path.join(sdk, "platforms");
const items = fs.readdirSync(platforms)
  .map((name) => ({ name, api: Number((name.match(/^android-(\d+)$/) || [])[1]) }))
  .filter((item) => Number.isFinite(item.api))
  .sort((a, b) => a.api - b.api);
for (const item of items.reverse()) {
  const dir = path.join(platforms, item.name);
  if (fs.existsSync(path.join(dir, "android.jar"))) {
    process.stdout.write(dir);
    process.exit(0);
  }
}
process.exit(1);
' "$sdk"
}

android_latest_build_tools_dir() {
  local sdk="$1"
  node -e '
const fs = require("fs");
const path = require("path");
const sdk = process.argv[1];
const root = path.join(sdk, "build-tools");
if (!fs.existsSync(root)) process.exit(1);
const versions = fs.readdirSync(root)
  .map((name) => ({ name, parts: name.split(".").map((part) => Number(part)) }))
  .filter((item) => item.parts.every((part) => Number.isFinite(part)))
  .sort((a, b) => {
    for (let i = 0; i < Math.max(a.parts.length, b.parts.length); i += 1) {
      const diff = (a.parts[i] || 0) - (b.parts[i] || 0);
      if (diff) return diff;
    }
    return 0;
  });
if (versions.length) {
  process.stdout.write(path.join(root, versions[versions.length - 1].name));
  process.exit(0);
}
process.exit(1);
' "$sdk"
}

android_ime_source_hash() {
  local ime_dir="$1"
  node -e '
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const root = process.argv[1];
const hash = crypto.createHash("sha256");
function walk(dir) {
  for (const name of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, name);
    const stat = fs.statSync(file);
    if (stat.isDirectory()) walk(file);
    else {
      hash.update(path.relative(root, file));
      hash.update("\0");
      hash.update(fs.readFileSync(file));
      hash.update("\0");
    }
  }
}
walk(root);
process.stdout.write(hash.digest("hex"));
' "$ime_dir"
}

android_ime_apk() {
  local ime_dir cache_dir apk_file unsigned_apk stamp_file source_hash existing_hash
  local sdk platform_dir android_jar build_tools_dir aapt d8 dx apksigner classes_dir dex_dir gen_dir keystore
  local java_sources
  ime_dir="$adapter_dir/ime"
  cache_dir="${MAVT_ANDROID_IME_BUILD_DIR:-$HOME/.cache/mobile-ai-visual-test/android-ime}"
  apk_file="$cache_dir/mavt-input.apk"
  unsigned_apk="$cache_dir/mavt-input-unsigned.apk"
  stamp_file="$cache_dir/source.sha256"

  [[ -f "$ime_dir/AndroidManifest.xml" ]] || { echo "Android IME source not found: $ime_dir" >&2; return 2; }
  mkdir -p "$cache_dir"
  source_hash="$(android_ime_source_hash "$ime_dir")"
  existing_hash=""
  [[ -f "$stamp_file" ]] && existing_hash="$(cat "$stamp_file")"
  if [[ -f "$apk_file" && "$existing_hash" == "$source_hash" ]]; then
    printf '%s\n' "$apk_file"
    return 0
  fi

  sdk="$(android_sdk_root)" || { echo "Android SDK not found. Set ANDROID_HOME or ANDROID_SDK_ROOT." >&2; return 2; }
  platform_dir="$(android_latest_platform_dir "$sdk")" || { echo "Android SDK platform not found." >&2; return 2; }
  build_tools_dir="$(android_latest_build_tools_dir "$sdk")" || { echo "Android SDK build-tools not found." >&2; return 2; }
  aapt="$build_tools_dir/aapt"
  d8="$build_tools_dir/d8"
  dx="$build_tools_dir/dx"
  apksigner="$build_tools_dir/apksigner"
  [[ -x "$aapt" ]] || { echo "Android build-tool aapt not found." >&2; return 2; }
  [[ -x "$apksigner" ]] || { echo "Android build-tool apksigner not found." >&2; return 2; }
  android_jar="$platform_dir/android.jar"
  classes_dir="$cache_dir/classes"
  dex_dir="$cache_dir/dex"
  gen_dir="$cache_dir/gen"
  keystore="$cache_dir/mavt-debug.keystore"
  rm -rf "$classes_dir" "$dex_dir" "$gen_dir" "$apk_file" "$unsigned_apk"
  mkdir -p "$classes_dir" "$dex_dir" "$gen_dir"

  "$aapt" package -f -m -J "$gen_dir" -M "$ime_dir/AndroidManifest.xml" -S "$ime_dir/res" -I "$android_jar" >/dev/null
  java_sources=()
  while IFS= read -r source_file; do
    [[ -n "$source_file" ]] && java_sources+=("$source_file")
  done < <(find "$ime_dir/src" "$gen_dir" -name '*.java' -print)
  javac -encoding UTF-8 -source 8 -target 8 -classpath "$android_jar" -d "$classes_dir" "${java_sources[@]}" >/dev/null
  if [[ -x "$d8" ]]; then
    "$d8" --classpath "$android_jar" --output "$dex_dir" $(find "$classes_dir" -name '*.class' -print) >/dev/null
  elif [[ -x "$dx" ]]; then
    "$dx" --dex --output="$dex_dir/classes.dex" "$classes_dir" >/dev/null
  else
    echo "Android SDK build-tool d8/dx not found." >&2
    return 2
  fi
  "$aapt" package -f -M "$ime_dir/AndroidManifest.xml" -S "$ime_dir/res" -I "$android_jar" -F "$unsigned_apk" >/dev/null
  jar uf "$unsigned_apk" -C "$dex_dir" classes.dex
  if [[ ! -f "$keystore" ]]; then
    keytool -genkeypair -keystore "$keystore" -storepass android -keypass android -alias mavt -keyalg RSA -validity 10000 -dname "CN=MAVT Android Input" >/dev/null
  fi
  "$apksigner" sign --ks "$keystore" --ks-pass pass:android --key-pass pass:android --out "$apk_file" "$unsigned_apk" >/dev/null
  printf '%s\n' "$source_hash" > "$stamp_file"
  printf '%s\n' "$apk_file"
}

status_json() {
  local apk_built installed enabled current_ime package_path enabled_list
  apk_built="false"
  [[ -f "${MAVT_ANDROID_IME_BUILD_DIR:-$HOME/.cache/mobile-ai-visual-test/android-ime}/mavt-input.apk" ]] && apk_built="true"
  package_path="$("${adb_prefix[@]}" shell pm path "$package_name" 2>/dev/null | tr -d '\r' || true)"
  enabled_list="$("${adb_prefix[@]}" shell ime list -s 2>/dev/null | tr -d '\r' || true)"
  current_ime="$("${adb_prefix[@]}" shell settings get secure default_input_method 2>/dev/null | tr -d '\r' || true)"
  installed="false"
  enabled="false"
  [[ -n "$package_path" ]] && installed="true"
  printf '%s\n' "$enabled_list" | grep -Fx "$ime_id" >/dev/null 2>&1 && enabled="true"
  node -e '
const apkBuilt = process.argv[1] === "true";
const installed = process.argv[2] === "true";
const enabled = process.argv[3] === "true";
const currentInputMethod = process.argv[4] || null;
const packagePath = process.argv[5] || null;
const imeId = process.argv[6];
const ok = installed && enabled;
console.log(JSON.stringify({
  id: "mavtInputIme",
  name: "MAVT Input IME",
  platform: "android",
  required: true,
  ok,
  apkBuilt,
  installed,
  enabled,
  currentInputMethod,
  imeId,
  packageName: "mavt.android.ime",
  packagePath,
  stage: ok ? "ready" : "missing"
}, null, 2));
' "$apk_built" "$installed" "$enabled" "$current_ime" "$package_path" "$ime_id"
}

prepare_json() {
  local apk_file install_output install_status enable_output enable_status status
  apk_file="$(android_ime_apk)" || return $?
  set +e
  install_output="$("${adb_prefix[@]}" install -r "$apk_file" 2>&1)"
  install_status=$?
  set -e
  if [[ $install_status -ne 0 ]]; then
    echo "Android MAVT Input IME install failed: $install_output" >&2
    return 1
  fi
  set +e
  enable_output="$("${adb_prefix[@]}" shell ime enable "$ime_id" 2>&1)"
  enable_status=$?
  set -e
  if [[ $enable_status -ne 0 ]]; then
    echo "Android MAVT Input IME enable failed: $enable_output" >&2
    return 1
  fi
  status="$(status_json)"
  node -e '
const dependency = JSON.parse(process.argv[1]);
dependency.prepared = true;
dependency.stage = dependency.ok ? "prepared" : dependency.stage;
function localIso(date = new Date()) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  const pad = (value, size = 2) => String(value).padStart(size, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
console.log(JSON.stringify({
  schemaVersion: 1,
  type: "dependencyResult",
  platform: "android",
  time: localIso(),
  dependency
}, null, 2));
' "$status"
}

case "$command" in
  status) status_json ;;
  prepare) prepare_json ;;
  apk-path) android_ime_apk ;;
esac
