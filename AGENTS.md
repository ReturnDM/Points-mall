# 积分商城 · Agent 工作约定

本项目曾于 2026-09-23 移除管家库里的 points-ledger skill；2026-09-24 以**薄指针版**重建（`E:\agent管家\.dsh\skills\points-ledger\`）：skill 只做路由，规则正文始终以本项目实时文件为准，本项目更新规则后管家侧自动生效，无需同步。

## 数据接口

- **数据目录**：环境变量 `POINTS_DATA_DIR` → 项目根 `config.local.json` 的 `dataDir`；都没有就停下让用户配置，不猜路径。真实路径看 `config.local.json`（不入 git）。
- **规则权威文档**：`docs/schema.md`（数据 schema）与 `docs/agent-ledger.md`（Agent 记账规范），冲突时以 schema.md 为准。
- **写账前必读**：`tasks.json`（档位与常见事项分值）、`shop.json`（商品）、`积分规则.md`（专项细则）。

## 记账接口：一律走 CLI，不手动写 JSON

所有增删查改只调 `node scripts/ledger.mjs`（或 `npm run ledger --`），schema 校验 / id 生成 / 原子写 / ref 完整性已固化在脚本里：

```powershell
node scripts/ledger.mjs summary                                  # 余额/等级/背包
node scripts/ledger.mjs list [--limit 20] [--type earn]          # 查流水
node scripts/ledger.mjs earn <title> <points> [--note "..."]     # 记账
node scripts/ledger.mjs adjust --ref <id> [--points Δ] [--exp Δ] [--title ...] [--note ...]
                                                                 # 改账；不带 Δ 则全额冲正
node scripts/ledger.mjs redeem <itemId> [--note "..."]           # 兑换（查 shop.json 定价）
node scripts/ledger.mjs use <redeemId> [--note "..."]            # 核销虚拟券
node scripts/ledger.mjs recycle <redeemId> [--note "..."]        # 回收（返还原实付 80%）
```

## 记账要点（细节以两份 docs 为准）

- **做事即积分**：不限「生产性」事项——学习、工作、家务、运动、爱好、**打游戏达成游戏内目标**等，只要真的做了、达成了目标，就值得记。判断标准是「有没有做事 / 达成目标」，不是「有没有用」。
- 流水是唯一事实来源，余额 / 经验 / 等级全部由流水汇总，不存总数文件；永不删改历史流水，改账只追加 adjust 记录。
- 无固定分值事项：主模型与 Jev 各判一次（`node scripts/ledger.mjs judge "<描述>" --context "..."`，key 自动读 `~/.typesafe-api-key`），差 ≤50% 取平均，>50% 带着双方理由重审计一轮，仍分歧则问用户；Jev 不可用则自行定档并在 note 标注「未经 Jev 复核」。定分只看**当场投入**，注意别把已完成并单独记过的大工程量重复算进去。
- 每次写账后回报：本次积分/经验变动、当前余额（≈¥，汇率读数据目录 config.json，缺省 20 分 = 1 元）、等级与升级进度（第 N→N+1 级需 `100 + 10×(N−1)` 经验）。
- **商城定位**：积分 = 做事记录 + **大额愿望储蓄**（装备等）。吃喝、娱乐充值等日常消费不进商城，仍按现实预算走；商品清单在 shop.json，可随时增删。
- **专项计分规则**：数据目录 `积分规则.md`（与 tasks.json/shop.json 同级，随坚果云同步）——定分前先查这里有没有已定细则；新增专项规则也写到这里。游戏出门已定：出门 20 + 表现分 净涨每点 5。
