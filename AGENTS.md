# Project memory

- tcode UI 版式演进:spec 文档分层,session 恢复/继续用 `--continueLatest`/`--resumeId`,命令用 `/`(slash)。§17(终端设计系统)已实施:全线改用 2 列轨道(rail/GUTTER_WIDTH),轮次标题 `turnHeading` 带序号+时间右对齐,输入框从 box 改 rail,palette 分主色(紫)/副色(青)且背景微染只上 truecolor。硬约束:不进 alternate screen,scrollback 是审计记录,非 TTY 退化成 ASCII。build=`npm run build`,test=`npm test`(403 全绿)。
