import { inviteLink } from './link';

// "Invite friends" section at the top of the settings panel (F3, the
// Settings button on the login page, the gear button with touch controls),
// so every player finds it in game and on the login page. The link is shown
// in a read-only field, so it can always be copied by hand.

const COPIED_MS = 4_000;

let statusTimer: ReturnType<typeof setTimeout> | undefined;

/** Builds the section; the settings panel puts it above its own groups. */
export function createInviteSection(): HTMLElement {
  const section = document.createElement('section');
  section.className = 'settings-group invite';
  section.setAttribute('aria-labelledby', 'invite-title');

  const title = document.createElement('h2');
  title.id = 'invite-title';
  title.className = 'settings-group-title';
  title.textContent = 'Invite friends';

  const row = document.createElement('div');
  row.className = 'invite-row';
  const input = document.createElement('input');
  input.id = 'invite-link';
  input.className = 'field-input invite-link';
  input.type = 'text';
  input.readOnly = true;
  input.spellcheck = false;
  input.setAttribute('aria-label', 'Invite link');
  input.value = inviteLink(location.origin, location.pathname);
  input.addEventListener('focus', () => input.select());

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'action-button admin-secondary invite-copy';
  button.textContent = 'Copy invite link';

  const status = document.createElement('div');
  status.className = 'progress-status invite-status';
  status.setAttribute('role', 'status');

  const hint = document.createElement('p');
  hint.className = 'invite-hint';
  hint.textContent =
    'Opening the link loads the game and joins this server with the saved ' +
    'nickname, or asks for one first.';

  button.addEventListener('click', () => {
    void copyLink(input).then((copied) => {
      if (copied) showStatus(status, 'Copied.', true);
      else {
        showStatus(
          status,
          'Copy the selected link by hand (Ctrl+C, or long-press on a phone).',
          false
        );
      }
    });
  });

  row.append(input, button);
  section.append(title, row, status, hint);
  return section;
}

// "Copied." fades out after a few seconds; the manual-copy hint stays.
function showStatus(status: HTMLElement, text: string, clear: boolean): void {
  clearTimeout(statusTimer);
  status.textContent = text;
  if (!clear) return;
  statusTimer = setTimeout(() => {
    status.textContent = '';
  }, COPIED_MS);
}

// navigator.clipboard only exists in secure contexts (HTTPS, localhost); the
// server may be plain HTTP, so fall back to selecting the field and
// execCommand('copy'), which still works there during a click. If both fail
// the link stays selected for a manual copy.
async function copyLink(input: HTMLInputElement): Promise<boolean> {
  const link = input.value;
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(link);
      return true;
    } catch {
      // Denied (e.g. permissions policy): try the old way.
    }
  }
  input.focus();
  input.setSelectionRange(0, link.length);
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  }
}
