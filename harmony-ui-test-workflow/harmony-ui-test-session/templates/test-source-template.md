# 示例用例：登录页错误密码

> 复制本文件后改名，例如 `account-login-error.md`。
> 这里写人类可读的测试意图，不要写 selector、控件 id、index 或坐标。

页面：accountLoginPage

前置：
- 未登录状态
- 已进入登录页

操作：
1. 输入账号 wrong_user
2. 输入密码 wrong_pass
3. 勾选协议
4. 点击登录

预期：
- 不跳转到首页
- 出现账号或密码错误提示

---

## 多场景写法示例

同一个源文件可以写多个场景，case-gen 会拆成多个 YAML。

### 场景 1：错误密码

页面：accountLoginPage

前置：
- 未登录状态
- 已进入登录页

操作：
1. 输入账号 wrong_user
2. 输入密码 wrong_pass
3. 勾选协议
4. 点击登录

预期：
- 出现账号或密码错误提示

### 场景 2：账号为空

页面：accountLoginPage

前置：
- 未登录状态
- 已进入登录页

操作：
1. 清空账号
2. 输入密码 test_pass
3. 点击登录

预期：
- 出现账号不能为空提示
