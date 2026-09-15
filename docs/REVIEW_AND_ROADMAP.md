# 项目评审与开发路线图

评审日期：2026-09-15
基线：`8ee115762d5a253a834ae21ab1e3e099101b6d4f`，脚本版本 `2.2.0`。

## 1. 结论

项目已经做出了一个有明确用途的原型：**在 B 站遮挡硬字幕中的中文，并把值得复听的场景收藏下来。** 遮罩调节、临时查看中文、截图和笔记抽屉已经连通，零运行时第三方依赖、单脚本安装也是值得保留的优势。

目前最限制后续发展的，是收藏的数据可靠性、原视频定位和播放器生命周期。建议按以下顺序推进：

1. **可靠性版本**：保证收藏真正保存成功、迁移不破坏数据、能够回到正确视频。
2. **复习版本**：加入片段循环、检索、标签和简单的复习状态，让收藏被再次使用。
3. **辅助学习版本**：按需增加字幕文本、OCR、Anki 导出和词句解释。

不建议在当前基础上同时展开账号、云同步、多站点和持续后台 AI 识别。先完成一条可验证的使用流程，再扩大范围。

### 评审范围与证据边界

- 阅读全部已跟踪文件：一个约 1,469 行、56 KB 的 userscript、两份 README、MIT LICENSE 和 `.gitignore`。
- 初始工作区干净；仓库没有测试套件、依赖清单、构建配置或 CI 配置，也没有适用的 `AGENTS.md`。
- 使用 Node v24.13.0 做语法检查；抽取原始函数，以内存数据库、DOM 和事件夹具做最小复现。没有把模拟数据库当成真实浏览器 IndexedDB。
- 使用 impeccable 做代码层面的 UI 审查；机械扫描返回 `[]`。单文件内大量字符串模板不一定被扫描器完整覆盖，结果不等于无缺陷。
- 查阅 MDN、W3C 和 Tampermonkey 官方资料核对平台行为。
- **未在登录态 B 站、真实油猴/脚本猫环境中执行端到端验收，未测 FPS、内存峰值或真实存储配额。** 下文明确区分函数复现、静态确定逻辑和待实机验证风险。
- 本次新增评审文档，没有修改运行脚本，也没有提交或发布版本。

## 2. 按优先级排列的问题

P1：应在下一次稳定发布前修复，涉及数据丢失、安全边界或主要功能错误。
P2：应进入近期迭代，涉及特定运行场景、误操作或可访问性。
本节共 **11 项：P1 5 项、P2 6 项**；没有发现需要定义为 P0 的全量不可用问题。后面的性能和兼容性风险不计入已确认问题数量。

### F01 · P1 · 历史迁移重复覆盖新数据，恢复已删除卡片

**位置：** [migrateOldStorage，第 202 行](https://github.com/black-customer/CaptionNoChinese/blob/8ee115762d5a253a834ae21ab1e3e099101b6d4f/bilibili-caption-blur-mask.user.js#L202)，重点为 205 行读取 GM 历史值、219 行 `put`、225 行仅清除 localStorage；每次启动由 1374 行重新调用。

- **触发：** 升级用户仍有 `GM_getValue('bili_caption_notes_v200')` 历史数据。迁移后修改或删除卡片，再刷新页面。
- **问题：** GM 历史键一直存在，脚本每次用旧记录 `put` 覆盖现有记录。新笔记会回退，删除的卡片重新出现。
- **验证：** 抽取原函数执行两次迁移，修改后的 `edited text` 被覆盖为 `old text`；删除的 `old_1` 被重新写回。
- **修复：** 增加迁移版本和完成标记；成功提交之后处理所有旧存储来源。重复迁移必须幂等，不能覆盖已更新记录。保留失败恢复路径。
- **验收：** 迁移后编辑、删除、连续刷新，内容不回退、卡片不复活。

### F02 · P1 · 迁移失败也可能删除唯一历史副本

**位置：** [迁移数据库写入与旧数据清理，第 210 行](https://github.com/black-customer/CaptionNoChinese/blob/8ee115762d5a253a834ae21ab1e3e099101b6d4f/bilibili-caption-blur-mask.user.js#L210)。

- **触发：** 旧卡片只在 localStorage，IndexedDB 打开失败，或写入事务稍后中止。
- **问题：** `db` 为 null 时仍执行 `removeItem`；有数据库时也没有等待事务提交就删除旧数据并输出迁移成功。
- **验证：** 将 `openDatabase()` 模拟为返回 null，唯一 localStorage 副本仍被删除；排队写入但尚未提交时，旧存储也已经被清理。
- **修复：** 在事务 `complete` 后才标记迁移完成；失败保留原始副本，并允许重试/导出。迁移前检查结构，不要无提示删除可能有价值的旧字段。
- **验收：** 数据库不可用、配额不足、事务 abort、迁移中关闭页面，旧副本仍可恢复。

### F03 · P1 · 收藏成功提示不代表数据已经保存

**位置：** [dbSaveNote，第 133 行](https://github.com/black-customer/CaptionNoChinese/blob/8ee115762d5a253a834ae21ab1e3e099101b6d4f/bilibili-caption-blur-mask.user.js#L133)、[收藏成功提示，第 823 行](https://github.com/black-customer/CaptionNoChinese/blob/8ee115762d5a253a834ae21ab1e3e099101b6d4f/bilibili-caption-blur-mask.user.js#L823)；删除、修改、清空也有同类问题，见 148–198 行。

- **触发：** IndexedDB 不可用、事务失败或存储配额不足。
- **问题：** 先改内存缓存，再发起写入；异步函数没有等待事务完成，也没有传播异步错误。`await dbSaveNote()` 因此不能保证持久化，界面却显示“已收藏”。清空失败也可能先显示“已清空”。
- **验证：** 尚未提交的模拟事务中，`await dbSaveNote()` 已结束，缓存已更新，事务未注册 `oncomplete/onabort/onerror`。
- **修复：** 封装真正等待事务结束的 Promise；明确“保存中 / 已保存 / 保存失败”状态。乐观更新必须支持回滚或失败标记，不能静默变为仅本次会话可用的缓存。
- **验收：** 强制写入失败时不显示成功；刷新前后内容一致；失败数据可重试或导出。

IndexedDB 的 `complete` 事件表示事务成功提交，单次 `put()` 返回不代表事务完成。参考 [MDN：IDBTransaction complete](https://developer.mozilla.org/en-US/docs/Web/API/IDBTransaction/complete_event)。

### F04 · P1 · 笔记和标题被作为 HTML 插入

**位置：** [renderDrawerList，第 1192 行](https://github.com/black-customer/CaptionNoChinese/blob/8ee115762d5a253a834ae21ab1e3e099101b6d4f/bilibili-caption-blur-mask.user.js#L1192)，尤其是 1194 行标题和 1202 行 `userNote`。

- **触发：** 笔记或标题中含 HTML 标记；笔记以 `textContent` 保存后，又通过 `innerHTML` 展示。
- **问题：** 纯文本会被解释成标签，既可能丢字、破坏布局，也形成 HTML 注入入口。涉及图片属性的动态拼接也应一起检查。
- **验证：** 原函数将 `<b>literal markup</b>` 原样拼入 `card.innerHTML`。已确认不安全插入点；**没有证明恶意代码能绕过当前 B 站 CSP 执行，也没有发现实际攻击。**
- **修复：** 固定 DOM 结构后使用 `textContent` 或 textarea `value` 设置文本；图片 URL 通过属性赋值并校验类型。若以后支持富文本，单独设计允许标签和清洗规则。
- **验收：** `<b>hello</b>`、尖括号、引号和包含事件属性的文本均按普通文字显示，不能新建可执行节点。

平台语义参考 [MDN：innerHTML 的安全注意事项](https://developer.mozilla.org/en-US/docs/Web/API/Element/innerHTML)。

### F05 · P1 · 跨集卡片会跳到当前集的相同时间

**位置：** [卡片数据结构，第 811 行](https://github.com/black-customer/CaptionNoChinese/blob/8ee115762d5a253a834ae21ab1e3e099101b6d4f/bilibili-caption-blur-mask.user.js#L811)、[时间戳点击处理，第 1206 行](https://github.com/black-customer/CaptionNoChinese/blob/8ee115762d5a253a834ae21ab1e3e099101b6d4f/bilibili-caption-blur-mask.user.js#L1206)。

- **触发：** 同一系列的第 1 集或多 P 视频的 P1 收藏后，切到第 2 集/P2，再点击旧卡片。
- **问题：** 卡片只记录系列 ID、显示标题和秒数，没有可靠的来源视频/分集标识或 URL。点击只给当前页面第一个媒体元素设置 `currentTime`。
- **验证：** EP1 的卡片点击后，模拟当前 EP2 的媒体被设置为 42 秒并播放，没有检查集数或导航。
- **修复：** 区分 `seriesId` 与 `sourceId`；保存规范来源 URL、BV/EP/CID/P 等适用身份。先解析正确视频，再等待媒体就绪并 seek。旧卡片缺来源时显示限制，不能从标题猜一个确定地址。
- **验收：** A 集收藏、B 集打开，能回到 A 集目标时刻；无法解析时提供清楚的来源/失败提示。导出也保留来源链接。

### F06 · P2 · SPA 切换视频后，新遮罩配置没有应用到 DOM

**位置：** [syncSeriesConfig，第 270 行](https://github.com/black-customer/CaptionNoChinese/blob/8ee115762d5a253a834ae21ab1e3e099101b6d4f/bilibili-caption-blur-mask.user.js#L270)、[mount 重建条件，第 1402 行](https://github.com/black-customer/CaptionNoChinese/blob/8ee115762d5a253a834ae21ab1e3e099101b6d4f/bilibili-caption-blur-mask.user.js#L1402)。

- **触发：** 站内导航复用同一个播放器容器，A、B 视频的遮罩配置不同。
- **问题：** `config` 已换成 B，但 `applyStyles()` 只在创建遮罩时调用。仍显示 A 的位置，下一次微调才突然跳到 B 的位置。
- **验证：** A 的 top=84，B 的 top=60，切换后 `configTop=60`，DOM 的 `renderedTop='84%'`。
- **修复/验收：** 视频身份变化与 DOM 重建分开处理；只要配置变了就更新现有遮罩。复用容器、替换容器两种导航都验证。

### F07 · P2 · Canvas 截图分支将时间固定记为 00:00

**位置：** [Canvas 回退分支，第 726 行](https://github.com/black-customer/CaptionNoChinese/blob/8ee115762d5a253a834ae21ab1e3e099101b6d4f/bilibili-caption-blur-mask.user.js#L726)、[读取收藏时间，第 801 行](https://github.com/black-customer/CaptionNoChinese/blob/8ee115762d5a253a834ae21ab1e3e099101b6d4f/bilibili-caption-blur-mask.user.js#L801)。

- **触发：** 兼容分支返回播放器 canvas 作为截图来源。
- **问题：** canvas 没有 `currentTime`，因此 `media.currentTime || 0` 总是得到 0。图片与播放控制使用了同一个抽象，但它们不一定是同一个对象。
- **证据：** 静态确定逻辑；尚未确认 B 站当前哪些页面走这个分支。
- **修复/验收：** 将“可绘制图像源”和“播放控制器”分离；模拟视频/Canvas 两条路径都应记录控制器的真实时间，拿不到时间时报告不可用。

### F08 · P2 · 原生播放器全屏时，抽屉和 Toast 可能不可见

**位置：** [抽屉挂到 body，第 1381 行](https://github.com/black-customer/CaptionNoChinese/blob/8ee115762d5a253a834ae21ab1e3e099101b6d4f/bilibili-caption-blur-mask.user.js#L1381)、[Toast 挂载，第 712 行](https://github.com/black-customer/CaptionNoChinese/blob/8ee115762d5a253a834ae21ab1e3e099101b6d4f/bilibili-caption-blur-mask.user.js#L712)。

- **触发：** 请求原生全屏的是播放器元素，而不是整个 documentElement。
- **问题：** 抽屉/Toast 始终在 body 下，不是全屏元素的后代，增大 `z-index` 不能解决全屏展示层的问题。此时抽屉状态虽然变为 open，用户仍看不到。
- **证据：** DOM 挂载结构与 Fullscreen API 规则；未进行真实 B 站现场验收。网页全屏与 F11 不是同一个触发条件。
- **修复/验收：** 创建统一 UI 根节点并响应 `fullscreenchange`。对播放器容器全屏时迁移 UI，退出时还原；对媒体元素自身全屏等无法挂后代 UI 的情况明确降级。

参考 [MDN：Fullscreen API 指南](https://developer.mozilla.org/en-US/docs/Web/API/Fullscreen_API/Guide)。

### F09 · P2 · Alt+滚轮在无播放器页面或播放器外也被拦截

**位置：** [wheel 事件处理，第 1274 行](https://github.com/black-customer/CaptionNoChinese/blob/8ee115762d5a253a834ae21ab1e3e099101b6d4f/bilibili-caption-blur-mask.user.js#L1274)，并结合 7–8 行匹配整个 B 站。

- **触发：** 默认开启遮罩时，在首页或播放器外评论区使用 Alt+滚轮。
- **问题：** 确认播放器之前就调用 `preventDefault/stopPropagation/stopImmediatePropagation`；存在播放器时也不检查事件目标，评论区操作会调节遮罩。
- **验证：** `getContainer()=>null` 的原函数夹具仍记录到三种拦截调用。
- **修复/验收：** 先确认活动播放器、事件范围和可编辑元素；只在有效区域内消费事件。无播放器页面保留原行为。

### F10 · P2 · 长按快捷键会连续截图和反复切换状态

**位置：** [keydown 分支，第 1324 行](https://github.com/black-customer/CaptionNoChinese/blob/8ee115762d5a253a834ae21ab1e3e099101b6d4f/bilibili-caption-blur-mask.user.js#L1324)，其他切换键见 1330–1346 行。

- **触发：** 按住 S/Alt+S 直到系统产生键盘重复事件。
- **问题：** 没有过滤 `e.repeat`，也没有截图互斥或短期去重，单次长按会生成多张近似图片并连续编码、写库。B/C/Z 则反复切换状态。
- **验证：** 1 次初始事件加 9 次 repeat 事件，截图函数被调用 10 次。
- **修复/验收：** 非连续操作忽略 repeat，明确允许的修饰键组合；一次长按最多执行一次动作，连续明确按键仍可按设计触发。

### F11 · P2 · 抽屉和操作控件缺少完整的键盘与可访问性支持

**位置：** [抽屉隐藏样式，第 549 行](https://github.com/black-customer/CaptionNoChinese/blob/8ee115762d5a253a834ae21ab1e3e099101b6d4f/bilibili-caption-blur-mask.user.js#L549)、[按钮颜色，第 589 行](https://github.com/black-customer/CaptionNoChinese/blob/8ee115762d5a253a834ae21ab1e3e099101b6d4f/bilibili-caption-blur-mask.user.js#L589)、[时间戳 span，第 1196 行](https://github.com/black-customer/CaptionNoChinese/blob/8ee115762d5a253a834ae21ab1e3e099101b6d4f/bilibili-caption-blur-mask.user.js#L1196)、[打开关闭，第 1152 行](https://github.com/black-customer/CaptionNoChinese/blob/8ee115762d5a253a834ae21ab1e3e099101b6d4f/bilibili-caption-blur-mask.user.js#L1152)。

- 时间戳使用只有 click 监听的 span，没有键盘激活路径；图片无 alt；笔记编辑区缺少明确的可访问名称。
- 关闭抽屉只是 transform 移出屏幕，没有 `inert`/隐藏焦点管理；打开后不移入焦点，关闭后不返回触发按钮。Dock 自动隐藏也没有焦点保持逻辑。
- 小号白字 `#fff` 配 `#00aeec` 按钮背景，计算对比度约 **2.54:1**，低于普通文字的 4.5:1。
- **修复/验收：** 用真实按钮实现时间跳转；编辑区提供 label；设计抽屉的非模态焦点流程和关闭行为；隐藏区域退出 Tab 序列；Toast 使用状态播报；调整按钮配色。全流程只用 Tab/Enter/Escape 可操作，并能看清当前焦点。

对比度标准参考 [W3C：文字对比度](https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum)。本次没有进行读屏器实测，不宣称已完成 WCAG 合规评估。

## 3. 兼容性与性能风险：需要测量或真实环境确认

| 风险 | 代码证据 | 下一步验证与处理 |
|---|---|---|
| 页面状态读取不稳定 | `getSeriesInfo` 44–71 行依赖 `window.__INITIAL_STATE__`；缺 season 时退到 `bgm_ep…` | 在 Tampermonkey/ScriptCat 和当前番剧页面验证脚本沙箱可见性、初始化时序、SPA 更新；不能直接认定所有环境都读不到。稳定系列身份与来源身份分离 |
| 遮罩与黑边比例不匹配 | 944–949 行按容器百分比定位；没有计算真实视频矩形 | 宽银幕、竖屏、网页/原生全屏组合测试。示例：2560×1080 视频 contain 在 1920×1080 容器，top=84% 两种坐标相差 91.8px；是否触发取决于实际容器布局 |
| 读笔记响应覆盖新页面缓存 | 232–236 行没有请求版本或当前系列复核 | 可控乱序夹具中 B 先返回、A 后返回，最终在 B 页面显示 A 缓存；真实 IndexedDB 调度触发频率未验证。加请求序号和 seriesId 校验 |
| 大卡片集导致内存与渲染开销 | 121 行 getAll，1184–1233 行全量重建列表，778 行同步 JPEG Data URL 编码 | 测 100/1,000/5,000 条的打开、输入、删除、截图延迟与峰值内存。元数据分页，图片按需加载，Blob 与缩略图分开，抽屉关闭时不全量建卡片 |
| 页面每次 DOM 变动都扫描播放器 | 1449–1461 行观察整个 body，同时每秒 mount | 在弹幕/评论更新时采样调用频率和长任务；合并调度、缩小观察范围、仅在必要时读布局，保留低频恢复机制 |
| 容器切换缺少完整卸载 | 1387–1408 行可能保留失联容器；880–903 行绑定事件无 disposer | 连续切集、销毁并复用容器，检查旧 UI、监听与计时器是否残留；统一 mount/unmount |
| 多媒体对象可能不一致 | 截图、遮罩、回放多次从 document 选第一个候选 | 多视频/预览共存时，确认三个功能引用同一个活动播放器 |
| 正在编辑的文字可能被重绘丢弃 | 1224 行只在 blur 保存；1184 行整段清空重建 | 编辑时关闭抽屉、切集、触发新卡片/重载，检查 blur 与未保存文字；改为 input 更新草稿、节流持久化，避免销毁编辑节点 |
| 窄视口、缩放与动画偏好 | 抽屉固定 380px、引导宽 320px；无响应式断点或 reduced-motion | 桌面 200% 缩放、窄窗口验收；使用最大可用宽度、可换行头部、保留状态反馈的减弱动画 |
| 截图兼容与降级 | Canvas drawImage 回退到 bwp-video；失败统一返回 null | 测普通视频、Canvas、自定义媒体、未就绪、跨域限制；针对能力不足给出具体状态，允许仅保存来源和时间 |
| 多标签页覆盖彼此配置 | 247–262 行各页读取完整快照，保存时整体回写 | 两标签分别调整不同剧集后交替保存/刷新，验证修改是否保留；按配置项存储或加入变更合并 |
| 重复导出累积内存 | 1260 行创建 object URL，未释放 | 在大样本重复导出时测量；下载触发后适当延迟调用 `URL.revokeObjectURL()`，统一管理媒体 URL 生命周期 |

脚本目前没有主动网络上传笔记的代码。IndexedDB 属于浏览器管理的本地数据，不能把“本地”直接理解为永不丢失。浏览器配额、逐出和清理站点数据都会影响存储；持久化申请也不能替代备份。参考 [MDN：存储配额与逐出](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)。

### UI 代码审查评分（只作后续改进基线）

| 维度 | 0–4 分 | 依据 |
|---|---:|---|
| 可访问性 | 1 | 有原生按钮和 Esc，但时间跳转、焦点管理、标签与对比度有缺口 |
| 性能设计 | 2 | 零第三方运行依赖、截图有限宽；全量读图/渲染和广域 observer 仍需优化 |
| 响应式设计 | 1 | 遮罩按百分比；抽屉、引导和头部没有窄窗口策略 |
| 主题与 token | 0 | 颜色、间距写在字符串 CSS/HTML 中，没有 token 层；固定影院暗色本身不是缺陷 |
| 实现一致性 | 2 | 功能围绕明确观影任务，但数据成功反馈与说明文字超出实现保障 |
| **合计** | **6/20** | **按 impeccable 技术量表属于较弱档；不是对产品价值或实测性能的打分** |

实现一致性结论：**面向发布的可靠性要求暂未通过**，证据是虚假成功状态与迁移风险。视觉上有一致的影院暗色、蓝色交互点和渐隐控件；应保留其观影定位，不需要因为评分而全面改版。

UI 后续可按 `$impeccable harden`（焦点与失败状态）、`$impeccable adapt`（窄窗口）、`$impeccable clarify`（保存/导出文案）、`$impeccable optimize`（测量后的渲染优化）、`$impeccable polish`（最终整理）推进。可逐项或合并执行；修复后重新运行 `$impeccable audit`。核心数据和播放器修复仍按上面的工程问题实施。

## 4. 文档与发布承诺需要收敛

| 当前说法 | 当前真实行为 | 建议表述/开发动作 |
|---|---|---|
| 原画高清截图 | 最大宽度 960px，JPEG 0.85；见 772–778 行 | 写明压缩截图；后续可选清晰度与容量估算 |
| 永不爆仓、永久保存 | 没有容量管理、可恢复备份和可靠失败反馈 | 写明本浏览器本机保存；加入容量查看与备份恢复 |
| 秒跳回原视频 | 仅 seek 当前媒体，不验证来源 | 修复 F05 前说明同视频内跳转限制 |
| 整季自动继承 | 依赖能读到 season_id；普通视频按 BV 分组 | 说明支持条件；设计系列归组与手动配置继承 |
| 生词本、完整学习闭环 | 当前是图片 + 时间 + 自由文本，无词条或复习状态 | 先称“场景收藏/复习本”，再逐步增加真实复习能力 |
| 新手直接使用 | [README 安装部分](https://github.com/black-customer/CaptionNoChinese/blob/8ee115762d5a253a834ae21ab1e3e099101b6d4f/README.md#L43) 从编辑已有脚本开始 | 补首次安装、启用权限、支持页面/管理器、故障排查与更新方法 |

Markdown 当前将 Data URL 图片内嵌进一个文件，内容随卡片数显著增大，渲染器支持也应实测；没有导入能力，因此它不是完整备份。建议区分“阅读导出”和“备份恢复”：前者使用 Markdown + 图片目录的 ZIP，并附来源链接；后者包含带 schemaVersion 的结构化数据及媒体文件。

两份 README 分别承担开发/安装说明与发布页介绍，避免全文重复维护。增加 CHANGELOG、兼容性矩阵、故障报告模板；发布脚本和文档版本一起检查。命名空间与真实仓库地址也应核对。

## 5. 建议的产品方向

### 定位假设

优先服务桌面 B 站看双语剧集、容易依赖中文、希望轻量复听的英语学习者。这是从现有实现推导出的方向，尚未做用户访谈验证。

核心体验应该是：

**遮中文盲听 → 按需查看 → 收藏难句 → 回到正确片段 → 多次复听 → 自评与再次复习。**

已经完成前三步和基础笔记浏览；接下来最大的价值是把后半段补齐。

### 阶段一：可靠收藏与播放器适配（建议 v2.2.x → v2.3）

**先后顺序：** 数据修复与输入安全 → 来源模型和准确回放 → 生命周期与快捷键 → 备份和发布检查。

主要交付：

1. 修复 F01–F04；统一事务成功/失败语义、可重试状态，保留历史恢复路径。
2. 每条卡片保存稳定来源身份和规范 URL；新 ID 使用不易碰撞的 UUID；分开读取截图和播放时间。
3. 修复同容器切视频、全屏挂载、快捷键作用域与重复触发；集中管理资源清理。
4. 支持完整备份/导入、格式版本、导入预览、去重与冲突规则；删除支持短期撤销。
5. 提供存储状态与空间估算、再次打开帮助；修正文档与首次安装说明。

**发布验收：**

- 从旧版本迁移两次，记录不重复；后续修改不被覆盖，删除不复活。
- 模拟数据库拒绝、abort、空间不足，绝不显示虚假成功，旧副本不丢失。
- A 集收藏后切 B 集，能够正确回到 A 集；多 P 同样通过。
- 普通播放、网页全屏、支持的播放器容器原生全屏、SPA 两类容器切换均通过检查；媒体元素自身全屏无法承载 UI 时明确降级。
- 完整导出后，在干净测试库中导入，条数、来源、文本、时间和图片一致。
- 文本含 HTML 特殊字符仍按文本显示；播放器外键鼠行为不受干扰。

### 阶段二：日常复听与检索（建议 v2.4）

**依赖：** 来源身份、seek 和数据层已经可靠。

主要交付：

1. 收藏点提前 3–5 秒回放，可调整；手动设置 A–B 区间、重复次数、间隔与倍速。
2. 复习结束可返回原观影进度，避免复习打乱看剧位置。
3. 按系列/分集筛选、笔记全文搜索、标签；提供跨系列的收藏总览。
4. “待复习 / 仍不会 / 已掌握”状态，先用简单队列；先隐藏答案，回忆后揭示。
5. 分页读取元数据、图片懒加载，保护编辑中的草稿。
6. 快捷键配置、遮罩位置预设、模糊强度与不透明遮挡选项；按真实视频区域保存位置。

**发布验收：**

- 用户可完成“找到一条卡片 → 原片段复听 → 查看笔记 → 标记掌握”的完整流程。
- A–B 循环在暂停、seek、换集后状态明确，不在其他视频意外继续。
- 编辑过程中加载新卡片、切换筛选不会丢文字。
- 建立固定机器与 1,000 张卡片样本的性能基线。建议目标：抽屉首屏 300ms 内可交互、常规输入不出现可感知停顿；这是待校准的验收目标，不是当前实测值。

### 阶段三：减少手工输入（建议 v2.5+，逐项验证）

| 功能 | 优先级 | 为什么做 | 前提/边界 |
|---|---|---|---|
| Anki/通用格式导出 | 中高 | 让已有复习习惯的用户继续使用收藏 | 验证实际导入、图片与来源关联；格式兼容性单独测试 |
| 可访问字幕轨/用户导入 SRT、VTT | 中高 | 有文本与时间轴后才能做逐句复听、搜索台词 | 先检测能力；没有字幕时保留手工流程 |
| 手动框选字幕 OCR | 中 | 硬字幕场景减少输入 | 异步处理，不阻塞截图；保留原图并允许纠错 |
| 词义、短语和语境解释 | 中 | 帮助理解已确认的句子 | 标注生成结果，与原字幕分开；外部服务按需配置 |
| 简单间隔复习安排 | 中 | 帮助多次回忆同一场景 | 先验证用户确实会回访，不先投入复杂算法 |
| 跨设备同步、第二个平台 | 低/需求驱动 | 扩大使用范围 | 先确定数据模型、冲突策略和明确需求，分别立项 |

**发布验收：** 识别失败仍可手工收藏和回放；用户可修改识别结果；导出文件在目标应用真实导入通过；外部处理内容和费用明确，核心本地流程不依赖在线服务。

### 暂不优先的功能

账号体系、云端数据库、社交分享、排行榜、移动 App、全站点适配、持续后台 OCR/翻译。它们会扩大维护面，应等可靠收藏和实际复习行为稳定后再判断价值。

### 怎么判断功能是否有用

优先看“收藏后能否正确回听、是否再次打开复习、是否完成自评”，不要只看收藏总数。

- 工程指标：持久化成功率、准确定位成功率、导入一致性、卡片加载延迟。
- 产品指标：收藏后回听比例、一次复习完成率、同一条内容的再次复习情况。
- 工程指标通过测试夹具和实机采样验证；产品指标来自本地实际使用记录或用户反馈，夹具不能证明真实复习行为。个人学习统计默认留在本地，不需要为验证产品先接遥测服务。

## 6. 工程演进方案

### 源码拆分，发布仍保持一个 userscript

建议目录是未来结构，不是本次已实施的重构：

```text
src/
  main.js                  # 初始化、生命周期协调
  player/adapter.js        # 身份、播放控制、截图来源、实际视频矩形
  storage/database.js      # 事务与版本升级
  storage/migrations.js    # 可重试、幂等迁移
  storage/backup.js         # 导入、导出、格式校验
  mask/controller.js       # 配置与遮罩几何
  notebook/service.js      # 卡片、查询、复习状态
  ui/drawer.js             # 展示与焦点管理
  ui/styles.css            # 有作用域的样式与少量 tokens
  input/shortcuts.js       # 快捷键注册与作用域
tests/
  unit/
  integration/
  fixtures/player.html
bilibili-caption-blur-mask.user.js  # 保留易安装的发布产物
```

先抽取被修复功能需要的边界，不要求一次性重写。当前体量可以继续使用原生 DOM；无需先引入大型 UI 框架。构建工具只需把模块和样式打成单个脚本并保留 userscript metadata。选定工具时再核对当时版本和安装文档。

### 优先建立的接口

- `PlayerAdapter`：`getIdentity()`、`getPlaybackTime()`、`getDrawable()`、`getVideoRect()`、`seek()`、`subscribe()`、`dispose()`。
- `NoteRepository`：`save/update/delete/list` 的 Promise 在事务提交后完成；查询显式声明范围，响应携带上下文身份并校验当前视图，支持单系列与跨系列查询；UI 不直接写数据库。
- `OverlayController`：管理根节点、全屏、尺寸变化和卸载；尺寸和位置变动合并到同一绘制周期。
- `ReviewService`：管理来源导航、片段循环、自评；避免业务逻辑散落在 click handler 中。

### 数据模型建议

```text
Note
  id, schemaVersion, createdAt, updatedAt
  seriesId
  source: { platform, canonicalUrl, videoId, episodeId?, cid?, page? }
  position: { time, start?, end? }
  screenshot: { mediaId, width, height, mimeType }
  userNote, tags[], reviewState

Media
  id, blob, thumbnailBlob, byteSize
```

系列身份负责分组和遮罩继承，来源身份负责精确返回。图片与元数据分开，避免每次搜索都读出所有图片。旧数据缺少的来源信息应保持 unknown，不要迁移出虚假的精确性。

### 验证与发布流程

1. **纯逻辑测试**：视频身份、几何边界、时间格式、导出格式、去重与配置校验。
2. **数据库集成测试**：真实事务完成/中止、迁移重复执行、失败保留源、导入导出一致性。
3. **模拟播放器页面**：同容器切视频、替换容器、Canvas 与 video 分离、全屏 UI、键盘和编辑行为。
4. **真实浏览器人工矩阵**：Chrome/Edge + Tampermonkey、Chrome/Edge + ScriptCat；Firefox 在声明支持前验收。页面覆盖 BV、多 P、番剧和两类全屏。
5. **持续集成**：语法/静态检查、上述自动测试、构建和 metadata/版本一致性；手工实机结果随发布记录。

测试应围绕失败行为与用户结果，避免只验证内部函数存在。没有新的风险或代码变动时，不反复扩大测试范围。

## 7. 下一批可直接拆成任务的工作

| 顺序 | 任务 | 完成定义 |
|---|---|---|
| 1 | 统一数据库事务 API，修复迁移与虚假成功 | F01–F03 的失败与刷新回归全部通过 |
| 2 | 安全文本渲染 | F04 的特殊字符用例通过，不解析用户文本 |
| 3 | 来源模型、播放适配器和跨集回放 | F05、F07 通过；旧记录显示来源缺失状态 |
| 4 | 遮罩/抽屉生命周期和快捷键 | F06、F08–F11 的场景验证通过 |
| 5 | 备份恢复、文档与可安装发布 | 干净库恢复一致，首次安装步骤可重复 |
| 6 | A–B 复听 + 搜索筛选 + 轻量自评 | 完成一轮“收藏到复习”的用户流程 |

建议先完成前五项，发布一个可靠性版本，再用第六项验证复习方向。版本号是规划建议，不是已经建立的发布承诺；排期应在确认实际播放器适配成本后估算。

## 附录：本次检查结果

| 检查 | 结果 | 能说明什么 |
|---|---|---|
| `node --check bilibili-caption-blur-mask.user.js` | 通过 | JavaScript 语法有效；不代表浏览器行为正确 |
| impeccable 机械扫描 | `[]` | 未报机械规则问题；存在字符串内 CSS/HTML 的覆盖限制 |
| 旧 GM 数据重复迁移 | 新笔记回退，已删卡片恢复 | F01 的函数行为已复现 |
| 数据库不可用/尚未提交时迁移 | 旧 localStorage 已被清除 | F02 的控制流已复现 |
| 未提交事务调用 `await dbSaveNote` | 提前完成，缓存已更新 | F03 的 Promise 契约错误已复现 |
| 动态文本渲染 | 原样进入 innerHTML | F04 插入点已确认；未验证生产站脚本执行 |
| 跨集点击时间戳 | 当前错误集被 seek 到 42 秒 | F05 已复现 |
| 同容器 A→B 配置切换 | 内部 top=60，显示仍为 84% | F06 已复现 |
| 无播放器 Alt+滚轮 | 三种事件拦截仍执行 | F09 已复现 |
| 长按 S 的 10 次 keydown | 截图调用 10 次 | F10 已复现 |
| 模拟 A/B 查询乱序 | B 页面最终装入 A 缓存 | 已验证防乱序缺失；实际触发概率待实机确认 |
| 按钮前景/背景对比度计算 | 2.540636…:1 | F11 静态色值不满足普通文字 4.5:1 |

本报告中的最小夹具在评审过程中执行，没有作为正式测试套件提交。后续修复应把相关场景改写为断言正确行为的回归测试。
