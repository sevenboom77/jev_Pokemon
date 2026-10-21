# 联赛结果与历史记录

`summary/` 保存原 90 场有效比赛、180 份有效会话、费用计算依据和核验结果的轻量 JSON/CSV。模型胜负与计分口径见 [评测报告](../docs/04-评测报告.md)。

完整历史记录作为 [v0.1.0 下载附件](https://github.com/sevenboom77/jev_Pokemon/releases/tag/v0.1.0) 提供，保留 282 次尝试及对应的失败、重试与会话记录。获取并校验：

```bash
python3 scripts/fetch_release_assets.py --history
```

恢复到 `evidence/history/` 后，打开其中的 `阅读索引.md`，按相对链接查看比赛、原生事件和会话阅读稿。这些是历史实验记录，不会自动发起新比赛。

公开副本只匿名私人 home 用户名，比赛及模型请求信息保留，见 [发布整理说明](../docs/PUBLICATION_NOTES.md)。
