/// <reference lib="webworker" />
import { autoAlign, type AutoAlignInput } from './autoAlign';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (ev: MessageEvent<{ id: number; input: AutoAlignInput }>) => {
  const { id, input } = ev.data;
  try {
    const result = autoAlign(input, (done, total) => ctx.postMessage({ type: 'progress', id, done, total }));
    ctx.postMessage({ type: 'result', id, result });
  } catch (e) {
    ctx.postMessage({ type: 'error', id, message: e instanceof Error ? e.message : String(e) });
  }
};
