# Fork development

- This fork builds on yunxi001/GenshinCultivationPlanner. The current task adds live Training Guide reading and material-target mapping to its existing planning and execution flow. Keep upstream execution policy unchanged initially; behavior tuning is a separate step.
- Preserve the separate bettergi-growth-planner repository and its deployed daily workflow. Do not migrate its executor, resin ledger or scheduler into this fork.
- Use lower-cost sol medium/high agents for bounded implementation and review. Use `followup_task` to restart an idle native agent; `send_message` does not restart it. Keep file ownership and any VM operator in local STATUS.md.
- Re-read enabled Training Guide characters and targets each run. Missing, ambiguous, stale or incomplete recognition must not become zero demand. Map desired guide levels to the upstream profile target builder, using verified current progress and talent bonuses; let upstream compute complete material costs and subtract inventory. Do not substitute the sparse visible-popup shortage list for a full cultivation target.
- Do not create new test files for this task. Run existing upstream checks and disposable local replay checks; distinguish local verification from a real BetterGI run.
- Do not add resin refills, automatic crafting or character upgrades. The existing user authorization permits an isolated native guide-preview check with no spending; keep the deployed nightly workflow and timers unchanged. Only the operator recorded in STATUS.md may access the VM, and temporary guide changes must be recorded and restored.
- Use gh for GitHub access. Work on feature branches, keep evidence and development state out of commits, and do not force-add ignored docs.
