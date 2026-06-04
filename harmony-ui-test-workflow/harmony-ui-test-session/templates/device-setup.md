# 设备连接与检查

## 前置

确保设备通过 USB 连接到本机，`hdc list targets` 有输出。

## 检查步骤

### 1. 设备连接

```bash
hdc list targets
```
无输出 → 检查 USB 连接，重试。仍无输出 → 提示用户连接设备。

### 2. 启动 UITest 守护进程

```bash
hdc shell uitest start-daemon
```
无输出即成功。设备重启后需重新执行。

### 3. 确认 App 已安装

```bash
hdc shell bm dump -n <bundleName> > /dev/null 2>&1 && echo installed || echo not_installed
```
not_installed → 提示用户安装 App。

`<bundleName>` 来自 `CONTEXT.md` 的 Bundle 字段。
