# Gtask 0.1.0-rc.17

- 所有游戏和版块统一使用 `requestContext.outputLocale` 与 `requestContext.userTimeZone` 提出数据需求。
- 公开资料与个人进度提交必须回传 `contentLocale`，工具只机械核对其与契约一致。
- Codex 被明确声明为增删改与业务语义决策方；MCP 和数据库只执行类型、身份、事务、授权范围及手动数据保护。
- 移除标题必须含中文等字符集决策规则，英语及后续语言可复用同一接口。
- 活动标签规范化改为按请求语言执行。
