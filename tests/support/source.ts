/// <reference types="node" />

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

/** Where each responsibility of the former single App.tsx now lives. */
export const OWNER = {
  root: 'App.tsx',
  app: 'src/app/AlarmApp.tsx',
  controller: 'src/app/useAlarmController.ts',
  lifecycle: 'src/app/useAlarmLifecycle.ts',
  schedule: 'src/app/useScheduleCoordination.ts',
  mutations: 'src/app/useAlarmMutations.ts',
  ringingActions: 'src/app/useRingingActions.ts',
  ringingPresentation: 'src/app/useRingingPresentation.ts',
  suppression: 'src/app/useSuppressionResponses.ts',
  notificationEvents: 'src/app/useNotificationEvents.ts',
  stepCandidate: 'src/app/useStepCandidate.ts',
  deletion: 'src/app/useLocalDataDeletion.ts',
  composerForm: 'src/app/useComposerForm.ts',
  bedside: 'src/app/useBedsideAwake.ts',
  deviceText: 'src/app/useDeviceText.ts',
  gateways: 'src/app/platform/gateways.ts',
  alarmServices: 'src/app/platform/alarmServices.ts',
  coordinators: 'src/app/platform/coordinators.ts',
  accessibilityEdge: 'src/app/platform/accessibilityEdge.ts',
  refill: 'src/app/core/refillCoordinator.ts',
  queueReconciler: 'src/app/core/queueReconciler.ts',
  suppressionReconciler: 'src/app/core/suppressionReconciler.ts',
  homeView: 'src/app/core/homeView.ts',
  home: 'src/ui/screens/HomeScreen.tsx',
  header: 'src/ui/screens/HomeHeader.tsx',
  list: 'src/ui/screens/AlarmListPanel.tsx',
  ringingCard: 'src/ui/screens/RingingCard.tsx',
  snoozedCard: 'src/ui/screens/SnoozedCard.tsx',
  missedCard: 'src/ui/screens/MissedCard.tsx',
  loadFailedCard: 'src/ui/screens/LoadFailedCard.tsx',
  deliveryCard: 'src/ui/screens/DeliveryWarningCard.tsx',
  nextCard: 'src/ui/screens/NextAlarmCard.tsx',
  skipButton: 'src/ui/screens/SkipButton.tsx',
  settingsSheet: 'src/ui/screens/SettingsSheet.tsx',
  footer: 'src/ui/screens/BedsideFooter.tsx',
} as const;

export function read(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

/**
 * The text between two anchors inside ONE named module. Both anchors must
 * exist there, so a rename or a move fails loudly instead of matching
 * somewhere else.
 */
export function blockIn(path: string, start: string, end: string): string {
  const source = read(path);
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `${path}: missing ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `${path}: missing ${end} after ${start}`);
  return source.slice(from, to);
}

/** Every .ts/.tsx file below a directory (relative paths). */
export function sourcesUnder(directory: string): string[] {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap(
    (entry) => {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        return sourcesUnder(path);
      }
      return /\.tsx?$/.test(entry.name) ? [path] : [];
    },
  );
}

/** Occurrences of a pattern in one module. */
export function countIn(path: string, pattern: RegExp): number {
  return read(path).match(pattern)?.length ?? 0;
}
