// One offline reference, shared by Settings and Quick Start.
//
// The modifier shown follows the platform: ⌘ is macOS's; Windows and Linux
// read Ctrl for the same actions, because that is what the app binds through
// Electron's CommandOrControl.
const IS_MAC = typeof process !== 'undefined' && process.platform === 'darwin';

export const OPEN_OUTPUT_COPY = (IS_MAC
  ? 'Hold Command (⌘) and click a link or file path in a session. Web links open in your browser. Files open here in KingAgent.'
  : 'Hold Ctrl and click a link or file path in a session. Web links open in your browser. Files open here in KingAgent.');

export const SHORTCUT_GROUPS = [
  {
    icon: 'link', title: 'Links & files',
    rows: [
      ['Open a web link', ['⌘', 'click'], 'In session output · opens your browser'],
      ['Open a file in KingAgent', ['⌘', 'click'], 'In session output · opens the file here'],
      ...(IS_MAC
        ? [['Reveal a file in Finder', ['⌥', '⌘', 'click']], ['Reveal a folder in Finder', ['⌘', 'click']]]
        : [['Reveal a file in File Explorer', ['Alt', 'Ctrl', 'click']], ['Reveal a folder in File Explorer', ['Ctrl', 'click']]]),
      ['Open link actions', ['Right-click'], 'Open, copy, or reveal — depending on the link'],
    ],
    note: 'Reading a document? Links in Read mode open with a normal click.',
  },
  {
    icon: 'keyboard', title: 'Everyday shortcuts',
    rows: [
      ['New session', ['⌘', 'N']],
      ['Open the agent picker', ['⌘', 'K']],
      ['Open a folder', ['⌘', 'O']],
      ['New window', ['⇧', '⌘', 'N']],
      ['Open Settings', ['⌘', ',']],
      ['Save the active file', ['⌘', 'S']],
      ['Close the active pane', ['⌘', 'W']],
      ['Dismiss a dialog or leave an expanded pane', ['Esc']],
    ],
  },
  {
    icon: 'desk', title: 'Arrange your desk',
    rows: [
      ['Reorder a pane', ['Drag header']],
      ['Resize a pane', ['Drag handle']],
      ['Reset a pane’s size', ['Double-click handle']],
      ['Rename a session', ['Double-click title']],
    ],
  },
  {
    icon: 'file', title: 'In the workspace',
    rows: [
      ['Rename a selected file or folder', ['Return'], 'When the workspace list has focus'],
      ['Move a selected item to Trash', ['⌘', '⌫'], 'When the workspace list has focus'],
      ['Add selected file content to a session', ['⇧', '⌘', 'Return'], 'From the file’s selection toolbar'],
    ],
  },
];
