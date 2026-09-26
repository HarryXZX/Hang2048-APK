# 夯048 · Hang2048 —— Android 版

> 拉完了 → NPC → 人上人 → 顶级 → 夯 · 零敏感权限的 WebView 应用

安卓端移植版。桌面版在 [`../Hang2048`](../Hang2048)，两者玩法完全一致，
但本项目的 Web 层已做**响应式改造**（桌面版是固定 550×600 窗口）。

## 特性

| 项 | 值 |
| --- | --- |
| 包名 | `com.hytools.hang2048.apk` |
| 版本 | 1.0.0 |
| 支持版本 | Android 7.0+（minSdk 24） |
| 目标版本 | Android 16（targetSdk 36） |
| APK 体积 | **2.60 MB** |
| 权限 | **仅 `VIBRATE`**（震动反馈） |

### 权限说明

这是本项目的核心设计目标——**不申请任何敏感权限**：

| 权限 | 状态 | 说明 |
| --- | --- | --- |
| `INTERNET` | ❌ 未申请 | 所有资源都在 APK 内本地加载，`blockNetworkLoads = true` 从源头禁止网络请求 |
| 存储权限 | ❌ 未申请 | 无存档功能，不读写外部存储 |
| `ACCESS_NETWORK_STATE` | ❌ 未申请 | 无网络功能 |
| `VIBRATE` | ✅ 已申请 | 合并/胜利/失败三档震动反馈。属 normal 级权限，安装时不弹窗 |

> 清单里另有 `com.hytools.hang2048.apk.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`，
> 那是 AndroidX 自动生成的**应用内部**权限，不涉及用户隐私，也无法被外部应用使用。

## 操作方式

| 操作 | 说明 |
| --- | --- |
| **上下左右滑动** | 在棋盘上滑动即可移动（取代桌面版的方向键） |
| 拖动阈值 | 随格子尺寸自适应，约 24–33 px |
| 连续滑动 | 手指不抬起也能连续操作 |
| **返回键** | 第一次关结算面板；否则提示「再按一次退出」；第二次才真正退出 |
| 重置 | 顶部「重置」按钮 |

多指触摸只响应第一根手指，第二根手指不会干扰；系统手势打断（`pointercancel`）会干净地清理状态。

## 目录结构

```
Hang2048-APK/
├─ renderer/                    Web 层（响应式改造版）
│  ├─ index.html                DOM 骨架 + 触屏 viewport + CSP
│  ├─ styles.css                全部样式（尺寸走 CSS 变量）
│  └─ renderer.js               游戏逻辑 + 布局计算 + 震动/返回键桥接
├─ android/                     Android 工程
│  ├─ settings.gradle           仓库配置（含国内镜像）
│  ├─ build.gradle              插件版本
│  ├─ app/
│  │  ├─ build.gradle           模块配置 + 签名 + 资源同步
│  │  ├─ proguard-rules.pro
│  │  └─ src/main/
│  │     ├─ AndroidManifest.xml 权限声明（只有 VIBRATE）
│  │     ├─ java/.../MainActivity.kt      WebView 壳 + JS 桥 + 返回键
│  │     ├─ java/.../WindowCompatHelper.kt 沉浸式显示
│  │     └─ res/                 图标（5 密度）+ 字符串 + 主题
│  └─ gradlew.bat               Gradle wrapper（8.9）
├─ tools/
│  ├─ make-android-icons.cjs    icon.png → 5 密度 mipmap（纯 Node，无依赖）
│  ├─ build-apk.cjs             一键构建（环境检查 + 签名 + 收集产物）
│  ├─ verify-apk.cjs            APK 静态验证（23 项）
│  ├─ layout-check.cjs          响应式布局验证（9 机型 × 9 项）
│  └─ smoke.cjs                 逻辑测试（61 项）
├─ output/                      产物（已 gitignore）
└─ icon.png                     图标源文件（512×512）
```

## 构建

### 前置环境

| 组件 | 要求 | 本机实测 |
| --- | --- | --- |
| JDK | 17+ | Microsoft OpenJDK 21.0.9 ✅ |
| Android SDK | platform 36 + build-tools 36.x | 已装 ✅ |
| Gradle | 由 wrapper 提供 8.9 | 自动下载 ✅ |

### 命令

```bash
npm run icons     # 生成 Android 图标（改动 icon.png 后执行）
npm run apk       # 构建 release APK（需要签名材料）
npm run apk:debug # 构建 debug APK
npm run verify    # 静态验证 APK（23 项）
npm run smoke     # 逻辑测试（61 项，需 electron）
npm run layout    # 响应式布局测试（9 机型）
```

### 签名

`npm run apk` 首次运行会自动生成签名材料，**存放在项目之外**：

```
~/.hang2048-android/
├─ hang2048-release.jks    密钥库（30 年有效期）
└─ README.txt              密码备份说明
```

项目内的 `android/keystore.properties` 会自动生成并被 `.gitignore` 忽略。
这样设计是为了让**项目本身可以直接公开**，不夹带任何密钥材料。

> ⚠️ **务必备份 `~/.hang2048-android/`**。一旦丢失，就无法再给已安装用户推送更新
> （Android 要求更新包必须用同一把密钥签名）。

### 产物

```
output/Hang2048-1.0.0-release.apk    2.60 MB
```

## 移植关键技术点

### 1. 响应式布局

桌面版的 `#app` 固定 `550×600`、`.board` 固定 `500×500`、`CELL=110` 是常量。
移植后改为**运行时计算**：

```
棋盘边长 = min(可用宽度, 可用高度 - 顶部栏实测高度)
格子边长 = 棋盘边长 / (4 + 5 × gap比例)
字号     = 格子边长 × (16/110)
```

结果写入 CSS 变量（`--board` / `--cell` / `--gap` / `--font-base` 等），
CSS 里不再有写死的棋盘尺寸。实测 9 种机型，竖屏宽度利用率 **100%**。

### 2. 触摸手势

- `viewport` 禁缩放 + `viewport-fit=cover`
- `overscroll-behavior: none` + `touch-action: none`
- `touchmove` 全程 `preventDefault`，挡掉滚动和下拉刷新
- `pointerdown` 用 `setPointerCapture` 锁定手指，滑出棋盘也不丢事件
- 多指过滤：只有第一个 `pointerId` 被跟踪

### 3. 返回键

页面侧 `window.__h2048.onBackKey()` 返回 `true` 表示已处理，
`MainActivity` 通过 `OnBackPressedCallback` 读取返回值决定是否真正退出。

### 4. 震动

`MainActivity` 通过 `addJavascriptInterface` 暴露 `AndroidBridge.vibrate(kind)`，
页面侧优先走原生桥，无桥时降级到 `navigator.vibrate`。

### 5. 沉浸式与安全区

`WindowCompat.setDecorFitsSystemWindows(false)` + 透明系统栏，
页面用 `env(safe-area-inset-*)` 自行避让刘海和手势条。

## 已知坑（重装环境时注意）

1. **`ANDROID_HOME` 系统级变量可能指向不存在的路径** —— 本项目用
   `android/local.properties` 显式指定 SDK 路径绕开，构建脚本每次会重写它。
2. **Google 直连受限** —— `dl.google.com` / `services.gradle.org` 连不上。
   已改用腾讯云镜像（`mirrors.cloud.tencent.com`）下载 Gradle 发行版，
   Maven 依赖走阿里云镜像（见 `settings.gradle`）。
3. **AGP 默认要 build-tools 34.0.0** —— 本机只有 36.x 且无法自动补装，
   已在 `app/build.gradle` 显式声明 `buildToolsVersion '36.0.0'`。
4. **Kotlin stdlib 版本冲突** —— `kotlin-stdlib 1.8.x` 与
   `kotlin-stdlib-jdk7/jdk8 1.6.x` 类重复会导致 `checkDuplicateClasses` 失败，
   已用 `kotlin-bom` 统一版本。
5. **XML 注释里不能出现 `--`** —— 资源文件里踩过，会导致 `mergeResources` 失败。
6. **`WebView.destroy()` 前必须先摘出视图树** —— 否则打警告且渲染进程可能
   以 crash 形式被回收（`onDestroy` 里已处理）。

## 许可

MIT © HYTools
