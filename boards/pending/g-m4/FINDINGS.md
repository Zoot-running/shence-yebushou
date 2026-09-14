# g-m4 FINDINGS
- [subagent] echo 'bW9ja3tsb2M0bF9kcnlydW5fMDR9' | base64 -d => mock{loc4l_dryrun_04}
- [subagent] python3 base64.b64decode 复核一致 => mock{loc4l_dryrun_04}
- [subagent] 解码原文已自带 mock{} 包裹，按指派口径逐字提交，不再套 flag{}。
