export function renderClipboardRow({ button, status, inputs }, state) {
  button.disabled = !state.source || !!state.clipboardSending;
  status.textContent = state.clipboardStatus || "";
  for (const input of inputs) input.checked = state.clipboardMachines.includes(input.dataset.machine);
}
