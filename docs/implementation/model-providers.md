# 模型提供方候选

2026-10-22（北京时间），用户暂定聊天/记忆提取使用 DeepSeek，向量使用阿里百炼。尚未确认具体模型、百炼地域/业务空间或API密钥；以下是接入准备，不是已验证配置。

## 职责与配置

聊天/记忆提取和向量分别设置 baseURL、apiKey、model。每个索引版本另外固定向量维度和预处理版本。第三方调用仍须先经过服务端允许范围筛选。

DeepSeek [官方首次调用文档](https://api-docs.deepseek.com/) 说明支持 OpenAI-compatible 接口，baseURL 为 `https://api.deepseek.com`；本次页面示例模型为 `deepseek-flash`、`deepseek-v4-pro`。不把旧模型别名写死为默认，真实可用型号由账号和实时服务验证。

阿里百炼 [OpenAI Embedding兼容文档](https://help.aliyun.com/zh/model-studio/embedding-interfaces-compatible-with-openai) 按业务空间/地域提供端点，原有 DashScope 域名目前仍可用。`text-embedding-v4` 是可测试候选，支持多档维度，官方示例为1024维、`encoding_format=float`。实际索引维度必须显式匹配所选模型返回值，不能沿用测试fixture维度。

## 接入验证门禁

- 必须核查锁定Mem0适配器真实发出的模型名、维度、编码格式与baseURL；只给PG表设置dimension并不等于供应商收到了对应dimensions参数。
- 必须实测非空中文embedding、向量长度、JSON提取输出、超时/错误和费用界限。
- 第三方API密钥仅通过环境秘密配置注入；不写入文档、Git、记忆或公开日志。
- 尚未配置密钥时仅运行本地协议fixture，live-api明确标为未验证。

环境变量名见 `packages/compatibility/src/config.ts`；协议验证、显式live-api与重启后只读验证的运行方法见 [兼容性包README](../../packages/compatibility/README.md)。当前已有统一CLI，但尚未运行真实提供商验证。
