# 卡路里小助手

安卓单机热量记录应用。拍照识别食物、记录每日摄入、跟踪体重与趋势。数据全部保存在本机，不做云同步。

## 功能

- 首次启动填写身高、体重、年龄、性别、活动水平、目标，自动算出 BMI、基础代谢、每日总消耗、目标热量与蛋白质/脂肪/碳水目标
- 首页展示今日摄入环形进度、三大营养素进度、当日记录；左右箭头切换日期回看
- 拍照识别：调用 DeepSeek 接口，结果进底部抽屉，确认后入库
- 手动录入，单条修改与删除
- 体重记录，一天一条，同日覆盖
- 统计：近七天热量柱状图（含目标虚线）、近三十天体重折线、本周日均摄入与蛋白质、体重变化
- 导出与导入全部数据为 JSON，清空数据二次确认
- API Key 只保存在本机

不做：账号、云同步、社交、饮食建议生成、运动记录、喝水提醒、通知推送。

## 目录

```
www/                 前端页面与逻辑
  index.html
  style.css
  app.js             页面渲染与交互
  db.js              IndexedDB Promise 封装
android/             安卓壳
  AndroidManifest.xml
  src/com/suxiangyu/calorie/MainActivity.java
  src/com/suxiangyu/calorie/LocalServer.java
  res/               图标、字符串、网络安全配置
build.sh             构建脚本
dist/                构建产物，不入库
docs/                使用与开发文档
design/              图标源文件
keys/                签名文件与口令，不入库
```

## 技术形态

纯前端页面加一个原生 WebView 壳，没有前端框架、没有构建工具、没有第三方 JS 库。

页面由应用内置的本地 HTTP 服务托管在 `http://127.0.0.1:17890/`，原因有三个：

1. 摄像头：`getUserMedia` 要求安全上下文，`127.0.0.1` 算安全上下文，`file://` 不算。
2. 数据持久：localStorage 和 IndexedDB 按 origin 隔离，端口必须固定，否则升级重启后数据读不到。
3. 接口转发：DeepSeek 接口不返回 CORS 头，页面直接请求会被拦。前端请求同源的 `/api/analyze`，由原生层转发到 `https://api.deepseek.com`，并把导出文件写进系统下载目录。

规格里写的是 Capacitor。实际落地时 Capacitor 解决不了上述三条中的任何一条，仍然要写原生代码，还会引入 npm 与 Gradle 依赖。换成等价的 WebView 壳后功能一致，构建只依赖 JDK 与 Android SDK，产物约 170 KB。

## 构建

```bash
bash build.sh
```

产物在 `dist/卡路里小助手-<版本>.apk` 和 `dist/卡路里小助手.apk`。

依赖：

- JDK 17 以上
- Android SDK：platforms/android-35、build-tools/35.0.0，默认路径 `/root/android-sdk`，可用 `ANDROID_SDK` 覆盖
- 本机若为 arm64，`aapt2` 与 `zipalign` 是 x86_64 二进制，脚本通过 `qemu-x86_64-static` 运行

签名：`keys/release.jks` 与 `keys/storepass` 不入库，重装或换机前先备份，否则新签名无法覆盖安装。

## 数据

- 身体信息与 API Key：localStorage 的 `profile` 键
- 食物记录：IndexedDB `calorieApp` 的 `meals` 表
- 体重记录：IndexedDB `calorieApp` 的 `weights` 表，日期为主键

导出文件写在系统「下载」目录，文件名 `热量记录-YYYY-MM-DD.json`。导出内容包含身体信息，不包含 API Key。

## 已知限制

- 拍照识别需要有效的 DeepSeek API Key。模型名写在 `www/app.js` 的 `MODEL` 常量，默认 `deepseek-flash`，账号不支持时改成实际可用的模型。
- 识别结果受光线与拍摄角度影响，置信度低时抽屉顶部会提示核对。
- 只有亮色主题，单用户，无多设备同步。
