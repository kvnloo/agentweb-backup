## ENG-2778: Force final synthesis at the Agent Mode step cap (2026-11-02)

The 40th Agent Mode step is now a forced synthesis (like the ENG-907 wall-clock path): tool calls are discarded and the model writes its own partial answer instead of the canned step-limit apology. maxIterations unchanged.
