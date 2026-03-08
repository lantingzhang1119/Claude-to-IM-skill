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

  it('builds run-suite invocation and artifact writes', () => {
    const testPath = path.join(tempRoot, 'suite', 'sampleSuite.m');
    const artifactDir = path.join(tempRoot, 'suite_artifacts');
    fs.mkdirSync(path.dirname(testPath), { recursive: true });
    fs.writeFileSync(testPath, 'function tests = sampleSuite\n tests = functiontests(localfunctions);\nend\n');

    const result = runBridge(['run-suite', testPath, artifactDir], {
      CTI_MATLAB_BIN: '/bin/echo',
      CTI_MATLAB_ALLOWED_ROOTS: tempRoot,
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /jsonencode\(summary\)/);
    assert.match(result.stdout, /matlab_suite_summary\.json/);
    assert.match(result.stdout, /matlab_suite_results\.txt/);
    assert.match(result.stdout, /assert\(failed == 0 && incomplete == 0, 'MATLAB suite failed'\);/);
  });

  it('collects recent artifacts under allowed roots', () => {
    const artifactDir = path.join(tempRoot, 'artifacts');
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(path.join(artifactDir, 'result.json'), '{"ok":true}\n');
    fs.writeFileSync(path.join(artifactDir, 'figure.png'), 'pngdata');

    const result = runBridge(['collect-artifacts', artifactDir], {
      CTI_MATLAB_BIN: '/bin/echo',
      CTI_MATLAB_ALLOWED_ROOTS: tempRoot,
      CTI_MATLAB_ARTIFACT_LIMIT: '10',
    });

    assert.equal(result.status, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.count, 2);
    assert.equal(parsed.root, fs.realpathSync(artifactDir));
    assert.equal(parsed.artifacts[0].path.includes(fs.realpathSync(artifactDir)), true);
  });

  it('saves bridge command output to a log file', () => {
    const logPath = path.join(tempRoot, 'logs', 'bridge.log');

    const result = runBridge(['save-log', logPath, '--', 'which'], {
      CTI_MATLAB_BIN: '/bin/echo',
      CTI_MATLAB_ALLOWED_ROOTS: tempRoot,
    });

    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), '/bin/echo');
    assert.equal(fs.readFileSync(logPath, 'utf-8').trim(), '/bin/echo');
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

  it('rejects log files outside allowed roots', () => {
    const outsideLog = path.join(os.tmpdir(), 'cti-outside.log');

    const result = runBridge(['save-log', outsideLog, '--', 'which'], {
      CTI_MATLAB_BIN: '/bin/echo',
      CTI_MATLAB_ALLOWED_ROOTS: tempRoot,
    });

    assert.equal(result.status, 2);
    assert.match(result.stderr, /outside allowed roots/);
  });
});
