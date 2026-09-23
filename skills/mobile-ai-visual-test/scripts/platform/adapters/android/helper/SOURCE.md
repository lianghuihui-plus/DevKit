# ARTEMIS Accessibility Helper Source

- Upstream: https://github.com/google/artemis
- Base commit: `371aa6df56880643da57b30da936e9812fb0ec66`
- Local patch branch: `codex/helper-png-snapshot`
- Source-input SHA-256: `e85ec0203454aea47330c442be7cdf6664ae034cf9276843559fca90db575c1d`
- APK SHA-256: `c2f6622920156f3951b13118efe1c87fcc27ea7e5904d42e61b5a6b849d37626`
- Snapshot contract: `/snapshot?fields=xml&format=png`
- Build command: `./build_apk.sh`
- Verified device: Samsung SM-N9860, Android 11+

The source-input digest covers the patched Gradle version metadata, command
server, hierarchy dumper, screenshot format implementation, and its unit test
runner. The APK remains licensed under the bundled Apache License 2.0 text.
