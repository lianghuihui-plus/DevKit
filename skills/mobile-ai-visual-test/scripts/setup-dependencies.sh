#!/usr/bin/env bash
set -uo pipefail

platform=""
mode="check"

usage() {
  cat <<'USAGE'
用法：
  setup-dependencies.sh --platform <android|harmony|ios> [--install]

默认只检测依赖，不修改系统。使用 --install 时会先显示安装计划并等待确认。
USAGE
}

cli_error() {
  printf '错误：%s\n' "$1" >&2
  usage >&2
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --platform)
      [[ $# -ge 2 && -n "${2:-}" && "${2:-}" != --* ]] || cli_error "缺少 --platform 参数值"
      [[ -z "$platform" ]] || cli_error "重复参数：--platform"
      platform="$2"
      shift 2
      ;;
    --install)
      [[ "$mode" == "check" ]] || cli_error "重复参数：--install"
      mode="install"
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *) cli_error "未知参数：$1" ;;
  esac
done

case "$platform" in
  android|harmony|ios) ;;
  "") cli_error "必须指定 --platform <android|harmony|ios>" ;;
  *) cli_error "--platform 只支持 android|harmony|ios" ;;
esac

os_name="$(uname -s 2>/dev/null || printf 'Unknown')"
missing_count=0
brew_packages=()
brew_casks=()
apt_packages=()
manual_hints=()
install_appium=false
install_xcuitest=false
install_android_sdk_packages=false
android_sdk_root=""

add_unique() {
  local array_name="$1"
  local value="$2"
  local existing
  eval "local current=(\"\${${array_name}[@]-}\")"
  for existing in "${current[@]}"; do
    [[ "$existing" == "$value" ]] && return 0
  done
  eval "${array_name}+=(\"\$value\")"
}

ok() {
  printf '[OK] %s\n' "$1"
}

missing() {
  missing_count=$((missing_count + 1))
  printf '[缺失] %s\n' "$1"
}

manual() {
  add_unique manual_hints "$1"
}

plan_brew_package() {
  if command -v brew >/dev/null 2>&1; then
    add_unique brew_packages "$1"
  else
    manual "安装 Homebrew 后执行：brew install $1"
  fi
}

plan_brew_cask() {
  if command -v brew >/dev/null 2>&1; then
    add_unique brew_casks "$1"
  else
    manual "安装 Homebrew 后执行：brew install --cask $1"
  fi
}

plan_apt_package() {
  if command -v apt-get >/dev/null 2>&1; then
    add_unique apt_packages "$1"
  else
    manual "请使用当前系统的软件包管理器安装：$1"
  fi
}

plan_system_package() {
  local brew_name="$1"
  local apt_name="$2"
  if [[ "$os_name" == "Darwin" ]]; then
    plan_brew_package "$brew_name"
  elif [[ "$os_name" == "Linux" ]]; then
    plan_apt_package "$apt_name"
  else
    manual "请手动安装：$brew_name"
  fi
}

check_command() {
  local command_name="$1"
  local display_name="${2:-$1}"
  if command -v "$command_name" >/dev/null 2>&1; then
    ok "$display_name"
    return 0
  fi
  missing "$display_name"
  return 1
}

find_android_sdk() {
  local candidate
  for candidate in "${ANDROID_HOME:-}" "${ANDROID_SDK_ROOT:-}" "$HOME/Library/Android/sdk" "$HOME/Android/Sdk"; do
    if [[ -n "$candidate" && -d "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

has_android_platform() {
  local sdk="$1"
  local file
  for file in "$sdk"/platforms/android-*/android.jar; do
    [[ -f "$file" ]] && return 0
  done
  return 1
}

has_android_build_tools() {
  local sdk="$1"
  local dir
  for dir in "$sdk"/build-tools/*; do
    [[ -x "$dir/aapt" && -x "$dir/apksigner" && ( -x "$dir/d8" || -x "$dir/dx" ) ]] && return 0
  done
  return 1
}

check_common() {
  ok "Bash"

  if ! check_command node "Node.js"; then
    plan_system_package node nodejs
  fi
  if ! check_command perl; then
    plan_system_package perl perl
  fi

  local command_name apt_name
  for command_name in mktemp sed awk; do
    if ! check_command "$command_name"; then
      case "$command_name" in
        mktemp) apt_name="coreutils" ;;
        sed) apt_name="sed" ;;
        awk) apt_name="gawk" ;;
      esac
      if [[ "$os_name" == "Linux" ]]; then
        plan_apt_package "$apt_name"
      else
        manual "请通过系统工具链安装 $command_name"
      fi
    fi
  done
}

check_android() {
  if ! check_command adb; then
    if [[ "$os_name" == "Darwin" ]]; then plan_brew_cask android-platform-tools; else plan_apt_package adb; fi
  fi

  local java_ready=true
  check_command java || java_ready=false
  check_command javac || java_ready=false
  if [[ "$java_ready" == "false" ]]; then
    if [[ "$os_name" == "Darwin" ]]; then plan_brew_package openjdk; else plan_apt_package openjdk-17-jdk; fi
  fi

  android_sdk_root="$(find_android_sdk 2>/dev/null || true)"
  if [[ -z "$android_sdk_root" ]]; then
    missing "Android SDK 路径"
    if ! command -v sdkmanager >/dev/null 2>&1; then
      if [[ "$os_name" == "Darwin" ]]; then
        plan_brew_cask android-commandlinetools
      else
        manual "安装 Android SDK Command-line Tools，并将 sdkmanager 加入 PATH"
      fi
    fi
    manual "设置 ANDROID_HOME 或 ANDROID_SDK_ROOT，并将 platform-tools 加入 PATH"
    return
  fi
  ok "Android SDK 路径：$android_sdk_root"

  if has_android_platform "$android_sdk_root"; then
    ok "Android SDK Platform"
  else
    missing "Android SDK Platform"
    install_android_sdk_packages=true
  fi

  if has_android_build_tools "$android_sdk_root"; then
    ok "Android SDK Build Tools"
  else
    missing "Android SDK Build Tools"
    install_android_sdk_packages=true
  fi

  if [[ "$install_android_sdk_packages" == "true" ]] && ! command -v sdkmanager >/dev/null 2>&1; then
    if [[ "$os_name" == "Darwin" ]]; then
      plan_brew_cask android-commandlinetools
    else
      manual "安装 Android SDK Command-line Tools，并将 sdkmanager 加入 PATH"
    fi
    manual "安装 sdkmanager 后执行：sdkmanager 'platforms;android-35' 'build-tools;35.0.0' 'platform-tools'"
  fi
}

check_harmony() {
  check_command hdc || manual "安装 DevEco Studio 或 HarmonyOS Command Line Tools，并将 hdc 加入 PATH"
  check_command devecocli || manual "安装 DevEco Studio 或 HarmonyOS Command Line Tools，并将 devecocli 加入 PATH"
}

appium_has_xcuitest() {
  local installed
  command -v appium >/dev/null 2>&1 || return 1
  installed="$(appium driver list --installed --json 2>/dev/null || true)"
  [[ "$installed" == *xcuitest* ]]
}

check_ios() {
  if [[ "$os_name" == "Darwin" ]]; then
    ok "macOS"
  else
    missing "macOS"
    manual "iOS 自动化测试必须在 macOS 上运行"
  fi

  check_command xcodebuild "Xcode" || manual "从 App Store 安装 Xcode，并完成首次启动设置"
  check_command xcrun "Xcode Command Line Tools" || manual "执行 xcode-select --install 安装 Xcode Command Line Tools"

  if ! check_command npm; then
    plan_system_package node npm
  fi

  if check_command appium "Appium"; then
    if appium_has_xcuitest; then
      ok "Appium XCUITest Driver"
    else
      missing "Appium XCUITest Driver"
      install_xcuitest=true
    fi
  else
    install_appium=true
    missing "Appium XCUITest Driver"
    install_xcuitest=true
  fi

  manual "iOS 真机还需 Apple Developer 签名能力和可用的 WebDriverAgent 配置"
}

print_manual_hints() {
  [[ ${#manual_hints[@]} -gt 0 ]] || return 0
  printf '\n需要人工处理：\n'
  local hint
  for hint in "${manual_hints[@]}"; do
    printf '  - %s\n' "$hint"
  done
}

detect() {
  missing_count=0
  brew_packages=()
  brew_casks=()
  apt_packages=()
  manual_hints=()
  install_appium=false
  install_xcuitest=false
  install_android_sdk_packages=false
  android_sdk_root=""

  printf 'MAVT 依赖检测（%s / %s）\n\n' "$platform" "$os_name"
  check_common
  case "$platform" in
    android) check_android ;;
    harmony) check_harmony ;;
    ios) check_ios ;;
  esac
  print_manual_hints

  if [[ $missing_count -eq 0 ]]; then
    printf '\n依赖已就绪。\n'
    return 0
  fi
  printf '\n仍有依赖缺失：%s 项。\n' "$missing_count"
  return 1
}

has_automatic_install() {
  if [[ "$platform" == "ios" && "$os_name" != "Darwin" ]]; then
    return 1
  fi
  if [[ ${#brew_packages[@]} -gt 0 || ${#brew_casks[@]} -gt 0 || ${#apt_packages[@]} -gt 0 \
    || "$install_appium" == "true" || "$install_xcuitest" == "true" ]]; then
    return 0
  fi
  [[ "$install_android_sdk_packages" == "true" ]] && command -v sdkmanager >/dev/null 2>&1
}

print_install_plan() {
  printf '\n将尝试执行以下安装操作：\n'
  [[ ${#brew_packages[@]} -eq 0 ]] || printf '  brew install %s\n' "${brew_packages[*]}"
  [[ ${#brew_casks[@]} -eq 0 ]] || printf '  brew install --cask %s\n' "${brew_casks[*]}"
  [[ ${#apt_packages[@]} -eq 0 ]] || printf '  apt-get install -y %s\n' "${apt_packages[*]}"
  [[ "$install_appium" != "true" ]] || printf '  npm install -g appium\n'
  [[ "$install_xcuitest" != "true" ]] || printf '  appium driver install xcuitest\n'
  if [[ "$install_android_sdk_packages" == "true" && -n "$android_sdk_root" ]]; then
    printf "  sdkmanager --sdk_root='%s' 'platforms;android-35' 'build-tools;35.0.0' 'platform-tools'\n" "$android_sdk_root"
  fi
}

run_install_command() {
  printf '\n> '
  printf '%q ' "$@"
  printf '\n'
  "$@"
}

install_packages() {
  local install_failed=false

  if [[ ${#brew_packages[@]} -gt 0 ]]; then
    run_install_command brew install "${brew_packages[@]}" || install_failed=true
  fi
  if [[ ${#brew_casks[@]} -gt 0 ]]; then
    run_install_command brew install --cask "${brew_casks[@]}" || install_failed=true
  fi
  if [[ ${#apt_packages[@]} -gt 0 ]]; then
    local apt_prefix=()
    if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
      if command -v sudo >/dev/null 2>&1; then
        apt_prefix=(sudo)
      else
        printf '缺少 sudo，无法自动运行 apt-get。\n' >&2
        install_failed=true
      fi
    fi
    if [[ "$install_failed" == "false" || ${#apt_prefix[@]} -gt 0 || ${EUID:-$(id -u)} -eq 0 ]]; then
      run_install_command "${apt_prefix[@]}" apt-get update || install_failed=true
      run_install_command "${apt_prefix[@]}" apt-get install -y "${apt_packages[@]}" || install_failed=true
    fi
  fi

  if [[ "$install_appium" == "true" ]]; then
    if command -v npm >/dev/null 2>&1; then
      run_install_command npm install -g appium || install_failed=true
    else
      printf 'npm 仍不可用，无法自动安装 Appium。\n' >&2
      install_failed=true
    fi
  fi
  if [[ "$install_xcuitest" == "true" ]]; then
    if command -v appium >/dev/null 2>&1; then
      run_install_command appium driver install xcuitest || install_failed=true
    else
      printf 'Appium 仍不可用，无法自动安装 XCUITest Driver。\n' >&2
      install_failed=true
    fi
  fi

  if [[ "$install_android_sdk_packages" == "true" && -n "$android_sdk_root" ]]; then
    if command -v sdkmanager >/dev/null 2>&1; then
      run_install_command sdkmanager --sdk_root="$android_sdk_root" \
        'platforms;android-35' 'build-tools;35.0.0' 'platform-tools' || install_failed=true
    else
      printf 'sdkmanager 仍不可用，无法自动安装 Android SDK Platform 和 Build Tools。\n' >&2
      install_failed=true
    fi
  fi

  [[ "$install_failed" == "false" ]]
}

if detect; then
  exit 0
fi

if [[ "$mode" == "check" ]]; then
  exit 1
fi

if ! has_automatic_install; then
  exit 1
fi

print_install_plan
printf '\n是否继续安装？[y/N] '
IFS= read -r answer || answer=""
case "$answer" in
  y|Y|yes|YES|Yes) ;;
  *)
    printf '安装已取消。\n'
    exit 1
    ;;
esac

install_packages || true
printf '\n重新检测依赖：\n\n'
detect
