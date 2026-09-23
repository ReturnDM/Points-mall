# Agent 记账规范（最简对话记账路径）

> 已实现为 DSH 项目级 Skill：`.dsh/skills/points-ledger/SKILL.md`。
> 写入走本地 CLI `scripts/ledger.mjs`（summary / list / earn / adjust / redeem / use / recycle），
> schema 校验、id 生成、tmp+改名原子写、ref 完整性检查都在 CLI 内固化，Agent 不直接写 JSON。

日常使用 = 跟 Agent 说一句话（「刷了牙」「今天作业很多」），Agent 定档写账并回报。

## 1. 定位数据目录

按顺序解析，不硬编码绝对路径：

1. 环境变量 `POINTS_DATA_DIR`；
2. 项目根目录 `config.local.json` 的 `dataDir` 字段（不入 git）；
3. 都没有 → 提示用户配置（Windows 参考如 `D:\Nutstore\积分商城数据`，按实际坚果云同步位置配置）。

## 2. 意图分流

| 用户意图 | 动作 | 写入 |
|---|---|---|
| 记账 / 补记（「刷了牙」） | 定分 → `earn` | points=+分值，exp=+分值 |
| 改账 / 撤销（「刚才那条记错了」） | 找到原记录 → `adjust` | 按差额或全额冲正 points/exp，`ref` 指向原记录 |
| 兑换实物（「换杯奶茶」） | 查 shop.json → `redeem_physical` | points=−⌈yuan×20⌉，记 `rate: 20` |
| 兑换虚拟券（「买张赖床券」） | `redeem_voucher` | points=−定价，券入背包 |
| 核销（「用掉赖床券」） | `use_voucher` | points=0，`ref`=兑换记录 |
| 回收（「赖床券退了吧」） | `recycle_voucher` | points=+⌊实付×0.8⌋，`ref`=兑换记录 |

## 3. 定分规则（灵活档位制 + Jev 复核）

- **常见重复事项**：`tasks.json` 固定分值直接用（刷牙 5、上课 10…），不做二次判断。
- **其他事项**：不强制套档位，按实际工作量灵活定分；档位表只作锚点参考。
- **Jev + 模型共同判断**：主模型初判 + Jev 独立建议；相差 ≤50%（以较小者为分母）→ 取平均；相差 >50% → 双方带着对方理由**重新审计**一轮，仍 >50% 则停下问用户。
- Jev 不可用时主模型自行定档，`note` 标注「未经 Jev 复核」。
- `note` 必写定分理由 / 工作量。

## 4. 写入规则

- 每笔一个 JSON：`<数据目录>/ledger/<YYYY-MM>/<id>.json`，id 形如 `YYYYMMDD-HHmmss-xxxx`。
- **先写 `<id>.json.tmp`，再改名**为 `<id>.json`（原子提交）。
- 校验同步：切电脑先等坚果云同步完成再写账（可对比最新流水的 `time` 是否异常陈旧）。
- 改账不覆盖历史，只追加 `adjust` 记录。

## 5. 回报格式（示例）

> ✅ 记账成功：刷牙 +5 分（+5 经验）
> 当前余额 1,240 分 ≈ ¥62 · Lv.6（还差 42 经验升级）

## 6. 尚未实现

- Jev 评分的实际接入调优（skill 已含分流逻辑，待跑一段时间校准 50% 阈值）。
