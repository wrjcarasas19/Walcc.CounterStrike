export type Phase = 'idle' | 'downloading' | 'loading' | 'ready' | 'error';

type Stage = 'download' | 'load';

const desktop = document.getElementById('desktop')!;
const form = document.getElementById('launcher') as HTMLFormElement;
const nicknameInput = document.getElementById(
  'nickname-input'
) as HTMLInputElement;
const actionButton = document.getElementById(
  'action-button'
) as HTMLButtonElement;

const stages: Record<
  Stage,
  { percent: HTMLElement; bar: HTMLElement; status: HTMLElement }
> = {
  download: {
    percent: document.getElementById('download-percent')!,
    bar: document.getElementById('download-bar')!,
    status: document.getElementById('download-status')!,
  },
  load: {
    percent: document.getElementById('load-percent')!,
    bar: document.getElementById('load-bar')!,
    status: document.getElementById('load-status')!,
  },
};

const ACTION_LABELS: Record<Phase, string> = {
  idle: 'Download',
  downloading: 'Downloading…',
  loading: 'Loading…',
  ready: 'Connect',
  error: 'Retry',
};

let phase: Phase = 'idle';

function nicknameEntered(): boolean {
  return nicknameInput.value.trim() !== '';
}

function refreshActionButton(): void {
  actionButton.textContent = ACTION_LABELS[phase];
  actionButton.disabled =
    phase === 'idle'
      ? !nicknameEntered()
      : phase === 'downloading' || phase === 'loading';
}

nicknameInput.addEventListener('input', refreshActionButton);

export function setPhase(next: Phase): void {
  phase = next;
  desktop.dataset.phase = next;
  nicknameInput.disabled = next !== 'idle';
  refreshActionButton();
}

export function getPhase(): Phase {
  return phase;
}

export function onAction(handler: () => void): void {
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!actionButton.disabled) handler();
  });
}

export function updateProgress(
  stage: Stage,
  fraction: number,
  status: string
): void {
  const label = `${Math.floor(Math.min(1, Math.max(0, fraction)) * 100)}%`;
  const { percent, bar, status: statusEl } = stages[stage];
  percent.textContent = label;
  bar.style.width = label;
  statusEl.textContent = status;
  statusEl.classList.remove('error');
}

export function showError(stage: Stage, message: string): void {
  const { status } = stages[stage];
  status.textContent = message;
  status.classList.add('error');
  setPhase('error');
}

export function removeDesktop(): void {
  desktop.remove();
}

refreshActionButton();
