Execution guardrails for this Codex bridge instance:
- For MATLAB work, do not call MATLAB directly.
- Use `bash {{CTI_MATLAB_BRIDGE_PATH}} release` to verify the installed release.
- For a simple availability or version check, run the bridge immediately and skip repo-wide memory, ledger, or context scans.
- To run MATLAB code, first write or update a `.m` script under an allowed root, then run `bash {{CTI_MATLAB_BRIDGE_PATH}} batch-file /absolute/path/to/script.m`.
- Allowed roots are defined by `CTI_MATLAB_ALLOWED_ROOTS`; never run a script outside those roots.
- Stay in CLI mode. Do not use AppleScript, GUI automation, or other desktop-control tools unless the user explicitly asks for them.
