import AsyncStorage from '@react-native-async-storage/async-storage';

import { createSuppressionJournal } from './suppressionJournal';

/** The app-wide journal of half-finished suppressions. */
export const suppressionJournal = createSuppressionJournal(AsyncStorage);
