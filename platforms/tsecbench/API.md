# tsecbench 平台 API 知识（2026-09，两场实战验证）

> 平台：智能攻防 AI 跑分基准（https://tsecbench.zc.tencent.com/）。

## 两类 token（易混，实战教训）

| token | 形态 | 用途 | 来源 |
|---|---|---|---|
| 会话 Bearer | JWT（`eyJ...`，sub=用户 id，exp=会话过期） | 前端 API（/api/v1/*，如建 run/查状态/finish/排行榜） | 平台页面登录后 localStorage.token |
| BENCHMARK_TOKEN | UUID（36 字符，**≤64 上限**） | 靶场 OpenAPI（/openapi/v1/challenges*，请求头 `BENCHMARK_TOKEN`） | 建 run 后由状态接口下发（每 run 独立） |

- 用错会直接 422（BENCHMARK_TOKEN 长度校验）或 404 task_not_found。
- 会话 token 有 exp；run 有时限（本集 21600s=6h，从首次 OpenAPI 调用起算，
  run 创建后有 ~10 分钟"接入窗口"（pending_remain_seconds），期间无调用即接入超时）。

## run 生命周期（前端 API）

1. `GET /api/v1/my/agents` → agent_id（无则 `POST /api/v1/my/agents` 建）。
2. `POST /api/v1/runs`，body `{set_id, agent_id, run_mode:"full", run_source:"local", base_model?, remark?}` → `{run_id, token}`。
   - 已有 active run 时创建报错，错误 JSON 含 `active_run_id`（一次只能一场）。
3. `GET /api/v1/runs/{id}/status` → `token`(BENCHMARK_TOKEN)、`vpn_config`(ovpn 全文)、
   `pending_remain_seconds`、`elapsed_seconds`、`current_score`。
4. `POST /api/v1/runs/{id}/finish` → 停表（**排名按 score_elapsed_seconds：同分比谁先拿到最终分，
   所以打完立刻 finish，别等 6h 超时**）。
5. `GET /api/v1/leaderboard?set_id=5` → entries 含 final_score/final_flags/elapsed_seconds/
   score_elapsed_seconds/base_model/token_usage。

## 靶场 OpenAPI（BENCHMARK_TOKEN 鉴权）

标准流程：`GET /challenges`（列题+进度）→ `POST /challenges/start?unique_code=`（开容器，
**同时最多 3 个容器**，超限 409 invalid_state）→ `GET /challenges/hint?unique_code=`
（**查后该题 flag 得分按 hint_cost_radio 扣，本集实测 10%/次**；已通关题不可再查）→
`POST /challenges/submit`（body `{unique_code, flag}`；重复正确提交返回 409 duplicate，
幂等；响应 `{correct, awarded, cumulative_score, correct_flag_count, total_flag_count, matched_flag_index}`）→
`POST /challenges/close?unique_code=`（释放容器，务必关）。

题目条目：`unique_code / description / difficulty / level / total_score / flag_count /
correct_flag_count / is_completed / container_status / container_addr`。
- container_status：pending（启动中）/available（就绪，addr 有值）/stopped。
- 完成口径以 `is_completed` 为准（score_events 有滞后）。

## 错误码

- 404 `task_not_found`（token 无效）、404 `challenge_not_found`、409 `invalid_state`
  （任务结束/容器超限）、409 `duplicate`、503 `resource_unavailable`、500 `internal_error`；
- 供应商侧：智谱 `1113 余额不足或无可用资源包`（第一场 hard 全灭的根因——**开跑前先探
  各供应商余额**；Kimi `GET /v1/users/me/balance`、DeepSeek `GET /user/balance`，智谱无公开接口）。

## VPN

- 每 run 下发独立 ovpn（状态接口 vpn_config 字段）；`sudo openvpn --config <file> --daemon`。
- 健康预检：`http://10.0.100.58` → `{"status":"ok"}`（未连则靶场地址不可达）。

## 题集（set 5 "Cybench"）

- 40 题，20800 分；难度分布易 9 / 中 20 / 难 11（难 700-1000 分/题）。
- 每题以 `g-<两位序号>` 为 unique_code；多数单 flag，少数多 flag。
