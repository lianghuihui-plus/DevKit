#!/usr/bin/env bash
set -u

device=""
app=""
strategy=""
artifact=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --device) device="${2:-}"; shift 2 ;;
    --app) app="${2:-}"; shift 2 ;;
    --strategy) strategy="${2:-}"; shift 2 ;;
    --artifact) artifact="${2:-}"; shift 2 ;;
    *) echo "Android App 准备未知参数: $1" >&2; exit 2 ;;
  esac
done

adb_bin="$(command -v adb || true)"
ok=false
failure_code=""
reason=""
installed_version=""
installed_build=""
if [[ -z "$adb_bin" || -z "$device" || -z "$app" ]]; then
  failure_code="ANDROID_PREPARATION_ENVIRONMENT_INVALID"
  reason="adb、device 和 app 均为必填"
elif [[ "$strategy" == "CLEAR_APP_DATA" ]]; then
  output="$("$adb_bin" -s "$device" shell pm clear "$app" 2>&1)"; status=$?
  if [[ $status -eq 0 && "$output" == *Success* ]]; then ok=true; else failure_code="ANDROID_CLEAR_APP_DATA_FAILED"; reason="$output"; fi
elif [[ "$strategy" == "REINSTALL_APP" && -f "$artifact" ]]; then
  uninstall_ok=true
  if "$adb_bin" -s "$device" shell pm path "$app" >/dev/null 2>&1; then
    uninstall_output="$("$adb_bin" -s "$device" uninstall "$app" 2>&1)"; uninstall_status=$?
    if [[ $uninstall_status -ne 0 || "$uninstall_output" != *Success* ]]; then
      uninstall_ok=false; failure_code="ANDROID_UNINSTALL_APP_FAILED"; reason="$uninstall_output"
    fi
  fi
  if [[ "$uninstall_ok" == true ]]; then
    output="$("$adb_bin" -s "$device" install "$artifact" 2>&1)"; status=$?
    if [[ $status -eq 0 && "$output" == *Success* ]] && "$adb_bin" -s "$device" shell pm path "$app" >/dev/null 2>&1; then
      package_dump="$("$adb_bin" -s "$device" shell dumpsys package "$app" 2>/dev/null || true)"
      installed_version="$(printf '%s\n' "$package_dump" | sed -n 's/.*versionName=\([^[:space:]]*\).*/\1/p' | head -n 1)"
      installed_build="$(printf '%s\n' "$package_dump" | sed -n 's/.*versionCode=\([0-9][0-9]*\).*/\1/p' | head -n 1)"
      if [[ -n "$installed_version" && -n "$installed_build" ]]; then
        ok=true
      else
        failure_code="APP_ARTIFACT_IDENTITY_UNVERIFIED"; reason="无法读取安装后的 versionName/versionCode"
      fi
    else
      failure_code="ANDROID_REINSTALL_APP_FAILED"; reason="$output"
    fi
  else
    ok=false
  fi
else
  failure_code="ANDROID_PREPARATION_REQUEST_INVALID"; reason="不支持的策略或安装资产不可用"
fi

node -e '
const ok = process.argv[1] === "true";
console.log(JSON.stringify({schemaVersion:1,type:"appPreparationResult",platform:"android",strategy:process.argv[2],ok,status:ok?"SUCCEEDED":"FAILED",device:{id:process.argv[3]},app:{appId:process.argv[4]},...(ok?{installedIdentity:{appId:process.argv[4],version:process.argv[7],build:process.argv[8]}}:{failureCode:process.argv[5],reason:String(process.argv[6]||"").slice(0,1000)})},null,2));
' "$ok" "$strategy" "$device" "$app" "$failure_code" "$reason" "$installed_version" "$installed_build"
