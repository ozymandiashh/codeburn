# GLM-5.3 spend tier browser proof

Code commit: `1e4b1b19c88d08ac81fa053d3b913037941decbe`. Baseline: `986d72ce1efbfaf40b3c9d4050d9ecdbc24be986`.

Before and after screenshots render the actual CodeBurn `StackedBars` and `Panel`
components with the production CSS in headless Chromium. The controlled fixture
replays the model names and rounded per-model costs from the reported Sep 29
screenshot; it does not contain session transcripts, project paths, or account data.

GLM-5.3 stays at $33.90; GLM-5.3-Flash stays at $57.31. Bar heights and the other
models' colors remain the same. The two GLM bars and tooltip swatches change from
Other to Flagship and Fast, and the legend follows the same classification.

The screenshot's daily total is $526.65; the displayed model rows sum to $526.64
because these fixture inputs are the individually rounded displayed values.

The JSON files capture DOM classes, computed browser colors, tooltip costs,
segment heights, legend text, and browser errors (none).
