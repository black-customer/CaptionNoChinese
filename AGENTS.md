# AGENTS.md — CaptionNoChinese 开发与协作规范

本文件为所有在此仓库工作的 AI Agent 与开发者提供统一的工程、测试、Git 提交和发布规范。

## 1. 项目概览与目录结构

本项目以 **桌面 B 站双语字幕遮罩与场景记录库（Userscript v3.0.0）** 为主交付物，并包含独立的 Android 原型目录：

- `src/` — Userscript 模块化源码（唯一真相源）
  - `main.js` — 入口、播放器挂载、遮罩交互、全局快捷键、设置/帮助面板
  - `player.js` — B 站播放器识别、BV/EP/分 P 来源解析、跨页定位、截图
  - `storage.js` — IndexedDB 存储、迁移、导入导出校验与事务提交
  - `config.js` — `GM_getValue`/`GM_setValue` 与 `localStorage` 配置隔离存储
  - `notebook.js` — 场景记录库、分集与剧集筛选、备注草稿串行保存、导出与备份预览
  - `shortcuts.js` — 自定义快捷键规范化、事件匹配、冲突检测与展示格式化
  - `editable.js` — 输入态与 Shadow DOM 焦点/事件路径判定（所有快捷键共用）
  - `app.css` / `notebook.css` — 样式文件（构建时内联）
- `scripts/build.mjs` — esbuild 构建脚本，生成根目录单文件产物
- `bilibili-caption-blur-mask.user.js` & `bilibili-caption-blur-mask.meta.js` — 构建产物（用户直装与自动更新目标，**禁止只手改产物不改源码**）
- `tests/` — Node 单元/集成测试（`tests/*.test.js`）与 Playwright 模拟播放器测试（`tests/browser/app.spec.js`）
- `docs/` — 验收记录（`ACCEPTANCE.md`）、发布说明、历史评审与 Android 设计文档
- `android/` — 独立 Android 局部背景模糊悬浮窗原型（与桌面 Userscript 独立演进和发布）

## 2. 核心开发约束

1. **源码优先，禁止只改构建产物**：修改任何功能必须编辑 `src/`，然后运行 `npm run build`（或 `npm run check`）同步重新生成 `bilibili-caption-blur-mask.user.js` 和 `bilibili-caption-blur-mask.meta.js`。
2. **保持安装元数据稳定**：`scripts/build.mjs` 中的 `@name`、`@namespace`、`@updateURL`、`@downloadURL` 不可随意更改，确保老用户的脚本管理器能平滑覆盖升级。
3. **快捷键防误触硬性要求**：任何新增键盘快捷键都必须复用 `src/editable.js` 的 `isEditableEvent`，穿透检查 B 站 Shadow DOM 评论区（`composedPath()` + 深层 `activeElement`），并避开设置/帮助面板和可聚焦交互控件。
4. **存储安全与诚实文案**：
   - IndexedDB 写操作必须等待事务 `oncomplete` 才能提示成功；
   - 保持 `BiliCaptionStudyDB` v2 与 JSON 备份 schema v1 兼容，保留旧记录中的标签和复习字段；
   - 不承诺“无限容量 / 永久保存 / OCR / 自动翻译 / 云同步”；
   - 自动化测试通过不能宣称已在真实 B 站现场验收通过，真实站点验收记录在 `docs/ACCEPTANCE.md` 中区分标注。

## 3. 验证命令（提交前必跑）

环境要求：Node.js 24。

```bash
npm run check          # 运行全部 Node 单元/集成测试 + 构建产物 + 产物语法检查
npm run test:browser   # 运行 Playwright 无头浏览器集成测试
```

- 每次改动涉及 `src/` 或 `scripts/build.mjs`，都必须跑通 `npm run check`；
- 涉及 UI、快捷键、跨页导航、存储持久化的改动，必须同时跑通 `npm run test:browser`，并检查无报错与无横向溢出；
- 如修改 `android/`，需单独执行 `android/README.md` 中的 Gradle 构建、Lint 与几何单元测试，勿与桌面脚本改动混在同一个发布提交中。

## 4. Git 提交与同步规范（重要）

**原则：每次完成一项开发或修复，验证通过后必须统一整理并提交 Git，不要把跨多个阶段的未提交修改长期堆在工作区。**

### 提交前检查清单

1. 执行 `git status` 和 `git diff --stat`，确认工作区只包含本次任务相关的源码、测试、文档与最新构建产物。
2. **禁止提交以下文件**：
   - AI 工具或编辑器本地配置/临时目录（`.zcode/`、`.zcodeignore`、`.vscode/`、`.idea/`）
   - 测试与本地缓存产物（`artifacts/`、`test-results/`、`playwright-report/`、`.npm-cache/`）
   - 本地调试 APK、签名密钥（`*.keystore`、`*.jks`）及 `android/local.properties`
3. 提交信息遵循 Conventional Commits（如 `feat: ...`、`fix: ...`、`docs: ...`、`chore: ...`），语义清晰。
4. **桌面脚本与 Android 原型分批提交**：若 `android/` 尚处于未真机验收的原型阶段，不要误把未发布的 Android 原型和桌面发版混在同一次提交里，应按模块拆分为清晰独立的 commit（或单独分支）。
5. 每次确认无误准备交付时，及时 `git push origin main`（注意：`@updateURL` 指向 `main` 分支，**只有在版本号已升级且构建产物已同步、测试全过之后，才把面向用户的新版本推上 `main`**）。

## 5. 发版同步检查清单（Userscript 升级必做）

当向用户发布新版本（例如 `v3.0.0`）时，以下文件必须**同步更新为同一版本号**，缺一不可：

- [ ] `package.json`（`version`）
- [ ] `package-lock.json`（顶层与 `packages[""].version`）
- [ ] `src/notebook.js`（默认 `version` 参数）
- [ ] `tests/browser/app.spec.js`（`data-version` 断言）
- [ ] `README.md`（顶部版本号、更新亮点与操作说明）
- [ ] `SCRIPTCAT_README.md`（标题版本号、功能与快捷键，保持与脚本猫商店一致）
- [ ] `CHANGELOG.md`（将 `## 未发布` 改为正式版本号与日期）
- [ ] `docs/ACCEPTANCE.md`（记录本次自动检查结果及待完成的真实 B 站验收项）
- [ ] 运行 `npm run check` 重新生成 `bilibili-caption-blur-mask.user.js` 与 `bilibili-caption-blur-mask.meta.js`
- [ ] 运行 `npm run test:browser` 全部通过
- [ ] 提交 Git、推送 `origin/main`、创建对应 Git tag 与 GitHub Release（附最新 `bilibili-caption-blur-mask.user.js`），并确认 ScriptCat 商店已同步
