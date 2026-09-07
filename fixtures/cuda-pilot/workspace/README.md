# CUDA artifact-replay workspace

Replayed profiling artifacts for the M3 bounded optimization question.
Not captured on this machine. Not a live GPU run. Not a CUDA speedup result.

The runner only reads `runs/*/manifest.json`, `result.json`, and `ncu.json`.
It must not invoke `nvcc`, `ncu`, or any GPU binary.
