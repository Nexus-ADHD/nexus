import * as Updates from 'expo-updates';
import { isPlaudImportAvailable } from './access';

const isDev = typeof __DEV__ !== 'undefined' && __DEV__;

export const PLAUD_IMPORT_AVAILABLE = isPlaudImportAvailable({
  isDev,
  updateChannel: Updates.channel,
});
