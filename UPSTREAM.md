# 上游来源与固定版本

## Agnes Harness

`agnes-harness/` 保留原交付的工作树源码。其 [SOURCE-SNAPSHOT.json](agnes-harness/SOURCE-SNAPSHOT.json) 记录来源及文件哈希，上游为 [AgnesAI-Labs/agnes-harness](https://github.com/AgnesAI-Labs/agnes-harness)，记录的基线提交为 `5da40731214976ad8aff982cd5626d3a676fdd88`。原本地适配见 [WORKTREE.patch](agnes-harness/WORKTREE.patch)。

保留 [LICENSE](agnes-harness/LICENSE)、[NOTICE](agnes-harness/NOTICE) 以及各组件许可。原对局运行环境的预构建目录不进入公开 Git，用户应从该固定源码构建本机版本。

## Pokémon Showdown

规则引擎由 `pokemon-showdown@0.11.10` 提供，版本锁定在 `pokemon/package-lock.json`。动画客户端直接保留 [smogon/pokemon-showdown-client](https://github.com/smogon/pokemon-showdown-client) 的固定源码，revision 为 `c0f6bfc707a5e3bba4da3785e9cb06c8ae04f8d9`，见 [SOURCE-REVISION.json](pokemon/vendor/showdown-client/SOURCE-REVISION.json) 与 [LICENSE](pokemon/vendor/showdown-client/LICENSE)。

Pokémon 名称、角色与素材的权利归各自权利人。本仓库不为第三方游戏素材授予新的许可。

## Jev 与玩家模型

Jev `jev-1.13.0` 经 TypeSafe AI API 提供候选建议，最终动作由玩家模型选择。AGNES、网关与 Jev 使用用户自己的账户授权。原十模型请求配置见 `pokemon/models.example.json`，实验请求别名与通用能力结论应分开理解。

对战项目与工具保留交付包的来源及 AI 辅助开发记录。本次发布没有新增覆盖全部代码、游戏素材、数据和服务的统一许可证。
