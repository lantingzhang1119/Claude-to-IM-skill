import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const BRIDGE_PATH = path.resolve('scripts/matlab-bridge.sh');

function runBridge(args: string[], env: Record<string, string>) {
  return spawnSync(BRIDGE_PATH, args, {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  });
}

describe('matlab-bridge.sh', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-matlab-bridge-'));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('prints configured MATLAB binary path', () => {
    const result = runBridge(['which'], {
      CTI_MATLAB_BIN: '/bin/echo',
      CTI_MATLAB_ALLOWED_ROOTS: tempRoot,
    });

    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), '/bin/echo');
  });

  it('builds run-script batch invocation for allowed script', () => {
    const scriptPath = path.join(tempRoot, 'driver_script.m');
    fs.writeFileSync(scriptPath, "disp('OK');\n");

    const result = runBridge(['run-script', scriptPath], {
      CTI_MATLAB_BIN: '/bin/echo',
      CTI_MATLAB_ALLOWED_ROOTS: tempRoot,
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /-batch run\('.*driver_script\.m'\);/);
  });

  it('builds run-function batch invocation for zero-arg function file', () => {
    const functionPath = path.join(tempRoot, 'entry_point.m');
    fs.writeFileSync(functionPath, 'function entry_point\nend\n');

    const result = runBridge(['run-function', functionPath], {
      CTI_MATLAB_BIN: '/bin/echo',
      CTI_MATLAB_ALLOWED_ROOTS: tempRoot,
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /-batch cd\('.*'\); feval\('entry_point'\);/);
  });

  it('builds run-test batch invocation for allowed test target', () => {
    const testPath = path.join(tempRoot, 'tests', 'sampleTest.m');
    fs.mkdirSync(path.dirname(testPath), { recursive: true });
    fs.writeFileSync(testPath, 'function tests = sampleTest\n tests = functiontests(localfunctions);\nend\n');

    const result = runBridge(['run-test', testPath], {
      CTI_MATLAB_BIN: '/bin/echo',
      CTI_MATLAB_ALLOWED_ROOTS: tempRoot,
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /runtests\('.*sampleTest\.m'\);/);
    assert.match(result.stdout, /assert\(failures == 0, 'MATLAB tests failed'\);/);
  });

  it('rejects targets outside allowed roots', () => {
    const outsidePath = path.join(os.tmpdir(), 'outside_script.m');
    fs.writeFileSync(outsidePath, "disp('outside');\n");

    const result = runBridge(['run-script', outsidePath], {
      CTI_MATLAB_BIN: '/bin/echo',
      CTI_MATLAB_ALLOWED_ROOTS: tempRoot,
    });

    assert.equal(result.status, 2);
    assert.match(result.stderr, /outside allowed roots/);

    fs.rmSync(outsidePath, { force: true });
  });

  it('rejects non-identifier function file names', () => {
    const functionPath = path.join(tempRoot, '123bad.m');
    fs.writeFileSync(functionPath, 'function x = bad\n x = 1;\nend\n');

    const result = runBridge(['run-function', functionPath], {
      CTI_MATLAB_BIN: '/bin/echo',
      CTI_MATLAB_ALLOWED_ROOTS: tempRoot,
    });

    assert.equal(result.status, 2);
    assert.match(result.stderr, /not a simple MATLAB identifier/);
  });
});
