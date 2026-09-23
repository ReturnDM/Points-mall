# 积分商城 · 生活游戏化系统

纯静态只读前端：网页渲染积分 / 等级 / 商城 / 背包 / 流水；**所有写入由 Agent 对话完成**，无后端、无常驻进程。

玩法与规则见 `docs/schema.md`（数据 schema 定稿）与 `docs/agent-ledger.md`（Agent 记账规范）。

## 快速开始

```powershell
npm install
npm run init-data     # 初始化数据目录（读 POINTS_DATA_DIR 或 config.local.json）
npm run build         # 产出 dist/（tsc 类型检查 + vite 构建）
npm run preview       # 本地静态服务打开 http://localhost:4173
```

1. 浏览器（Edge / Chrome）打开页面，点「选择数据目录」，只读授权坚果云同步目录；
2. 授权会记住（IndexedDB），重开时如失效再点一次重新授权；
3. 快速看效果：打开 `/?demo`（内置示例数据，无需授权）。

## 数据目录配置（Agent 写账用）

优先级：环境变量 `POINTS_DATA_DIR` → 项目根 `config.local.json`（`{ "dataDir": "..." }`，不入 git）→ 提示配置。代码不硬编码任何绝对路径。

## 目录结构

```
src/
  lib/types.ts     # 数据 schema 类型
  lib/ledger.ts    # 流水汇总：余额 / 经验 / 等级 / 背包 / 汇率换算
  lib/fsdata.ts    # File System Access API 只读数据目录
  lib/demo.ts      # ?demo 演示模式
  ui.tsx           # 手绘风基础组件（Card / WobblyButton / StickyTag）
  App.tsx          # 仪表盘 / 价目表 / 商城 / 背包 / 流水
public/demo/       # 演示数据
seed/              # 数据目录初始模板（init-data 拷贝用）
docs/              # schema 定稿 + Agent 记账规范
scripts/init-data.mjs
```

## 视觉规范

手绘涂鸦风（Hand-Drawn design system）：wobbly 歪边框、纸张点纹背景、硬偏移阴影、
胶带 / 图钉装饰、硬纸板按压交互；中文用霞鹜文楷（CDN），西文 Kalam / Patrick Hand。

## 路线

- [x] 静态只读前端 + 数据 schema + 汇总计算
- [x] 手绘风 UI
- [x] 记账 Skill（`points-ledger`，项目级 `.dsh/skills/`，意图分流 + Jev/模型双判，差 >50% 重审计）
- [ ] Jev 评分实际接入调优（跑一段时间校准 50% 阈值）
