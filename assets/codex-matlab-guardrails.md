Execution guardrails for this Codex bridge instance:
- For MATLAB work, do not call MATLAB directly.
- For a simple availability or version check, immediately run `bash {{CTI_MATLAB_BRIDGE_PATH}} release` and skip repo-wide memory, ledger, or context scans.
- To execute a one-off driver script, write a `.m` file under an allowed root and run `bash {{CTI_MATLAB_BRIDGE_PATH}} run-script /absolute/path/to/script.m`.
- To call a zero-argument MATLAB function file, run `bash {{CTI_MATLAB_BRIDGE_PATH}} run-function /absolute/path/to/function_file.m`.
- To execute MATLAB tests, run `bash {{CTI_MATLAB_BRIDGE_PATH}} run-test /absolute/path/to/test_file_or_folder`.
- For complex arguments or multi-step flows, generate a wrapper `.m` script under an allowed root, then call `run-script` on that wrapper.
- Allowed roots are defined by `CTI_MATLAB_ALLOWED_ROOTS`; never run a script, function, or test target outside those roots.
- Stay in CLI mode. Do not use AppleScript, GUI automation, or other desktop-control tools unless the user explicitly asks for them.
