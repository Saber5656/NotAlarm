import AsyncStorage from '@react-native-async-storage/async-storage';

import { assertNoPendingReset } from './storageResetGate';
import {
  SUPPRESSION_JOURNAL_KEY,
  createSuppressionJournal,
} from './suppressionJournal';

/**
 * The app-wide journal of half-finished suppressions. New records are refused
 * while a data deletion is unfinished, so the removed key is not rewritten.
 */
export const suppressionJournal = createSuppressionJournal(
  AsyncStorage,
  SUPPRESSION_JOURNAL_KEY,
  { beforeRecord: assertNoPendingReset },
);
