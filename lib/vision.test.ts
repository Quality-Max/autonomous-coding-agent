import { describe, it, expect } from 'vitest';
import {
  isMultimodalModel,
  estimateCostUsd,
  extractTestCode,
  decodeImageInput,
  tokensPerSecond,
} from './vision';

describe('isMultimodalModel — only image-capable models see the screenshot', () => {
  it('treats gemma-4 variants as multimodal', () => {
    expect(isMultimodalModel('gemma-4-31b')).toBe(true);
    expect(isMultimodalModel('gemma-4-9b')).toBe(true);
  });
  it('treats text-only Cerebras models as non-multimodal', () => {
    expect(isMultimodalModel('gpt-oss-120b')).toBe(false);
    expect(isMultimodalModel('zai-glm-4.7')).toBe(false);
  });
});

describe('decodeImageInput — accepts raw base64 and data URIs', () => {
  it('passes raw base64 through with a default media type', () => {
    expect(decodeImageInput('aGVsbG8=')).toEqual({ base64: 'aGVsbG8=', mediaType: 'image/png' });
  });
  it('splits a data URI into payload + media type', () => {
    expect(decodeImageInput('data:image/jpeg;base64,/9j/4AAQ')).toEqual({
      base64: '/9j/4AAQ',
      mediaType: 'image/jpeg',
    });
  });
  it('trims surrounding whitespace', () => {
    expect(decodeImageInput('  aGk=  ').base64).toBe('aGk=');
  });
});

describe('extractTestCode — strips markdown fences the model sometimes adds', () => {
  it('returns plain code unchanged', () => {
    expect(extractTestCode("import { test } from '@playwright/test';")).toBe(
      "import { test } from '@playwright/test';",
    );
  });
  it('unwraps a fenced block with a language tag', () => {
    expect(extractTestCode('```ts\nconst a = 1;\n```')).toBe('const a = 1;');
  });
  it('unwraps a fenced block without a language tag', () => {
    expect(extractTestCode('```\nconst b = 2;\n```')).toBe('const b = 2;');
  });
});

describe('estimateCostUsd — best-effort Cerebras pricing', () => {
  it('is zero for zero tokens', () => {
    expect(estimateCostUsd('gpt-oss-120b', 0, 0)).toBe(0);
  });
  it('grows with output tokens and stays a small positive number', () => {
    const cost = estimateCostUsd('gpt-oss-120b', 1000, 1000);
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeLessThan(0.01);
  });
  it('falls back to a default rate for an unknown model', () => {
    expect(estimateCostUsd('some-future-model', 1_000_000, 1_000_000)).toBeCloseTo(0.9, 5);
  });
});

describe('tokensPerSecond — throughput for the speed panel', () => {
  it('computes tokens per second from elapsed ms', () => {
    expect(tokensPerSecond(1000, 1000)).toBe(1000);
    expect(tokensPerSecond(500, 250)).toBe(2000);
  });
  it('never divides by zero', () => {
    expect(Number.isFinite(tokensPerSecond(10, 0))).toBe(true);
  });
});
