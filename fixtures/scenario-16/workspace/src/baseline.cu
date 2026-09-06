// Synthetic baseline kernel excerpt for the 16-turn fixture.
// Not a real CUDA implementation and not a measured result.

#include <cstdint>

#ifndef BLOCK_M
#define BLOCK_M 64
#endif
#ifndef BLOCK_N
#define BLOCK_N 64
#endif
#ifndef BLOCK_K
#define BLOCK_K 16
#endif

struct PipelineConfig {
	int m;
	int n;
	int k;
	int warmup;
	int samples;
	float smem_fraction;
};

__device__ void load_tile(const float* a, const float* b, float* tile_a, float* tile_b, int k0) {
	const int tx = threadIdx.x;
	const int ty = threadIdx.y;
	tile_a[ty * BLOCK_K + tx % BLOCK_K] = a[k0 + tx];
	tile_b[tx * BLOCK_N + ty] = b[k0 * BLOCK_N + ty];
}

__device__ void mma_tile(float acc[8], const float* tile_a, const float* tile_b) {
	for (int i = 0; i < 8; ++i) {
		acc[i] += tile_a[i] * tile_b[i];
	}
}

// Separate launch for epilogue. This is the baseline's launch overhead.
__global__ void gemm_kernel(const float* a, const float* b, float* c, int m, int n, int k) {
	__shared__ float tile_a[BLOCK_M * BLOCK_K];
	__shared__ float tile_b[BLOCK_K * BLOCK_N];
	float acc[8] = {0, 0, 0, 0, 0, 0, 0, 0};
	for (int k0 = 0; k0 < k; k0 += BLOCK_K) {
		load_tile(a, b, tile_a, tile_b, k0);
		__syncthreads();
		mma_tile(acc, tile_a, tile_b);
		__syncthreads();
	}
	const int out = blockIdx.x * BLOCK_N + threadIdx.x;
	if (out < n) {
		c[out] = acc[0];
	}
}

__global__ void epilogue_kernel(float* c, const float* bias, int n) {
	const int i = blockIdx.x * blockDim.x + threadIdx.x;
	if (i < n) {
		c[i] = c[i] + bias[i];
	}
}

void run_pipeline(const PipelineConfig& cfg, const float* a, const float* b, const float* bias, float* c) {
	(void)cfg;
	(void)a;
	(void)b;
	(void)bias;
	(void)c;
	// Host launch sequence: gemm, then epilogue, then postprocess.
}

// Additional commentary so the fixture carries a realistic source excerpt
// into context when the agent reads this file. The evaluation is an
// accelerated compaction test; this text is source identity, not padding
// without meaning. Reviewers should be able to tell baseline from fused
// candidates by the separate epilogue launch above.
void describe_baseline(char* out, int cap) {
	const char* text =
		"baseline uses two launches; complete-pipeline metric includes both; "
		"shared memory stays near 40 percent; numeric check is ulp2_or_bitwise.";
	int i = 0;
	while (text[i] && i + 1 < cap) {
		out[i] = text[i];
		++i;
	}
	if (cap > 0) {
		out[i] = 0;
	}
}
