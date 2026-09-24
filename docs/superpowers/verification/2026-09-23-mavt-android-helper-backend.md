# MAVT Android Helper Backend Verification

## Result

Android ARTEMIS Accessibility Helper backend passed the full automated suite, strict Helper and auto/legacy device smoke tests, lifecycle restoration checks, fallback/UNKNOWN fault injection, and the performance gate.

- Full self-test: 68 suites passed, 0 failed.
- Android adapter SHA: `platform-adapter-0ce5a98aeec6a858`.
- Helper observation adapter P50: `1008 ms`.
- UIAutomator observation adapter P50: `4080 ms`.
- Helper is about `4.0x` faster at P50 while producing PNG files of equivalent size.
- No token header, test token, or serialized token field was found in smoke or benchmark artifacts.

## Environment

The planned TCP endpoint `10.240.27.151:37489` refused the ADB connection. Verification used the same attached test phone through its USB serial instead.

| Field | Value |
| --- | --- |
| Device | `R5CN716ZTFE` |
| Manufacturer / model | Samsung `SM-N9860` |
| Android | 13 / API 33 |
| Physical size | `1440x3088` |
| Active override / snapshot size | `1080x2316` |
| Initial accessibility services | `com.artemis.helper/.ArtemisAccessibilityService` |
| Initial Helper forwards | none |

The physical/override size difference was investigated after an early smoke failure. A controlled comparison proved that unscaled Helper coordinates hit the expected target and scaled coordinates do not. The failure came from capturing Settings during its expanding-header animation immediately after `am start -W`; the target moved before dispatch. The smoke setup now waits `500 ms` after launching Settings, matching the runtime's existing post-action settle policy. No coordinate conversion was added to the adapter.

## Commands

```bash
node skills/mobile-ai-visual-test/scripts/self-test.js
node skills/mobile-ai-visual-test/scripts/build-agent-contract.js --role case-executor --platform android
node skills/mobile-ai-visual-test/scripts/build-agent-contract.js --role batch-coordinator --platform android
node skills/mobile-ai-visual-test/scripts/tests/android-helper-device-smoke.js --device R5CN716ZTFE --backend helper
node skills/mobile-ai-visual-test/scripts/tests/android-helper-device-smoke.js --device R5CN716ZTFE --backend auto
node skills/mobile-ai-visual-test/scripts/tests/android-helper-device-smoke.js --device R5CN716ZTFE --backend uiautomator
node skills/mobile-ai-visual-test/scripts/tests/android-helper-observation.test.js
node skills/mobile-ai-visual-test/scripts/tests/android-helper-action.test.js
node skills/mobile-ai-visual-test/scripts/tests/android-helper-device-smoke.js \
  --device R5CN716ZTFE --backend helper --mode benchmark --warmups 2 --iterations 10
git diff --check
git merge-base --is-ancestor main HEAD
```

## Device Capability Matrix

| Capability | Strict Helper | Auto | UIAutomator |
| --- | --- | --- | --- |
| Selected backend | `helper` | `helper` | `uiautomator` |
| Atomic PNG + XML | PASS | PASS | N/A, legacy separate capture |
| Tap | `ANDROID_HELPER_HTTP` | `ANDROID_HELPER_HTTP` | `ADB_INPUT` |
| Double tap, default interval | PASS | PASS | PASS |
| Double tap, custom interval | PASS | PASS | PASS |
| Long press | PASS | PASS | PASS |
| Replace focused text | PASS | PASS | PASS |
| Append focused text | PASS | PASS | PASS |
| Point-targeted text input | PASS | PASS | PASS |
| Swipe | PASS | PASS | PASS |
| Back | PASS | PASS | PASS |
| Home | PASS | PASS | PASS |
| PNG/XML validation after actions | PASS | PASS | PASS |
| Release restoration | PASS | PASS | PASS |

Strict Helper and auto each completed 11 actions and 13 observations. UIAutomator completed the same 11 actions and 13 observations without regression. Artifact directories were:

- Helper: `/var/folders/5k/15r87pq522jfx_x1sybxpgxm0000gn/T/mavt-android-helper-smoke-D992Rf`
- Auto: `/var/folders/5k/15r87pq522jfx_x1sybxpgxm0000gn/T/mavt-android-helper-smoke-lJ1iGx`
- UIAutomator: `/var/folders/5k/15r87pq522jfx_x1sybxpgxm0000gn/T/mavt-android-helper-smoke-ndgmoT`

## Performance

The Settings application list was held constant. Each backend received two uncounted warm-ups, followed by ten samples in repeating `helper/uiautomator/uiautomator/helper` order.

| Backend | Metric | P50 | P90 | Max |
| --- | --- | ---: | ---: | ---: |
| Helper | Adapter elapsed | 1008 ms | 1030 ms | 1040 ms |
| Helper | Device atomic snapshot | 684 ms | 712 ms | 719 ms |
| Helper | PNG bytes | 194126 | 194149 | 194149 |
| UIAutomator | Adapter elapsed | 4080 ms | 4166 ms | 4185 ms |
| UIAutomator | Device layout capture | 2627 ms | 2672 ms | 2675 ms |
| UIAutomator | PNG bytes | 194091 | 194126 | 194126 |

Raw Helper samples, in milliseconds:

| Sample | Adapter | Device | PNG bytes |
| ---: | ---: | ---: | ---: |
| 1 | 1025 | 711 | 194126 |
| 2 | 1010 | 708 | 194126 |
| 3 | 973 | 649 | 194126 |
| 4 | 1040 | 719 | 194126 |
| 5 | 954 | 644 | 194126 |
| 6 | 1008 | 708 | 194149 |
| 7 | 977 | 658 | 194149 |
| 8 | 1018 | 684 | 193777 |
| 9 | 994 | 650 | 193777 |
| 10 | 1030 | 712 | 193743 |

Raw UIAutomator samples, in milliseconds:

| Sample | Adapter | Device | PNG bytes |
| ---: | ---: | ---: | ---: |
| 1 | 3878 | 2532 | 194126 |
| 2 | 3998 | 2627 | 194126 |
| 3 | 4166 | 2672 | 194091 |
| 4 | 4088 | 2626 | 194126 |
| 5 | 4093 | 2622 | 194091 |
| 6 | 4027 | 2629 | 194126 |
| 7 | 4084 | 2647 | 193777 |
| 8 | 4185 | 2675 | 193777 |
| 9 | 4080 | 2637 | 193777 |
| 10 | 4054 | 2624 | 193743 |

Benchmark artifacts are under `/var/folders/5k/15r87pq522jfx_x1sybxpgxm0000gn/T/mavt-android-helper-benchmark-l5J9Eh`. The home-screen smoke observation produced a roughly 4 MiB PNG and a multi-second compression tail; it is recorded as content-sensitive PNG behavior and does not justify replacing evidence with lossy JPEG.

## Fault And Lifecycle Checks

- Read-only Helper snapshot failure falls back to UIAutomator in `auto` mode.
- A post-dispatch action timeout returns `UNKNOWN`; no legacy action replay occurs.
- Authentication rejection can reauthenticate once, while post-dispatch uncertainty remains non-replayable.
- Release clears the device token by broadcasting `SET_TOKEN` without a `token` extra, which is the receiver's null-token protocol.
- Interrupted acquire recovery removes the stale owned forward before creating one replacement forward.
- A second active owner receives `ANDROID_HELPER_IN_USE` and cannot install, restart, forward, or overwrite the first owner's token.
- Release retry preserves its journal until cleanup succeeds.
- Strict Helper, auto, and benchmark runs restored the pre-run accessibility service list and forward list, removed the owner claim, and removed the session state.
- The workspace and output artifacts contain no real token; token values remain confined to mode `0600` host cache files during ownership.
