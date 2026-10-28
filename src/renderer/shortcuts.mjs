// One offline reference, shared by Settings and Quick Start.
//
// The modifier shown follows the platform: ⌘ is macOS's; Windows and Linux
// read Ctrl for the same actions, because that is what the app binds through
// Electron's CommandOrControl.
import { t } from './i18n.mjs';

const IS_MAC = typeof process !== 'undefined' && process.platform === 'darwin';

export const openOutputCopy = () => t(IS_MAC ? 'sc.openCopyMac' : 'sc.openCopy');

export const shortcutGroups = () => [
  {
    icon: 'link', title: t('sc.01'),
    rows: [
      [t('sc.02'), ['⌘', 'click'], t('sc.03')],
      [t('sc.04'), ['⌘', 'click'], t('sc.05')],
      ...(IS_MAC
        ? [[t('sc.06'), ['⌥', '⌘', 'click']], [t('sc.07'), ['⌘', 'click']]]
        : [[t('sc.08'), ['Alt', 'Ctrl', 'click']], [t('sc.09'), ['Ctrl', 'click']]]),
      [t('sc.10'), [t('sc.11')], t('sc.12')],
    ],
    note: t('sc.13'),
  },
  {
    icon: 'keyboard', title: t('sc.14'),
    rows: [
      [t('sc.15'), ['⌘', 'N']],
      [t('sc.16'), ['⌘', 'K']],
      [t('sc.17'), ['⌘', 'O']],
      [t('sc.18'), ['⇧', '⌘', 'N']],
      [t('sc.19'), ['⌘', ',']],
      [t('sc.20'), ['⌘', 'S']],
      [t('sc.21'), ['⌘', 'W']],
      [t('sc.22'), ['Esc']],
    ],
  },
  {
    icon: 'desk', title: t('sc.23'),
    rows: [
      [t('sc.24'), [t('sc.25')]],
      [t('sc.26'), [t('sc.27')]],
      [t('sc.28'), [t('sc.29')]],
      [t('sc.30'), [t('sc.31')]],
    ],
  },
  {
    icon: 'file', title: t('sc.32'),
    rows: [
      [t('sc.33'), ['Return'], t('sc.34')],
      [t('sc.35'), ['⌘', '⌫'], t('sc.36')],
      [t('sc.37'), ['⇧', '⌘', 'Return'], t('sc.38')],
    ],
  },
];
