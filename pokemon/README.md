> 公开仓库的完整安装与服务配置见 [SOURCE_INSTALL.md](../SOURCE_INSTALL.md)。以下保留原工程说明。

# AGNES Arena 源码

当前实现为电子游戏对战：技能、属性克制、状态与换人。
AGH 原生插件连接规则服务；模型在一次整局任务中自行执行，双方记录与结果独立保留。

安装：`npm ci --ignore-scripts`。
构建：`npm run battle:build`。
无付费测试：`npm run battle:test`、`npm run jev:test`。
新比赛：填写 `.env.example` 后执行 `npm run battle:live`，会调用自己的模型与 Jev 服务。

完整说明见 [复现说明](../../01-说明文档/02-复现说明.md) 与 [技术文档](../../01-说明文档/03-技术文档.md)。
框架源码在相邻 `agnes-harness/`；比赛所用 macOS 代码运行时随附，不含玩家账号或密钥。
