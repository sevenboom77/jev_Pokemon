# AGNES Arena 安装与复现

本仓库保留并列的 `pokemon/` 与 `agnes-harness/`，以维持原源码的相对导入路径。请从仓库根目录开始。原比赛与交付验证平台为 macOS，要求 Node.js **24.10 至 24.x**，AGH 工作区使用 pnpm **10.34.5**；主对战工程使用 npm 锁文件。

## 1 最小离线验证

只需要匹配版本的 Node.js，不调用模型或 Jev 服务，也不要求 GPU：

```bash
cd pokemon
npm run jev:test
```

## 2 安装依赖与构建动画

以下命令从仓库根目录开始。完整对战测试还会导入 AGH 安装后的依赖，因此先安装 AGH，再安装对战工程：

```bash
ARENA_ROOT="$(pwd -P)"
cd "$ARENA_ROOT/agnes-harness"
pnpm install --frozen-lockfile
cd "$ARENA_ROOT/pokemon"
npm ci --ignore-scripts
npm run battle:build
npm run battle:test
npm run jev:test
```

构建使用 `pokemon/vendor/showdown-client/` 的固定源码。测试以规则引擎与受控本地响应验证行为，不启动付费比赛。原平台和当前机器的验证结果应分别看待；新平台的完整会话初始化与实时比赛仍需单独核对。

## 3 构建当前平台 AGH

保持上一节的 `ARENA_ROOT` 为仓库绝对路径：

```bash
cd "$ARENA_ROOT/agnes-harness"
pnpm --filter @agnes/cli build:local
export AGH_AGNES="$ARENA_ROOT/agnes-harness/packages/cli/dist/local/agnes.mjs"
node "$AGH_AGNES" --help
cd "$ARENA_ROOT/pokemon"
cp .env.example .env
```

必须显式设置 `AGH_AGNES` 为本机新构建产物。公开版本保留了历史回退配置，但其中私人目录已经匿名，不能直接当成本机路径。

原预构建 `.runtime/` 属于原实验环境，不随 Git 发布。源码仍包含原 macOS 初始化与传输适配，完整 Windows 原生运行尚未验证；Windows 可以先运行离线客户端测试与构建。

## 4 配置自己的服务

在本机 `.env` 中填写自己的 AGNES 接口、模型网关和 `TYPESAFE_API_KEY`。模板只包含占位值，实际配置、玩家 profile 和新运行记录不应提交。

- Jev 请求名为 `jev-1.13.0`，通过 TypeSafe AI API 提供结构化候选建议。
- `pokemon/models.example.json` 保留原实验的十模型请求映射，使用时需要自己的服务支持对应别名。
- 模型由服务端运行，本地主要运行规则引擎、AGH、工具和页面，不需要本地部署大模型权重。

## 5 启动单场实时对战

以下步骤会使用自己的玩家模型与 Jev 额度。先在 `pokemon/` 目录启动：

```bash
npm run battle:build
npm run battle:live
```

然后在同目录另外打开两个终端，分别执行：

```bash
node --env-file=.env scripts/battle-web.mjs A
```

```bash
node --env-file=.env scripts/battle-web.mjs B
```

使用随附 `.env.example` 时，对战入口为 `http://127.0.0.1:18795/`，A/B 工作台为 18781、18782。端口由配置决定；代码未配置时的默认值另为 8795、4181、4182。新比赛写入 `pokemon/runs/`。

`battle:serve` 同样会准备真实玩家，不是免配置静态展示入口。观看已有演示请使用 README 视频链接。单场入口不会自动发起原 90 场联赛。

## 6 下载历史证据与视频

下载工具只使用 Python 3 标准库，先校验文件大小与 SHA256；历史归档拒绝越界路径与链接，现有目标不会被覆盖：

```bash
python3 scripts/fetch_release_assets.py --history
python3 scripts/fetch_release_assets.py --video
```

完整证据恢复到 `evidence/history/`，视频保存到 `media/AGNES_Arena_demo.mp4`。索引、90 场有效比赛、180 份会话和全部尝试均保留。轻量汇总先见 `evidence/summary/`。公开路径脱敏范围与原实验记录的区别见 [docs/PUBLICATION_NOTES.md](docs/PUBLICATION_NOTES.md)。
