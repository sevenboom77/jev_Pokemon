# 公开仓库整理说明

本仓库来自 G003「智能先锋」AGNES Arena 交付包。项目目录保留并列的 `pokemon/` 与 `agnes-harness/`，不重构原相对导入路径。

## 发布内容

- 对战工程、固定 AGH 源码、固定 Showdown Client 及原许可直接进入 Git。
- 项目说明、技术文档、评测报告、实录截帧和轻量联赛汇总可直接阅读。
- 完整历史对局与会话以 `AGNES_Arena_history.tar.gz` 发布；完整演示为 `AGNES_Arena_demo.mp4`。长度和 SHA256 见根目录 `release-assets.json`。
- 原 macOS 预构建运行目录、安装依赖、新运行目录、实际账户配置、个人报名联系方式与成员签名声明不进入公开仓库。

## 路径匿名

原运行记录中的私人 home 用户名已替换为 `USER`。完整证据中有 185 个文件进行了 5,492 处路径替换，其他 1,873 个文件保持逐字节不变。发布源码 `pokemon/scripts/agh-env.mjs` 仅匿名两处历史目录；模型选择、战斗规则与执行逻辑未改。

比赛记录、实验数值、模型请求别名、原始代码哈希标识和失败记录保留。历史报告内的原字节哈希描述原实验；路径匿名后的公开字节具有新的哈希，详见 [publication-redactions.json](publication-redactions.json)。原始提取目录没有被覆盖。

## 离线测试打包适配

原 `battle-daemon-recovery.test.mjs` 直接读取未随 Git 发布的预构建 `daemon.mjs`。公开版本保留原运行产物优先；该文件不存在时，改用从原产物逐字提取的 `RemoteSession` 固定片段。三项测试断言不变，源文件与片段 SHA256、许可和用途记录在 `pokemon/tests/fixtures/battle-remote-session.source.json`。这使源码包可以执行原离线检查，不改变真实对局运行方式。

上游测试中的假 token、TLS 测试私钥和 Showdown 示例占位配置属于源码 fixtures，保留其测试用途；不包含实际运行的账户密钥。

## 验证范围

发布整理不重新调用玩家模型或运行付费联赛。README 的 90 场、180 份会话等数字来自原实验记录，当前机器的离线测试单独说明。原联赛的模型排名是固定条件下的有限样本，尚无不带 Jev 的联赛消融结果。

安装和启动以根目录 SOURCE_INSTALL 为准。文档中的原实验平台、固定模型请求映射与历史运行记录不构成所有机器和第三方服务都能直接等价复现的承诺。
