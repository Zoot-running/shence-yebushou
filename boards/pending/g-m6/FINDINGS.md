# g-m6 战报板 (mock base64 送分题)

- [g-m6|w1|deepseek-v4-flash] w1 CLI 路线开工：板目录初始不存在，已创建 FINDINGS.md。无 w2 进展可读。
- [g-m6|w1|deepseek-v4-flash] `printf '%s' 'bW9ja3tsb2M0bF9kcnlydW5fMDZ9' | base64 -d` = `mock{loc4l_dryrun_06}`
- [g-m6|w1|deepseek-v4-flash] 字节级质检：21 bytes，hex 6d6f636b7b6c6f63346c5f64727972756e5f30367d，无尾随换行(0x0a)、无空白、纯可打印 ASCII (grep -P '^[\x20-\x7e]+$' 通过)。
- [g-m6|w1|deepseek-v4-flash] 提交口径：原文已含 mock{...} 包裹，按“解码原文逐字”提交，不再套 flag{} 外壳。FLAG_CANDIDATE: mock{loc4l_dryrun_06}
# g-m6 FINDINGS (append-only)
- [g-m6|w2|deepseek-v4-flash] 开工: 板不存在, 已创建并播种. w1 尚未落任何结论; 本路为 python 路线独立复核.
- [g-m6|w2|deepseek-v4-flash] python3 解码: bW9ja3tsb2M0bF9kcnlydW5fMDZ9 -> mock{loc4l_dryrun_06} (repr 无尾部/换行, 21 bytes).
- [g-m6|w2|deepseek-v4-flash] 往返证明: base64.b64encode(raw).decode() == 原串 逐字相等 (True); base64.b64decode(validate=True) 严格通过; len(b64)=28, len(raw)=21, padding=0 -> 无 padding 误读/无数据丢失.
- [g-m6|w2|deepseek-v4-flash] 独立 CLI 交叉验证 (w1 路线由本路重跑): printf '%s' <b64> | base64 -d -> mock{loc4l_dryrun_06}; xxd 确认 21 字节且以 0x7d('}') 结尾, 无尾随换行/垃圾字节. CLI 与 python 两路逐字一致.
- [g-m6|w2|deepseek-v4-flash] 口径: 解码原文本身即 mock{...} 包裹. 依任务 #3 与 g-m1 先例, 以解码原文逐字为准, 不再套 flag{} 外壳. FLAG_CANDIDATE: mock{loc4l_dryrun_06}
- [g-m6|w2|deepseek-v4-flash|FORKS] xiaochang_fork 未注册(本 build 预期无), 未能调用; 本题无真实分叉. 候选口径分歧(是否套 flag{} 外壳)按任务#3与 g-m1 先例判定, 无需 needs.
