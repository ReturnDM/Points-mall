# 积分商城 · 生活游戏化系统

纯静态只读前端：网页渲染积分 / 等级 / 商城 / 背包 / 流水；**所有写入由 Agent 对话完成**，无后端、无常驻进程。

数据格式与记账规范见 [docs/schema.md](docs/schema.md) 和 [docs/agent-ledger.md](docs/agent-ledger.md)；个人计分细则保存在数据目录的 `积分规则.md`。

## DSH 对话记账（推荐）

配套插件 [dsh-points-mall](https://github.com/ReturnDM/dsh-points-mall) 已有第一版（v0.1.0，首版适配 DSH Desktop 0.2.0-rc.2）：侧栏显示余额、等级、升级进度和今日累计积分，当前对话可完成记账、查询、更正、兑换、核销与回收。

1. 在 DSH 插件管理页面安装 `github:ReturnDM/dsh-points-mall`，并启用插件。
2. 点击侧栏的「设置积分账本」，选择「连接已有账本」，指向本项目正在使用的数据目录（包含 `ledger/`、`tasks.json`、`shop.json` 和 `积分规则.md`）。没有账本时也可选择「新建账本」。
3. 在对话中说「我完成了半小时阅读，按积分规则记一笔」或「查看我的积分和最近十笔流水」。插件自带 `points-mall` 技能，无需另行复制旧的 `points-ledger` skill。

插件与本网页使用同一份账本，不需要导入或复制流水。插件负责对话操作与侧栏概览；本网页提供完整的商城、背包和流水展示；CLI 保留为插件不可用或其他 Agent 环境下的兜底入口。插件的数据目录在 DSH 设置中选择，网页仍需在浏览器中授权同一目录，CLI 的目录配置见下文。

首次设置不需要 Jev key；Jev 复核可在插件设置中另外启用。详细安装、版本兼容与插件配置以 [插件 README](https://github.com/ReturnDM/dsh-points-mall#readme) 为准。

## 快速开始

```powershell
npm install
npm run init-data     # 初始化数据目录（读 POINTS_DATA_DIR 或 config.local.json）
npm run build         # 产出 dist/（tsc 类型检查 + vite 构建）
npm run preview       # 本地静态服务打开 http://localhost:4173
```

1. 浏览器（Edge / Chrome）打开页面，点「选择数据目录」，只读授权坚果云同步目录；
2. 授权会记住（IndexedDB），重开时如失效再点一次重新授权。

首次初始化只复制 `tasks.json` 和 `shop.json` 模板，并创建空 `ledger/`，起始余额为 0。再次运行不会覆盖已有数据。

## 数据目录配置（本项目 CLI 与初始化脚本）

优先级：环境变量 `POINTS_DATA_DIR` → 项目根 `config.local.json`（`{ "dataDir": "..." }`，不入 git）→ 提示配置。代码不硬编码任何绝对路径。

## 目录结构

```
src/
  lib/types.ts     # 数据 schema 类型
  lib/ledger.ts    # 流水汇总：余额 / 经验 / 等级 / 背包 / 汇率换算
  lib/fsdata.ts    # File System Access API 只读数据目录
  ui.tsx           # 手绘风基础组件（Card / WobblyButton / StickyTag）
  App.tsx          # 仪表盘 / 价目表 / 商城 / 背包 / 流水
seed/              # 价目表和商品模板（不含示例流水）
docs/              # schema 定稿 + Agent 记账规范
scripts/
  init-data.mjs     # 初始化数据目录
  ledger.mjs        # 记账 CLI（插件不可用时的兜底入口）
```

## 记账接口

DSH 中优先使用插件的 `points_mall_*` 工具，读取当前账本规则与流水后执行操作；插件不可用时调用 `node scripts/ledger.mjs`。两种入口都负责 schema 校验、id 生成、原子写与 ref 完整性检查，Agent 不直接写流水 JSON，改账只追加更正记录。

计分流程与回报要求见 [AGENTS.md](AGENTS.md) 和 [docs/agent-ledger.md](docs/agent-ledger.md)，专项细则以当前数据目录的 `积分规则.md` 为准。

## 视觉规范

手绘涂鸦风（Hand-Drawn design system）：wobbly 歪边框、纸张点纹背景、硬偏移阴影、
胶带 / 图钉装饰、硬纸板按压交互；中文用霞鹜文楷（CDN），西文 Kalam / Patrick Hand。

## 路线

- [x] 静态只读前端 + 数据 schema + 汇总计算
- [x] 手绘风 UI
- [x] 记账 CLI（`scripts/ledger.mjs`：summary / list / earn / adjust / redeem / use / recycle）
- [x] 配套 DSH 插件第一版：侧栏积分卡片、对话记账、新建或连接已有账本
- [ ] Jev 评分实际接入调优（跑一段时间校准 50% 阈值）
