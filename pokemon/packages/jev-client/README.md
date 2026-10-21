# Jev HTTP 客户端

本项目通过 `decide` 调用 `POST https://api.typesafe.ai/v1/systemone`，固定模型 `jev-1.13.0`。
请求提供 state 和 Choice 问题中的合法候选；返回选项、分布、集中度与用量。
API key 从服务环境读取，不写入返回值或记录。客户端校验候选及返回结构，并区分认证、超时和暂时性失败。

`offlineDecider` 保留给受控测试使用，真实带 Jev 对局调用实际接口并保存回执。
运行客户端测试：`npm run jev:test`。系统集成见提交目录的技术文档。
