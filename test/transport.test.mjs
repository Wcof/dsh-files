import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { readRequestBody } from '../src/adapters/adapter.js';
import { ErrorCode } from '../src/index.js';

test('HTTP body limits apply to parsed bodies and streaming bodies', async () => {
  await assert.rejects(readRequestBody({ body: '123456' }, 5), { code: ErrorCode.INVALID_REQUEST });
  const input = new PassThrough();
  const body = readRequestBody(input, 5);
  input.write(Buffer.from('123456'));
  input.end(Buffer.from('789'));
  await assert.rejects(body, { code: ErrorCode.INVALID_REQUEST });
});

test('HTTP request abort rejects instead of leaving a pending body read', async () => {
  const input = new PassThrough();
  const body = readRequestBody(input);
  input.emit('aborted');
  await assert.rejects(body, { code: ErrorCode.CANCELLED });
  input.destroy();
});
