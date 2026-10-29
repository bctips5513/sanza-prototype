/// <reference lib="webworker" />
import { calibrate, type CalibInput } from './calibrate';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (ev: MessageEvent<{ id: number; input: CalibInput }>) => {
  const { id, input } = ev.data;
  try {
    ctx.postMessage({ type: 'result', id, result: calibrate(input) });
  } catch (e) {
    ctx.postMessage({ type: 'error', id, message: e instanceof Error ? e.message : String(e) });
  }
};
