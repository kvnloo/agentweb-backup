## ENG-2939: coding_agent iteration-limit stops say edits are saved and to continue (2026-11-11)

- When coding_agent hits its iteration limit after editing files, its result now says the edits are saved on the draft branch and tells the parent to continue with only the remaining work instead of re-running the whole task. Result carries `terminationReason: 'iteration_limit'`. Still a failure (invalid_output); no persistence change.
